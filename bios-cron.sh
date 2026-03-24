#!/usr/bin/env bash
# bios-cron.sh -- daily cron wrapper for bios-export.sh
#
# Intended to run at 00:00 UTC via crontab.  Fetches the last 72 hours
# of measurements for all stations and regenerates the current month's
# SOLAXBIOS report.
#
# Each output file always contains the most recent 72 h window, as
# required by the CREATEGREEN data contract (dr. Secerov / PMF NS).
#
# Install (unprivileged, no root needed):
#   crontab -e
#   0 0 * * *  /path/to/bios-cron.sh >> ~/.local/log/bios-cron.log 2>&1
#
# Override defaults with environment variables:
#   BIOS_OUTPUT_DIR  -- where files are written (default: ./output)
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

bash "$EXPORT" fetch \
    --from "$FROM" \
    --to   "$TO" \
    -o     "$OUTPUT_DIR"

# ── monthly report (current month) ──────────────────────────────────
MONTH=$(date -u '+%Y-%m')
log "report month: $MONTH"

bash "$EXPORT" report \
    --month "$MONTH" \
    -o      "$OUTPUT_DIR"

log "=== bios-cron done ==="
