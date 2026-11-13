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

OUTPUT_DIR="$(pwd)/output"

# Column layouts (semicolon-separated; station ID and timestamp are prepended
# automatically). These two headers ARE the partner data contract.
declare -A LAYOUT_HEADERS
LAYOUT_HEADERS[meteo]="Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative"
LAYOUT_HEADERS[solar]="Grid.power.total;Grid.energy.toGrid.total;Grid.energy.fromGrid.total;BMS.energy.SOC;Inverter.Meter2.AC.power.total;Inverter.AC.EPS.power.R;Inverter.AC.EPS.power.S;Inverter.AC.EPS.power.T;Inverter.DC.Battery.power.total;Inverter.DC.PV.power.MPPT1;Inverter.DC.PV.power.MPPT2;Inverter.DC.PV.power.MPPT3;Inverter.DC.PV.power.MPPT4;Inverter.AC.power.total;Inverter.AC.energy.out.daily"

# Stations come from stations.conf ("ID|layout" per line) so adding a plant is
# a one-line change next to the specs, not an edit of this script.
STATIONS_FILE="${BIOS_STATIONS_FILE:-${SCRIPT_DIR}/stations.conf}"
STATION_IDS=()
declare -A HEADERS LAYOUTS

# Mars2 has been seen to read fromUTC/toUTC as Croatian local time, which
# shifts the rows it returns by the UTC offset (1-2 h). Every request is
# therefore widened by this many seconds on both sides and the rows are
# clipped to the window that was asked for, so a file holds exactly that
# window whichever way Mars2 reads the parameters.
WINDOW_SLACK=7200

