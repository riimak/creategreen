#!/usr/bin/env bash
# test-api.sh -- probe all Mars2 REST API v1.3.0 endpoints
#
# Usage: bash test-api.sh
# Requires: curl, .env with BIOS_USERNAME and BIOS_PASSWORD

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -f "$ENV_FILE" ]; then . "$ENV_FILE"; fi

API="${BIOS_API_BASE:-http://web.mars2.barrage.net:81}"
USER="${BIOS_USERNAME:?Set BIOS_USERNAME in .env}"
PASS="${BIOS_PASSWORD:?Set BIOS_PASSWORD in .env}"

OK=0; FAIL=0; TOTAL=0

# ── colours ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
    G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; X='\033[0m'
else
    G=''; R=''; Y=''; C=''; X=''
fi

# ── auth ─────────────────────────────────────────────────────────────
printf "${C}Authenticating...${X}\n"
TOKEN_RESPONSE=$(curl -sS --connect-timeout 10 --max-time 20 -X POST "${API}/Token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "userName=${USER}" \
    --data-urlencode "password=${PASS}" \
    --data-urlencode "grant_type=password" 2>&1)

TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)
if [ -z "$TOKEN" ]; then
    printf "${R}FATAL: could not authenticate${X}\n"
    echo "$TOKEN_RESPONSE"
    exit 1
fi
printf "${G}Token acquired${X} (%d chars)\n\n" "${#TOKEN}"

# ── probe ────────────────────────────────────────────────────────────
probe() {
    local path="$1"
    local label="${2:-$path}"
    TOTAL=$((TOTAL + 1))

    local http_code body
    body=$(curl -sS --connect-timeout 10 --max-time 20 \
        -H "Authorization: Bearer ${TOKEN}" \
        -o /dev/null -w "%{http_code}" \
        "${API}${path}" 2>&1)
    http_code="$body"

    if [ "$http_code" = "200" ]; then
        OK=$((OK + 1))
        printf "${G}%3s${X}  %-65s  %s\n" "$http_code" "$path" "$label"
    elif [ "$http_code" = "404" ]; then
        FAIL=$((FAIL + 1))
        printf "${R}%3s${X}  %-65s  %s\n" "$http_code" "$path" "$label"
    else
        FAIL=$((FAIL + 1))
        printf "${Y}%3s${X}  %-65s  %s\n" "$http_code" "$path" "$label"
    fi
}

printf "%-5s  %-65s  %s\n" "CODE" "ENDPOINT" "DESCRIPTION"
printf "%s\n" "$(printf '%.0s-' {1..100})"

# ── Authentication ───────────────────────────────────────────────────
printf "\n${C}── Authentication ──${X}\n"
probe "/Token" "Token endpoint (tested via POST above)"

# ── MeasurementPlaces (required: includeMetadata, includeChildren, includeDevice) ─
printf "\n${C}── MeasurementPlaces ──${X}\n"
probe "/api/public/MeasurementPlaces?includeMetadata=false&includeChildren=false&includeDevice=false" "List all (with required params)"
probe "/api/public/MeasurementPlaces?includeMetadata=true&includeChildren=true&includeDevice=true" "List all (include everything)"
probe "/api/public/MeasurementPlaces/1?includeMetadata=false&includeChildren=false&includeDevice=false" "Get place nodeId=1"

# ── MeasurementPoints (required: includeMetadata, includeChildren, includeDevice) ─
printf "\n${C}── MeasurementPoints ──${X}\n"
probe "/api/public/MeasurementPoints?includeMetadata=false&includeChildren=false&includeDevice=false" "List all (with required params)"
probe "/api/public/MeasurementPoints?includeMetadata=true&includeChildren=true&includeDevice=true" "List all (include everything)"
probe "/api/public/MeasurementPoints/1?includeMetadata=false&includeChildren=false&includeDevice=false" "Get point nodeId=1"
probe "/api/public/MeasurementPoints/1/Variables?includeMetadata=false" "Variables for point 1"

# ── Variables (required: includeMetadata; data requires from/to) ─────
printf "\n${C}── Variables ──${X}\n"
probe "/api/public/Variables/1?includeMetadata=false" "Get variable nodeId=1"
probe "/api/public/Variables/1/data?from=2026-03-24T00:00:00Z&to=2026-03-24T01:00:00Z" "Variable data (from/to)"
probe "/api/public/Variables/1/data/last" "Last value for variable 1"

# ── Alarms (required: from, to) ──────────────────────────────────────
printf "\n${C}── Alarms ──${X}\n"
probe "/api/public/Alarms?from=2026-03-01T00:00:00Z&to=2026-03-24T23:59:59Z" "List alarms (with from/to)"
probe "/api/public/Alarms/1" "Get alarm id=1"

# ── Devices (required: includeParameters, includeMetadata, includeCounters) ─
printf "\n${C}── Devices ──${X}\n"
probe "/api/public/Devices?includeParameters=false&includeMetadata=false&includeCounters=false" "List all (with required params)"
probe "/api/public/Devices?includeParameters=true&includeMetadata=true&includeCounters=true" "List all (include everything)"
probe "/api/public/Devices/1?includeParameters=false&includeMetadata=false&includeCounters=false" "Get device nodeId=1"
probe "/api/public/Devices/1/Counters?includeParameters=false&includeMetadata=false" "Counters for device 1"
probe "/api/public/Devices/1/Counters/1?includeParameters=false&includeMetadata=false" "Specific counter"

# ── RawDataInput (POST endpoint from spec) ───────────────────────────
printf "\n${C}── RawDataInput ──${X}\n"
probe "/api/public/postRawDataInput" "POST raw data input (GET probe)"

# ── CustomDataExport (BIOS-specific, not in API spec) ────────────────
printf "\n${C}── CustomDataExport (CREATEGREEN) ──${X}\n"
probe "/api/public/CustomDataExport/BIOS/OS1BIOS?fromUTC=2026-03-24%2000:00:00&toUTC=2026-03-24%2000:10:00" "OS1BIOS meteo"
probe "/api/public/CustomDataExport/BIOS/OS2BIOS?fromUTC=2026-03-24%2000:00:00&toUTC=2026-03-24%2000:10:00" "OS2BIOS meteo"
probe "/api/public/CustomDataExport/BIOS/SOLAXBIOS?fromUTC=2026-03-24%2000:00:00&toUTC=2026-03-24%2000:10:00" "SOLAXBIOS FNE"

# ── Summary ──────────────────────────────────────────────────────────
printf "\n%s\n" "$(printf '%.0s=' {1..100})"
printf "Total: %d    ${G}200 OK: %d${X}    ${R}Not working: %d${X}\n" "$TOTAL" "$OK" "$FAIL"
printf "%s\n" "$(printf '%.0s=' {1..100})"
