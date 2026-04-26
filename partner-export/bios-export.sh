#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Configuration ---
# Credentials are loaded from .env (not tracked in git).
# Copy .env.example to .env and fill in your values.
ENV_FILE="${SCRIPT_DIR}/.env"
ROOT_ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
elif [ -f "$ROOT_ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ROOT_ENV_FILE"
fi

API_BASE="${BIOS_API_BASE:-http://web.mars2.barrage.net:81}"
USERNAME="${BIOS_USERNAME:-}"
PASSWORD="${BIOS_PASSWORD:-}"

# .env may be created on Windows with CRLF; strip CR so WSL/bash
# does not pass malformed values to curl.
API_BASE="${API_BASE//$'\r'/}"
USERNAME="${USERNAME//$'\r'/}"
PASSWORD="${PASSWORD//$'\r'/}"

STATION_IDS=("OS1BIOS" "OS2BIOS" "SOLAXBIOS")
OUTPUT_DIR="$(pwd)/output"

# Column headers per station (semicolon-separated, station ID and timestamp prepended automatically)
declare -A HEADERS
HEADERS[OS1BIOS]="Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative"
HEADERS[OS2BIOS]="Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative"
HEADERS[SOLAXBIOS]="Grid.power.total;Grid.energy.toGrid.total;Grid.energy.fromGrid.total;BMS.energy.SOC;Inverter.Meter2.AC.power.total;Inverter.AC.EPS.power.R;Inverter.AC.EPS.power.S;Inverter.AC.EPS.power.T;Inverter.DC.Battery.power.total;Inverter.DC.PV.power.MPPT1;Inverter.DC.PV.power.MPPT2;Inverter.DC.PV.power.MPPT3;Inverter.DC.PV.power.MPPT4;Inverter.AC.power.total;Inverter.AC.energy.out.daily"

MONTHLY_HEADER="Effective AC Output Time (min);Total Effective AC Output Time (min);Inverter output (kWh);Exported energy (kWh);Imported energy (kWh)"

# --- Usage ---
usage() {
    cat <<EOF
Usage: $0 <command> [options]

Commands:
  fetch   --from "YYYY-MM-DD HH:MM:SS" --to "YYYY-MM-DD HH:MM:SS" [--station ID]
          Fetch measurements and produce per-station output files.
          --station can be OS1BIOS, OS2BIOS, or SOLAXBIOS.
          If omitted, all three stations are fetched.

  report  --month YYYY-MM [--station SOLAXBIOS]
          Generate the SOLAXBIOS monthly report.

Options:
  -o, --output-dir DIR   Output directory (default: ./output)
  -h, --help             Show this help

Examples:
  $0 fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00"
  $0 fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00" --station OS1BIOS
  $0 report --month 2026-03
EOF
    exit 0
}

# --- Helpers ---
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

get_token() {
    [[ -z "${USERNAME}" ]] && die "Set BIOS_USERNAME in .env"
    [[ -z "${PASSWORD}" ]] && die "Set BIOS_PASSWORD in .env"

    local response
    response=$(curl -sS --connect-timeout 30 --max-time 60 -X POST "${API_BASE}/Token" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "userName=${USERNAME}" \
        --data-urlencode "password=${PASSWORD}" \
        --data-urlencode "grant_type=password") || die "Token request failed"

    local token
    token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null) \
        || die "Failed to parse access_token from response: $response"
    echo "$token"
}

fetch_data() {
    local token="$1" station="$2" from_utc="$3" to_utc="$4"
    local url="${API_BASE}/api/public/CustomDataExport/BIOS/${station}"
    local request_url from_wire to_wire
    # Keep request format as plain datetime string (yyyy-MM-dd HH:mm:ss).
    # Only spaces are escaped for HTTP transport.
    from_wire="${from_utc// /%20}"
    to_wire="${to_utc// /%20}"
    request_url="${url}?fromUTC=${from_wire}&toUTC=${to_wire}"

    log "GET ${url}?fromUTC=${from_utc}&toUTC=${to_utc}"

    curl -sS --connect-timeout 30 --max-time 120 \
        -H "Authorization: Bearer ${token}" \
        "${request_url}"
}

# Parse the API response into semicolon-delimited lines:
#   STATION_ID;TIMESTAMP;val1;val2;...
# API format: "STATION_ID!ts;v1;v2<0x0a>ts;v1;v2<0x0a>..."
# Quoted string wraps the whole response.
parse_response() {
    local station="$1"
    python3 -c "
import sys

raw = sys.stdin.read().strip()
# Strip surrounding quotes
if raw.startswith('\"') and raw.endswith('\"'):
    raw = raw[1:-1]

# Split on '!' — first part is station ID, rest is data
parts = raw.split('!', 1)
if len(parts) < 2:
    sys.exit(0)

station_id = parts[0]
data_blob = parts[1]

# Records are separated by 0x0a (\\n in the decoded string)
# but the API encodes it literally as the bytes 0x0a at the end of each record
# Looking at the example: records end with '0xa' then next timestamp
# Actually the separator is the literal string '0xa'
# Let's handle both: real newlines and literal '0xa'
import re
records = re.split(r'0xa|\n', data_blob)

for rec in records:
    rec = rec.strip()
    if not rec:
        continue
    print(f'{station_id};{rec}')
"
}