load_stations() {
    if [[ ! -f "$STATIONS_FILE" ]]; then
        STATION_IDS=("OS1BIOS" "OS2BIOS" "SOLAXBIOS")
        LAYOUTS[OS1BIOS]=meteo; LAYOUTS[OS2BIOS]=meteo; LAYOUTS[SOLAXBIOS]=solar
    else
        local line id layout
        while IFS= read -r line || [[ -n "$line" ]]; do
            line="${line%%#*}"
            line="${line//$'\r'/}"
            line="${line#"${line%%[![:space:]]*}"}"
            line="${line%"${line##*[![:space:]]}"}"
            [[ -z "$line" ]] && continue
            id="${line%%|*}"
            layout="${line#*|}"
            [[ "$id" == "$line" ]] && die "${STATIONS_FILE}: line '${line}' must be ID|layout"
            [[ -z "${LAYOUT_HEADERS[$layout]:-}" ]] && die "${STATIONS_FILE}: unknown layout '${layout}' for ${id} (meteo|solar)"
            STATION_IDS+=("$id")
            LAYOUTS[$id]="$layout"
        done < "$STATIONS_FILE"
        [[ ${#STATION_IDS[@]} -eq 0 ]] && die "${STATIONS_FILE}: no stations defined"
    fi
    local sid
    for sid in "${STATION_IDS[@]}"; do
        HEADERS[$sid]="${LAYOUT_HEADERS[${LAYOUTS[$sid]}]}"
    done
}

require_station() {
    local sid="$1"
    [[ -n "${LAYOUTS[$sid]:-}" ]] || die "Unknown station '${sid}'. Known stations (${STATIONS_FILE}): ${STATION_IDS[*]}"
}

MONTHLY_HEADER="Effective AC Output Time (min);Total Effective AC Output Time (min);Inverter output (kWh);Exported energy (kWh);Imported energy (kWh)"

# --- Usage ---
usage() {
    cat <<EOF
Usage: $0 <command> [options]

Commands:
  fetch   --from "YYYY-MM-DD HH:MM:SS" --to "YYYY-MM-DD HH:MM:SS" [--station ID]...
          Fetch measurements (times in UTC) and produce per-station output
          files holding exactly that window.
          Without --station every station in stations.conf is fetched.
          Exit 2 when Mars2 returned no rows for any requested station.

  report  --month YYYY-MM [--station ID]
          Generate the monthly report for a solar-layout station
          (default: SOLAXBIOS; any station with layout "solar" in stations.conf).

  stations
          List the configured stations and their layouts (no network).

Options:
  -o, --output-dir DIR   Output directory (default: ./output)
  -h, --help             Show this help

Stations are read from ${STATIONS_FILE} (override with BIOS_STATIONS_FILE).

Examples:
  $0 fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00"
  $0 fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00" --station OS1BIOS
  $0 report --month 2026-03
  $0 report --month 2026-03 --station SOKO46
EOF
    exit 0
}

# --- Helpers ---
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

# "YYYY-MM-DD HH:MM:SS" (UTC) -> seconds since the epoch; fails on any other form.
utc_epoch() {
    local s="$1"
    [[ "$s" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || return 1
    date -u -d "$s" '+%s' 2>/dev/null
}

# seconds since the epoch -> "YYYY-MM-DD HH:MM:SS" (UTC)
utc_str() {
    date -u -d "@$1" '+%Y-%m-%d %H:%M:%S'
}

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

# GET CustomDataExport for [from, to] widened by WINDOW_SLACK on both sides.
fetch_data() {
    local token="$1" station="$2" from_epoch="$3" to_epoch="$4"
    local url="${API_BASE}/api/public/CustomDataExport/BIOS/${station}"
    local from_utc to_utc request_url
    from_utc=$(utc_str $((from_epoch - WINDOW_SLACK)))
    to_utc=$(utc_str $((to_epoch + WINDOW_SLACK)))
    # Keep request format as plain datetime string (yyyy-MM-dd HH:mm:ss).
    # Only spaces are escaped for HTTP transport.
    request_url="${url}?fromUTC=${from_utc// /%20}&toUTC=${to_utc// /%20}"

    log "GET ${url}?fromUTC=${from_utc}&toUTC=${to_utc} (window widened by $((WINDOW_SLACK / 3600)) h; rows are clipped to the window asked for)"

    curl -sS --connect-timeout 30 --max-time 120 \
        -H "Authorization: Bearer ${token}" \
        "${request_url}"
}

# --- Embedded Python ---------------------------------------------------------
# The two programs below are emitted by functions so that test_bios_export.sh
# runs the very same code:  ( . bios-export.sh; parse_py ) > parse.py

# Turn one CustomDataExport response into "STATION_ID;TIMESTAMP;v1;...;vN"
# lines. Wire format: one quoted string, "STATION_ID!ts;v1;...<0xa>ts;v1;..."
# where the record separator is the literal text 0xa (a real newline is
# accepted too). argv: [from_epoch] [to_epoch] - when given, rows whose
# timestamp is outside [from, to] are dropped.
parse_py() {
cat <<'PY'
import re
import sys

lo = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else None
hi = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None

raw = sys.stdin.read().strip()
if raw.startswith('"') and raw.endswith('"'):
    raw = raw[1:-1]

parts = raw.split('!', 1)
if len(parts) < 2:
    sys.exit(0)
station_id, data_blob = parts

for rec in re.split(r'0xa|\n', data_blob):
    rec = rec.strip()
    if not rec:
        continue
    if lo is not None or hi is not None:
        try:
            ts = int(rec.split(';', 1)[0])
        except ValueError:
            continue
        if (lo is not None and ts < lo) or (hi is not None and ts > hi):
            continue
    print(f'{station_id};{rec}')
PY
}

parse_response() {   # [from_epoch] [to_epoch]
    python3 -c "$(parse_py)" "${1:-}" "${2:-}"
}

# Monthly report from one CustomDataExport response in the solar layout.
# argv: [from_epoch] [to_epoch] - rows outside [from, to) are ignored, so the
# report holds exactly the requested month whatever window Mars2 answered.
# One row per UTC day, timestamp = that day at 00:00:00 UTC:
#   Effective AC Output Time (min)        minutes with Inverter.AC.power.total > 0,
#                                         counted between consecutive samples
#                                         at most 10 min apart
#   Total Effective AC Output Time (min)  running total since the first day
#   Inverter output (kWh)                 largest Inverter.AC.energy.out.daily of the day
#   Exported energy (kWh)                 increase of Grid.energy.toGrid.total over the day
#   Imported energy (kWh)                 increase of Grid.energy.fromGrid.total over the day
# Inverter output is the day's maximum, not its last value: the vendor
# plants' daily counter resets at local midnight, one hour (two in summer)
# before the UTC day ends, so the last sample of a UTC day is already the
# new day's zero. For SOLAXBIOS Mars2 writes a single daily value (about a
# day later), for which maximum and last are the same thing.
# The two energy columns are cumulative meter registers: the increase is
# summed between consecutive samples and a decrease (meter reset) is not
# counted, so a day with a reset does not come out negative.
# Numbers: minutes with one decimal, kWh with two, decimal comma; a column
# with no sample at all that day is left empty.
report_py() {
cat <<'PY'
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

lo = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else None
hi = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None

raw = sys.stdin.read().strip()
if raw.startswith('"') and raw.endswith('"'):
    raw = raw[1:-1]

parts = raw.split('!', 1)
if len(parts) < 2:
    print('No data', file=sys.stderr)
    sys.exit(1)
station_id, data_blob = parts

# 0-based value positions after the timestamp (solar layout)
IDX_TO_GRID = 1      # Grid.energy.toGrid.total
IDX_FROM_GRID = 2    # Grid.energy.fromGrid.total
IDX_AC_POWER = 13    # Inverter.AC.power.total
IDX_AC_ENERGY = 14   # Inverter.AC.energy.out.daily

def parse_val(s):
    s = s.strip()
    if not s:
        return None
    try:
        return float(s.replace(',', '.'))
    except ValueError:
        return None

def fmt(value, decimals):
    return f'{value:.{decimals}f}'.replace('.', ',')

def column(entries, idx):
    out = []
    for _, vals in entries:
        v = parse_val(vals[idx]) if len(vals) > idx else None
        if v is not None:
            out.append(v)
    return out

def increase(values):
    """Sum of the non-negative steps of a cumulative counter; '' when it had no sample."""
    if not values:
        return ''
    total = 0.0
    for prev, cur in zip(values, values[1:]):
        if cur >= prev:
            total += cur - prev
    return fmt(total, 2)

days = defaultdict(list)
for rec in re.split(r'0xa|\n', data_blob):
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
    if (lo is not None and ts < lo) or (hi is not None and ts >= hi):
        continue
    day = datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')
    days[day].append((ts, fields[1:]))

print(f'{station_id};TIMESTAMP;Effective AC Output Time (min);Total Effective AC Output Time (min);Inverter output (kWh);Exported energy (kWh);Imported energy (kWh)')

cumulative = 0.0
for day in sorted(days):
    entries = sorted(days[day], key=lambda e: e[0])
    day_ts = int(datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())

    minutes = 0.0
    prev_ts = None
    for ts, vals in entries:
        power = parse_val(vals[IDX_AC_POWER]) if len(vals) > IDX_AC_POWER else None
        if power is not None and power > 0:
            if prev_ts is not None and ts - prev_ts <= 600:
                minutes += (ts - prev_ts) / 60.0
            prev_ts = ts
        else:
            prev_ts = None
    # Round the day first so the running total is the sum of the printed day values.
    minutes = round(minutes, 1)
    cumulative = round(cumulative + minutes, 1)

    daily = column(entries, IDX_AC_ENERGY)
    inverter_output = fmt(max(daily), 2) if daily else ''
    exported = increase(column(entries, IDX_TO_GRID))
    imported = increase(column(entries, IDX_FROM_GRID))

    print(f'{station_id};{day_ts};{fmt(minutes, 1)};{fmt(cumulative, 1)};{inverter_output};{exported};{imported}')
PY
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
    local from_epoch to_epoch
    from_epoch=$(utc_epoch "$from_utc") || die "--from must be \"YYYY-MM-DD HH:MM:SS\" (UTC), got '${from_utc}'"
    to_epoch=$(utc_epoch "$to_utc")     || die "--to must be \"YYYY-MM-DD HH:MM:SS\" (UTC), got '${to_utc}'"
    (( to_epoch > from_epoch )) || die "--to must be later than --from"
    [[ ${#stations[@]} -eq 0 ]] && stations=("${STATION_IDS[@]}")
    local sid
    for sid in "${stations[@]}"; do require_station "$sid"; done

    mkdir -p "$OUTPUT_DIR"

    log "Authenticating..."
    local token
    token=$(get_token)
    log "Token acquired."

    local empty=()
    for sid in "${stations[@]}"; do
        log "Fetching ${sid} from=${from_utc} to=${to_utc} ..."
        local outfile="${OUTPUT_DIR}/${sid,,}-measurements.txt"
        local header_line="${sid};TIMESTAMP;${HEADERS[$sid]}"

        # Write header
        echo "$header_line" > "$outfile"

        local raw
        raw=$(fetch_data "$token" "$sid" "$from_epoch" "$to_epoch")

        if [[ -z "$raw" || "$raw" == '""' ]]; then
            log "WARNING: ${sid}: Mars2 returned no rows for ${from_utc} .. ${to_utc}; the file has only a header."
            empty+=("$sid")
            continue
        fi

        echo "$raw" | parse_response "$from_epoch" "$to_epoch" >> "$outfile"
        local count
        count=$(wc -l < "$outfile")
        if [[ $((count - 1)) -eq 0 ]]; then
            log "WARNING: ${sid}: response contained no records inside ${from_utc} .. ${to_utc}."
            empty+=("$sid")
        fi
        log "${sid}: $((count - 1)) data rows written to ${outfile}"
    done

    if [[ ${#empty[@]} -gt 0 ]]; then
        # A station that is silent for a whole window is a source problem, not a
        # transport problem: Mars2 answered, it just has nothing. OS1BIOS has
        # been like this since 2026-04-29. Say so loudly and let cron see it.
        log "WARNING: no measurements from Mars2 for: ${empty[*]} — check the station at the source (Mars2 admin: Upravljanje podacima)."
    fi
    log "Done. Output in ${OUTPUT_DIR}/"
    if [[ ${#empty[@]} -eq ${#stations[@]} ]]; then
        log "ERROR: every requested station was empty."
        exit 2
    fi
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
    require_station "$station"
    [[ "${LAYOUTS[$station]}" == "solar" ]] || die "Monthly report needs a solar-layout station; ${station} has layout '${LAYOUTS[$station]}'"

    # Validate month format
    [[ "$month" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || die "Month must be YYYY-MM format"

    local year="${month%-*}"
    local mon="${month#*-}"

    mkdir -p "$OUTPUT_DIR"

    log "Authenticating..."
    local token
    token=$(get_token)
    log "Token acquired."

    # [first day 00:00:00, first day of the next month 00:00:00) in UTC
    local first_day="${year}-${mon}-01"
    local next_month
    if [[ "$mon" == "12" ]]; then
        next_month="$((10#$year + 1))-01-01"
    else
        next_month="${year}-$(printf '%02d' $((10#$mon + 1)))-01"
    fi
    local from_epoch to_epoch
    from_epoch=$(utc_epoch "${first_day} 00:00:00")
    to_epoch=$(utc_epoch "${next_month} 00:00:00")

    log "Fetching ${station} for month ${month} (${first_day} 00:00:00 to ${next_month} 00:00:00 UTC) ..."
    local raw
    raw=$(fetch_data "$token" "$station" "$from_epoch" "$to_epoch")

    if [[ -z "$raw" || "$raw" == '""' ]]; then
        die "No data returned for ${station} in ${month}."
    fi

    local outfile="${OUTPUT_DIR}/${station,,}-monthly-report.txt"

    echo "$raw" | python3 -c "$(report_py)" "$from_epoch" "$to_epoch" > "$outfile"

    local count
    count=$(wc -l < "$outfile")
    [[ $((count - 1)) -gt 0 ]] || die "No rows inside ${month} for ${station}."
    log "Monthly report: $((count - 1)) day rows written to ${outfile}"
    log "Done."
}

cmd_stations() {
    local sid
    for sid in "${STATION_IDS[@]}"; do
        printf '%s\t%s\t%s\n' "$sid" "${LAYOUTS[$sid]}" "$(awk -F';' '{print NF}' <<< "${HEADERS[$sid]}") columns"
    done
}

# --- Main ---
# When sourced (the test suite does this in a subshell to reach the helpers
# and the embedded Python) stop here; run commands only when executed.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
    return 0
fi

[[ $# -eq 0 ]] && usage

COMMAND="$1"
shift

load_stations

case "$COMMAND" in
    fetch)    cmd_fetch "$@" ;;
    report)   cmd_report "$@" ;;
    stations) cmd_stations ;;
    -h|--help) usage ;;
    *) die "Unknown command: $COMMAND. Use 'fetch', 'report' or 'stations'." ;;
esac
