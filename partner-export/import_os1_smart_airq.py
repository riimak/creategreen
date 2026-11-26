#!/usr/bin/env python3
"""
Import Smart Sense hourly CSV for OS1 BIOS (b827eb232b14) into Mars2 Postgres.

Writes the same three tables live readout populates:
  BIOSProdRawDB.dbo.RawNumericData
  BIOSProdM2DB.dbo.RawDatas
  BIOSProdM2DB.dbo.VariableDatas

Requires a Windows TCP proxy to Mars2 Postgres (partner-export/_pg_proxy.js on :15432)
because WSL cannot route to the VPN. Run via Docker psql COPY or this script's SQL batches
through docker exec... actually this script emits SQL and pipes to psql in docker.
"""
from __future__ import annotations

import argparse
import csv
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

# Counters.ID / MeasurementPointVariableID for device OS1 BIOS (Node 161)
# CSV metric -> (kind, counter_id, variable_id, scale)
METRIC_MAP = {
    "T": ("raw", 145, 103, 1.0),
    "RH": ("raw", 147, 104, 1.0),
    "Wind_speed": ("raw", 140, 92, 1.0),
    "Wind_direction": ("raw", 139, 100, 1.0),
    "Solar_radiation": ("raw", 175, 94, 1.0),
    "P": ("raw", 146, 96, 1000.0),  # CSV kPa -> Mars2 Pa
    "rain": ("raw", 142, 93, 1.0),
    "Sound_level": ("raw", 141, 101, 1.0),
    "CO": ("measured", 138, 91, 1e-6),
    "NO": ("measured", 148, 97, 1e-6),
    "NO2": ("measured", 149, 105, 1e-6),
    "O3": ("measured", 150, 98, 1e-6),
    "SO2": ("measured", 176, 99, 1e-6),
    "PM1": ("raw", 151, 106, 1e-6),
    "PM2.5": ("raw", 152, 107, 1e-6),
    "PM10": ("raw", 153, 108, 1e-6),
}

SOURCE = 1
SERIAL = "b827eb232b14"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", required=True)
    p.add_argument("--proxy-host", default=None, help="Windows host gateway IP for :15432")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--from", dest="from_ts", default=None, help="YYYY-MM-DD HH:MM:SS inclusive")
    p.add_argument("--to", dest="to_ts", default=None, help="YYYY-MM-DD HH:MM:SS inclusive")
    p.add_argument("--batch-hours", type=int, default=168, help="hours per SQL transaction")
    return p.parse_args()


def host_gw() -> str:
    out = subprocess.check_output(
        ["bash", "-lc", "ip route | awk '/default/ {print $3; exit}'"],
        text=True,
    ).strip()
    if not out:
        raise SystemExit("cannot resolve default gateway")
    return out


def load_rows(path: Path, from_ts: str | None, to_ts: str | None):
    # ts -> metric -> (kind, value)
    by_ts: dict[str, dict[str, tuple[str, float]]] = defaultdict(dict)
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) < 5:
                continue
            ts, serial, metric, kind, val = row[0], row[1], row[2], row[3], row[4]
            if serial != SERIAL:
                continue
            if metric not in METRIC_MAP:
                continue
            want_kind = METRIC_MAP[metric][0]
            if kind != want_kind:
                continue
            if from_ts and ts < from_ts:
                continue
            if to_ts and ts > to_ts:
                continue
            by_ts[ts][metric] = (kind, float(val))
    return dict(sorted(by_ts.items()))


def sql_escape(ts: str) -> str:
    return ts.replace("'", "''")