# --- Commands ---
cmd_fetch() {
    local from_utc="" to_utc="" stations=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --from)     from_utc="$2"; shift 2 ;;
            --to)       to_utc="$2"; shift 2 ;;
            --station)  stations+=("$2"); shift 2 ;;
            -o|--output-dir) OUTPUT_DIR="$2"; shift 2 ;;
            *) die "Unknown option: $1" ;;
        esac
    done

    [[ -z "$from_utc" ]] && die "--from is required"
    [[ -z "$to_utc" ]]   && die "--to is required"
    [[ ${#stations[@]} -eq 0 ]] && stations=("${STATION_IDS[@]}")

    mkdir -p "$OUTPUT_DIR"

    log "Authenticating..."
    local token
    token=$(get_token)
    log "Token acquired."

    for sid in "${stations[@]}"; do
        log "Fetching ${sid} from=${from_utc} to=${to_utc} ..."
        local outfile="${OUTPUT_DIR}/${sid,,}-measurements.txt"
        local header_line="${sid};TIMESTAMP;${HEADERS[$sid]}"

        # Write header
        echo "$header_line" > "$outfile"

        local raw
        raw=$(fetch_data "$token" "$sid" "$from_utc" "$to_utc")

        if [[ -z "$raw" || "$raw" == '""' ]]; then
            log "WARNING: No data returned for ${sid}."
            continue
        fi

        echo "$raw" | parse_response "$sid" >> "$outfile"
        local count
        count=$(wc -l < "$outfile")
        log "${sid}: $((count - 1)) data rows written to ${outfile}"
    done

    log "Done. Output in ${OUTPUT_DIR}/"
}

cmd_report() {
    local month="" station="SOLAXBIOS"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --month)    month="$2"; shift 2 ;;
            --station)  station="$2"; shift 2 ;;
            -o|--output-dir) OUTPUT_DIR="$2"; shift 2 ;;
            *) die "Unknown option: $1" ;;
        esac
    done

    [[ -z "$month" ]] && die "--month YYYY-MM is required"
    [[ "$station" != "SOLAXBIOS" ]] && die "Monthly report is only supported for SOLAXBIOS"

    # Validate month format
    [[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]] || die "Month must be YYYY-MM format"

    local year="${month%-*}"
    local mon="${month#*-}"

    mkdir -p "$OUTPUT_DIR"

    log "Authenticating..."
    local token
    token=$(get_token)
    log "Token acquired."

    # Determine first and last day of month
    local first_day="${year}-${mon}-01"
    local next_month_ts
    if [[ "$mon" == "12" ]]; then
        next_month_ts="$((year + 1))-01-01"
    else
        next_month_ts="${year}-$(printf '%02d' $((10#$mon + 1)))-01"
    fi
    local last_day
    last_day=$(date -d "${next_month_ts} - 1 day" '+%Y-%m-%d' 2>/dev/null) \
        || last_day=$(date -d "${next_month_ts} -1 day" '+%Y-%m-%d')

    local from_utc="${first_day} 00:00:00"
    local to_utc="${next_month_ts} 00:00:00"

    log "Fetching ${station} for month ${month} (${from_utc} to ${to_utc}) ..."
    local raw
    raw=$(fetch_data "$token" "$station" "$from_utc" "$to_utc")

    if [[ -z "$raw" || "$raw" == '""' ]]; then
        die "No data returned for ${station} in ${month}."
    fi

    local outfile="${OUTPUT_DIR}/${station,,}-monthly-report.txt"

    # Generate the monthly report using Python for date math and aggregation.
    # Report columns:
    #   SOLAXBIOS;UNIX_TIMESTAMP_AT_00:00:00_FOR_EACH_DAY;
    #   Effective AC Output Time (min) — minutes in day where Inverter.AC.power.total > 0
    #   Total Effective AC Output Time (min) — cumulative from start of month
    #   Inverter output (kWh) — last Inverter.AC.energy.out.daily of the day
    #   Exported energy (kWh) — delta of Grid.energy.toGrid.total across the day
    #   Imported energy (kWh) — delta of Grid.energy.fromGrid.total across the day
    echo "$raw" | python3 -c "
import sys, re
from datetime import datetime, timezone, timedelta
from collections import defaultdict

raw = sys.stdin.read().strip()
if raw.startswith('\"') and raw.endswith('\"'):
    raw = raw[1:-1]

parts = raw.split('!', 1)
if len(parts) < 2:
    print('No data', file=sys.stderr)
    sys.exit(1)

station_id = parts[0]
data_blob = parts[1]
records = re.split(r'0xa|\n', data_blob)

