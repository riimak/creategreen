#!/usr/bin/env bash
# bios-cron.sh -- daily cron wrapper for bios-export.sh
#
# Intended to run at 00:00 UTC via crontab.  Fetches the last 72 hours
# of measurements for every station in stations.conf and regenerates the
# current month's report for every solar-layout station (SOLAXBIOS,
# SOKO46, SOKOBAZEN, VETINST, ...).
#
# Each output file always contains the most recent 72 h window, as
# required by the CREATEGREEN data contract (dr. Secerov / PMF NS).
#
# Install (unprivileged, no root needed):
#   crontab -e
#   0 0 * * *  /path/to/bios-cron.sh >> ~/.local/log/bios-cron.log 2>&1
#
# Override defaults with environment variables:
#   BIOS_OUTPUT_DIR  -- where files are written (default: <script dir>/output)
#   BIOS_SCRIPT_DIR  -- where bios-export.sh lives (default: script dir)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPORT="${BIOS_SCRIPT_DIR:-$SCRIPT_DIR}/bios-export.sh"
OUTPUT_DIR="${BIOS_OUTPUT_DIR:-$SCRIPT_DIR/output}"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"; }

log "=== bios-cron start ==="

# ── 72-hour measurement window ──────────────────────────────────────
# "now" rounded to midnight UTC (the moment this cron fires)
TO=$(date -u '+%Y-%m-%d 00:00:00')
FROM=$(date -u -d '3 days ago' '+%Y-%m-%d 00:00:00' 2>/dev/null) \
    || FROM=$(date -u -v-3d '+%Y-%m-%d 00:00:00')

log "fetch window: $FROM -> $TO"

rc=0
bash "$EXPORT" fetch \
    --from "$FROM" \
    --to   "$TO" \
    -o     "$OUTPUT_DIR" || rc=$?
if [ "$rc" -eq 2 ]; then
    # Mars2 answered but had no rows for any station: files carry only headers.
    log "WARNING: fetch produced no measurements for any station (exit 2); continuing with the reports"
elif [ "$rc" -ne 0 ]; then
    log "ERROR: fetch failed with exit $rc"
    exit "$rc"
fi

# ── monthly report (current month), one per solar-layout station ─────
MONTH=$(date -u '+%Y-%m')
log "report month: $MONTH"

failed=0
while IFS=$'\t' read -r sid layout _; do
    [ "$layout" = "solar" ] || continue
    log "report station: $sid"
    bash "$EXPORT" report \
        --month   "$MONTH" \
        --station "$sid" \
        -o        "$OUTPUT_DIR" || { log "WARNING: report for $sid failed"; failed=$((failed + 1)); }
done < <(bash "$EXPORT" stations)

log "=== bios-cron done (report failures: $failed) ==="
[ "$failed" -eq 0 ]