def build_batch_sql(hours: list[tuple[str, dict]]) -> tuple[str, str]:
    """Return (raw_db_sql, m2_db_sql)."""
    counter_ids = sorted({m[1] for m in METRIC_MAP.values()})
    variable_ids = sorted({m[2] for m in METRIC_MAP.values()})
    ts_list = [h[0] for h in hours]
    tmin, tmax = ts_list[0], ts_list[-1]

    raw_vals = []
    m2_raw_vals = []
    var_vals = []
    for ts, metrics in hours:
        ets = sql_escape(ts)
        for metric, (_kind, value) in metrics.items():
            _k, counter_id, variable_id, scale = METRIC_MAP[metric]
            v = value * scale
            raw_vals.append(f"('{ets}', NOW(), {v}, {SOURCE}, {counter_id})")
            m2_raw_vals.append(f"('{ets}', NOW(), {v}, {SOURCE}, false, {counter_id})")
            var_vals.append(f"('{ets}', NOW(), {v}, {SOURCE}, false, {variable_id})")

    cid_csv = ",".join(str(x) for x in counter_ids)
    vid_csv = ",".join(str(x) for x in variable_ids)

    raw_sql = f"""
BEGIN;
DELETE FROM dbo."RawNumericData"
 WHERE "CounterID" IN ({cid_csv})
   AND "Timestamp" >= '{sql_escape(tmin)}'
   AND "Timestamp" <= '{sql_escape(tmax)}';
INSERT INTO dbo."RawNumericData" ("Timestamp","ServerTimestamp","Value","Source","CounterID")
VALUES
{(",\n").join(raw_vals)};
COMMIT;
"""
    m2_sql = f"""
BEGIN;
DELETE FROM dbo."RawDatas"
 WHERE "CounterID" IN ({cid_csv})
   AND "Timestamp" >= '{sql_escape(tmin)}'
   AND "Timestamp" <= '{sql_escape(tmax)}';
DELETE FROM dbo."VariableDatas"
 WHERE "VariableID" IN ({vid_csv})
   AND "Timestamp" >= '{sql_escape(tmin)}'
   AND "Timestamp" <= '{sql_escape(tmax)}';
INSERT INTO dbo."RawDatas" ("Timestamp","ServerTimestamp","Value","Source","HasMetaData","CounterID")
VALUES
{(",\n").join(m2_raw_vals)};
INSERT INTO dbo."VariableDatas" ("Timestamp","ServerTimestamp","Value","Source","IsInterpolated","VariableID")
VALUES
{(",\n").join(var_vals)};
COMMIT;
"""
    return raw_sql, m2_sql


def run_psql(db: str, host: str, sql: str, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] {db} sql_chars={len(sql)}")
        return
    password = os.environ.get("MARS2_PGPASSWORD")
    if not password:
        raise SystemExit("Set MARS2_PGPASSWORD in the environment")
    cmd = [
        "docker", "run", "--rm", "-i",
        "-e", f"PGPASSWORD={password}",
        "-e", "PGSSLMODE=disable",
        "postgres:17-alpine",
        "psql", "-h", host, "-p", "15432", "-U", "postgres", "-d", db,
        "-v", "ON_ERROR_STOP=1",
    ]
    last_err = None
    for attempt in range(1, 5):
        proc = subprocess.run(cmd, input=sql, text=True, capture_output=True)
        if proc.returncode == 0:
            for line in (proc.stdout or "").splitlines():
                if line.startswith("DELETE") or line.startswith("INSERT") or line.startswith("COMMIT"):
                    print(db, line)
            return
        last_err = proc
        print(f"{db} attempt {attempt} failed: {(proc.stderr or '')[:300]}", file=sys.stderr)
        # brief backoff for flaky proxy/VPN
        subprocess.run(["sleep", str(2 * attempt)], check=False)
    print(last_err.stdout if last_err else "", file=sys.stderr)
    print(last_err.stderr if last_err else "", file=sys.stderr)
    raise SystemExit(f"psql {db} failed after retries")


def main() -> int:
    args = parse_args()
    host = args.proxy_host or host_gw()
    path = Path(args.csv)
    rows = load_rows(path, args.from_ts, args.to_ts)
    print(f"hours={len(rows)} metrics_mapped={len(METRIC_MAP)} proxy={host}:15432 dry_run={args.dry_run}")
    if not rows:
        print("no rows")
        return 1

    items = list(rows.items())
    batch = max(1, args.batch_hours)
    for i in range(0, len(items), batch):
        chunk = items[i : i + batch]
        print(f"batch {i // batch + 1}: {chunk[0][0]} .. {chunk[-1][0]} ({len(chunk)} hours)")
        raw_sql, m2_sql = build_batch_sql(chunk)
        run_psql("BIOSProdRawDB", host, raw_sql, args.dry_run)
        run_psql("BIOSProdM2DB", host, m2_sql, args.dry_run)
        subprocess.run(["sleep", "1"], check=False)
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
