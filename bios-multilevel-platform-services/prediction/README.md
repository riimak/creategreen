# Predictive Analysis Service

Always-on REST service for short-term prediction, anomaly detection, data
quality and SLA overview over BIOS/SOLAX measurements.

## Endpoints

```sh
GET /health       # 200, or 503 once a cycle has outlived PREDICTION_CYCLE_DEADLINE_MINUTES
GET /freshness    # cycle state, PostgreSQL ping, newest measurement age per station
GET /status
GET /models
GET /forecasts
GET /forecasts/latest?source=OS1BIOS&metric=PM2_5
GET /forecast?source=OS1BIOS&metric=PM2_5&horizon=24
GET /anomalies
GET /data-quality
GET /data-quality/latest?source=OS1BIOS&metric=PM2_5
GET /sla
GET /sla?window=1h|24h|7d
GET /measurements?source=…&metric=…&hours=24|from=…&to=…&limit=…&sort=timestamp&sortDir=asc|desc
GET /measurements?…&bucket=1h            # server-side downsampling (see below)
GET /measurements?…&excludeMissing=true  # drop null/missing rows, so limit=1 is the newest usable sample
GET /measurements/meta
```

Forecast horizon is capped at 48 hours, matching the delivered technical
solution.

### Reading series from `raw_measurements`

`raw_measurements` is a tall table — one row per `(source, metric, ts)` — and
every series is interleaved with every other by arrival time. Its primary key
therefore carries the payload columns (`INCLUDE (value, is_missing)`) so a
series range read is an index-only scan: the 30-day read of one plant metric
that visited 6 919 heap pages and took 44 s on network storage now reads 148
index pages in 8 ms. Existing databases are migrated online (see the comment
in `database/schema.sql`); small databases migrate themselves at boot.

Do not pull raw rows to compute a summary. `bucket=<seconds|15m|1h|1d>`
returns one row per time bucket with `value` (average), `min`, `max`,
`first`, `last` and `count`, so a 30-day chart is 720 hourly rows, a monthly
total from a daily-resetting counter is the sum of 30 daily `max` values, and
a cumulative counter's delta is two `limit=1` probes (`sortDir=asc` / `desc`
with `excludeMissing=true`). The raw path is capped at 5 000 rows; asking for
8 640 rows oldest-first silently returns the wrong half of the window.

## Data Sources

The service reads current data from one of:

- `PREDICTION_DATA_API_BASE` -- existing Worker API, e.g. `/api/data`.
- `BIOS_OUTPUT_DIR` -- local semicolon export files, default `./output`.

Mars2/BIOS remains the source of truth. The service stores only forecast,
anomaly, data-quality and SLA artifacts, not raw measurement rows.

## Models

The first implementation intentionally stays small:

- linear regression
- seasonal hourly baseline
- holdout-based selection between available models

This is enough for a reproducible demonstrator and can be replaced by ARIMA,
Prophet, or neural models later without changing the API.

## Scheduling

Set `PREDICTION_INTERVAL_MINUTES` and `PREDICTION_TARGETS` to refresh forecasts,
anomalies and data-quality state in the background. By default the service uses
`PREDICTION_TARGETS=auto`, discovers every numeric field in the configured
stations, and processes all of them:

```sh
PREDICTION_INTERVAL_MINUTES=60
PREDICTION_TARGETS=auto
PREDICTION_STATIONS=OS1BIOS,OS2BIOS,SOLAXBIOS
```

Production lists only `OS2BIOS,SOLAXBIOS`: Mars2 has returned no rows for
`OS1BIOS` since April 2026, and a configured station with no data is a
permanent "no measurements" alert in Slack. Add it back in
`prediction/.gitlab/auto-deploy-values.yaml` when the station reports again.

The service runs one cycle on startup, then repeats on the configured interval.
Each cycle pulls every configured station from Mars2 once and reuses those rows
for all of that station's forecast and anomaly targets.

### Liveness and data-flow safety

Every wait inside a cycle is bounded: Mars2 calls time out after
`BIOS_API_TIMEOUT_MS` (default 30000) and PostgreSQL queries after
`PG_STATEMENT_TIMEOUT_MS` / `PG_QUERY_TIMEOUT_MS` (defaults 12000 / 15000). As a
backstop, a cycle that is still running after `PREDICTION_CYCLE_DEADLINE_MINUTES`
(default `max(30, 3 x interval)`) makes `GET /health` answer 503, so the
Kubernetes liveness probe restarts the container and scheduled cycles resume.
Skipped scheduled runs are logged with the age of the cycle that blocked them.

`GET /freshness` is what the dashboard's Slack monitor polls:

```json
{
  "ok": true,
  "running": false,
  "cycleHealth": { "ok": true, "cycleRunningMinutes": null, "deadlineMinutes": 30 },
  "lastCycle": { "status": "ready", "finishedAt": "...", "okTargets": 23, "totalTargets": 23 },
  "db": { "ok": true, "latencyMs": 3 },
  "sources": [ { "source": "OS2BIOS", "solar": false, "latestTs": "...", "ageMinutes": 7, "staleAfterMinutes": 30 } ]
}
```

### Database outages

With `DATABASE_URL` set the service never falls back to the JSON file store.
If the schema init fails (database down, in recovery, unreachable) it keeps
retrying with backoff (`PG_INIT_RETRY_SECONDS`, default 10, doubling up to
`PG_INIT_RETRY_MAX_SECONDS`, default 60) and meanwhile:

- `GET /health` stays 200 — the process is fine and a restart would not bring
  PostgreSQL back — but reports `storeReady: false`;
- `GET /freshness` reports `ok: false`, `db.ok: false`, `db.store: "postgres"`,
  `db.initialized: false`, the last connection error and the attempt count, so
  the dashboard's Slack monitor names the database as the cause;
- every store-backed route answers `503 {"error":"database unavailable"}`
  with `Retry-After: 30`;
- no prediction cycle runs until the store is ready; the first cycle after
  reconnecting re-pulls the full `PREDICTION_BACKFILL_HOURS` window from Mars2,
  so a gap shorter than that window refills itself.

The old fallback hid a 29-hour database outage in production: `/freshness`
kept saying `db.ok: true` (store `json`) and the in-memory store grew until the
pod was OOM-killed every 20–40 minutes.

## Missing Data And SLA

Missing or unrecorded values are treated as data-quality state, not as process
failures. Each cycle stores expected sample count, observed numeric samples,
missing ratio, latest timestamp and status:

- `ok`
- `partial`
- `stale`
- `insufficient_data`

SLA summaries are calculated from these artifacts with `SLA_TARGET_PERCENT`
(default `95`).

Forecast artifacts include `metricInfo`, with label, unit, domain and
description. This keeps the dashboard explicit about what is being forecast:
for example `PM2_5` is shown as fine particles PM2.5 in `ug/m3`, while
`Inverter_AC_power_total` is shown as inverter AC power in `kW`.

Data quality and SLA artifacts also include `inputSource`, so users can see
whether the service is checking live Mars2 REST API input or local
partner-export files.

Optional stale-data notifications can be sent to a generic webhook:

```sh
NOTIFICATIONS_ENABLED=true
NOTIFICATION_WEBHOOK_URL=https://example.invalid/webhook
NOTIFICATION_STALE_AFTER_MINUTES=60
NOTIFICATION_REPEAT_AFTER_MINUTES=240
```