# Column indices in SOLAXBIOS response (0-based after timestamp):
#  0: Grid.power.total
#  1: Grid.energy.toGrid.total
#  2: Grid.energy.fromGrid.total
#  3: BMS.energy.SOC
#  4: Inverter.Meter2.AC.power.total
#  5: Inverter.AC.EPS.power.R
#  6: Inverter.AC.EPS.power.S
#  7: Inverter.AC.EPS.power.T
#  8: Inverter.DC.Battery.power.total
#  9: Inverter.DC.PV.power.MPPT1
# 10: Inverter.DC.PV.power.MPPT2
# 11: Inverter.DC.PV.power.MPPT3
# 12: Inverter.DC.PV.power.MPPT4
# 13: Inverter.AC.power.total
# 14: Inverter.AC.energy.out.daily

IDX_TO_GRID   = 1
IDX_FROM_GRID = 2
IDX_AC_POWER  = 13
IDX_AC_ENERGY = 14

def parse_val(s):
    s = s.strip()
    if not s:
        return None
    try:
        return float(s.replace(',', '.'))
    except ValueError:
        return None

# Group records by calendar day (UTC)
days = defaultdict(list)
for rec in records:
    rec = rec.strip()
    if not rec:
        continue
    fields = rec.split(';')
    if len(fields) < 2:
        continue
    try:
        ts = int(fields[0])
    except ValueError:
        continue
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    day_key = dt.strftime('%Y-%m-%d')
    days[day_key].append((ts, fields[1:]))

header = f'{station_id};TIMESTAMP;Effective AC Output Time (min);Total Effective AC Output Time (min);Inverter output (kWh);Exported energy (kWh);Imported energy (kWh)'
print(header)

cumulative_ac_minutes = 0

for day_str in sorted(days.keys()):
    entries = sorted(days[day_str], key=lambda x: x[0])

    # Timestamp at 00:00:00 for this day
    day_dt = datetime.strptime(day_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    day_ts = int(day_dt.timestamp())

    # Effective AC Output Time: count sample intervals where AC power > 0
    # Samples are ~5 min apart (300s); count intervals between consecutive
    # timestamps where AC power > 0
    ac_minutes = 0
    prev_ts = None
    for ts, vals in entries:
        ac_power = parse_val(vals[IDX_AC_POWER]) if len(vals) > IDX_AC_POWER else None
        if ac_power is not None and ac_power > 0:
            if prev_ts is not None:
                delta_min = (ts - prev_ts) / 60.0
                if delta_min <= 10:
                    ac_minutes += delta_min
            prev_ts = ts
        else:
            prev_ts = None

    ac_minutes = round(ac_minutes, 1)
    cumulative_ac_minutes += ac_minutes
    cumulative_rounded = round(cumulative_ac_minutes, 1)

    # Inverter output: last non-empty Inverter.AC.energy.out.daily of the day
    inverter_output = ''
    for ts, vals in reversed(entries):
        v = parse_val(vals[IDX_AC_ENERGY]) if len(vals) > IDX_AC_ENERGY else None
        if v is not None:
            inverter_output = str(v).replace('.', ',')
            break

    # Exported energy: delta of Grid.energy.toGrid.total (last - first non-empty)
    exported = ''
    first_to_grid = None
    last_to_grid = None
    for ts, vals in entries:
        v = parse_val(vals[IDX_TO_GRID]) if len(vals) > IDX_TO_GRID else None
        if v is not None:
            if first_to_grid is None:
                first_to_grid = v
            last_to_grid = v
    if first_to_grid is not None and last_to_grid is not None:
        exported = str(round(last_to_grid - first_to_grid, 2)).replace('.', ',')

    # Imported energy: delta of Grid.energy.fromGrid.total (last - first non-empty)
    imported = ''
    first_from_grid = None
    last_from_grid = None
    for ts, vals in entries:
        v = parse_val(vals[IDX_FROM_GRID]) if len(vals) > IDX_FROM_GRID else None
        if v is not None:
            if first_from_grid is None:
                first_from_grid = v
            last_from_grid = v
    if first_from_grid is not None and last_from_grid is not None:
        imported = str(round(last_from_grid - first_from_grid, 2)).replace('.', ',')

    ac_min_str = str(ac_minutes).replace('.', ',')
    cum_str = str(cumulative_rounded).replace('.', ',')

    print(f'{station_id};{day_ts};{ac_min_str};{cum_str};{inverter_output};{exported};{imported}')
" > "$outfile"

    local count
    count=$(wc -l < "$outfile")
    log "Monthly report: $((count - 1)) day rows written to ${outfile}"
    log "Done."
}

# --- Main ---
[[ $# -eq 0 ]] && usage

COMMAND="$1"
shift

case "$COMMAND" in
    fetch)   cmd_fetch "$@" ;;
    report)  cmd_report "$@" ;;
    -h|--help) usage ;;
    *) die "Unknown command: $COMMAND. Use 'fetch' or 'report'." ;;
esac
