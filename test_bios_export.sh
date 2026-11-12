#!/usr/bin/env bash
# test_bios_export.sh — test suite for bios-export.sh
#
# Validates the parsing, output format, field layout, EOL conventions,
# and monthly-report aggregation logic against the CREATEGREEN data
# contract defined by PMF NS / dr. Secerov.
#
# Runs entirely offline — no network access required.  API responses
# are simulated with fixture data that mirrors the real Mars2/BIOS
# CustomDataExport wire format.
#
# Usage:  bash test_bios_export.sh
# Exit:   0 if all tests pass, 1 otherwise.

set -uo pipefail

# ── colours (disabled when stdout is not a tty) ─────────────────────
if [ -t 1 ]; then
    C_GREEN='\033[0;32m'; C_RED='\033[0;31m'
    C_CYAN='\033[0;36m';  C_RST='\033[0m'
else
    C_GREEN=''; C_RED=''; C_CYAN=''; C_RST=''
fi

PASS=0; FAIL=0; TOTAL=0

ok()   { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); printf "${C_GREEN}ok %d${C_RST}  %s\n"   "$TOTAL" "$1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); printf "${C_RED}FAIL %d${C_RST}  %s\n"   "$TOTAL" "$1"; }
note() { printf "${C_CYAN}# %s${C_RST}\n" "$1"; }

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then ok "$desc"
    else fail "$desc"; note "expected: $expected"; note "     got: $actual"; fi
}

assert_match() {
    local desc="$1" pattern="$2" actual="$3"
    if echo "$actual" | grep -qE -- "$pattern"; then ok "$desc"
    else fail "$desc"; note "pattern: $pattern"; note "    got: $actual"; fi
}

assert_contains() {
    local desc="$1" needle="$2" actual="$3"
    if echo "$actual" | grep -qF -- "$needle"; then ok "$desc"
    else fail "$desc"; note "expected substring: $needle"; note "              got: $actual"; fi
}

# ── workspace ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── the parser and the report aggregator under test ──────────────────
# bios-export.sh emits its embedded Python from two functions; sourcing the
# script in a subshell (it returns before running any command) gives us the
# very same code the partner runs, not a copy.
( . "$SCRIPT_DIR/bios-export.sh"; parse_py )  > "$WORK/parse.py"
( . "$SCRIPT_DIR/bios-export.sh"; report_py ) > "$WORK/report.py"
[ -s "$WORK/parse.py" ]  || { echo "could not extract parse_py from bios-export.sh" >&2; exit 1; }
[ -s "$WORK/report.py" ] || { echo "could not extract report_py from bios-export.sh" >&2; exit 1; }

# ── fixture data ─────────────────────────────────────────────────────
# Real API sample (from the Barrage deployment email)
SOLAX_API_SAMPLE='"SOLAXBIOS!1772319601;-19,468;288;17838;;;;;;;;;;;0;91239,40xa1772319901;-19,2;288;17840;;;;;;;;;;;0;91239,40xa1772320201;-20,256;288;17841;;;;;;;;;;;0;91239,40xa1772320501;-15,8;288;17843;;;;;;;;;;;0;91239,40xa"'

# Meteo station sample (21 data columns):
# Temperatura;Rel.vlaznost;Brzina vj.;Smjer vj.;Suncevo zr.;UV;Tlak;Kisa;
# CO;CO2;NO;NO2;O3;SO2;PM1;PM2.5;PM10;eaqi-traffic;CAQI;Buka;cumulative
OS1_API_SAMPLE='"OS1BIOS!1772319601;22,5;65;3,2;180;450;5;1013,2;0;0,1;400;5;10;60;2;8;12;25;35;2;45;30xa1772319901;22,8;64;3,5;185;460;5;1013,1;0;0,1;402;5;10;58;2;8;11;24;34;2;46;30xa"'

OS2_API_SAMPLE='"OS2BIOS!1772319601;23,1;60;2,8;190;440;4;1012,8;0,5;0,2;410;6;11;55;3;9;13;26;36;3;50;40xa"'

# Multi-day SOLAXBIOS fixture for report tests (built inline)
# 2026-03-01 00:00 UTC = 1740787200 ... wait, let's compute properly
MARCH1_00=$(python3 -c "from datetime import datetime,timezone; print(int(datetime(2026,3,1,tzinfo=timezone.utc).timestamp()))")
MARCH2_00=$(python3 -c "from datetime import datetime,timezone; print(int(datetime(2026,3,2,tzinfo=timezone.utc).timestamp()))")

# Day 1: 4 samples producing (5 min apart), then 2 samples idle
# Day 2: 2 samples producing, 1 sample idle
build_report_fixture() {
    python3 - "$MARCH1_00" "$MARCH2_00" << 'FIXTURE'
import sys
d1 = int(sys.argv[1])
d2 = int(sys.argv[2])

def row(ts, gp, tg, fg, soc, ac_pow, ac_eng):
    # vals[4]-[12] empty (9 slots), ac_pow at [13], ac_eng at [14]
    return f"{ts};{gp};{tg};{fg};{soc};;;;;;;;;;{ac_pow};{ac_eng}"

lines = []
# Day 1: 4 producing samples, 300 s apart → 3×5 = 15 min AC time
# toGrid: 1000 → 1000.9 (delta=0.9), fromGrid: 5000 → 5000.6 (delta=0.6)
lines.append(row(d1+300,  "500",  "1000",   "5000",   "80", "500",  "1,5"))
lines.append(row(d1+600,  "520",  "1000,3", "5000,2", "81", "520",  "3,0"))
lines.append(row(d1+900,  "510",  "1000,6", "5000,4", "82", "510",  "4,5"))
lines.append(row(d1+1200, "530",  "1000,9", "5000,6", "83", "530",  "6,0"))
# 2 idle samples
lines.append(row(d1+1500, "0",    "1000,9", "5000,6", "70", "0",    "6,0"))
lines.append(row(d1+1800, "0",    "1000,9", "5000,6", "68", "0",    "6,0"))

# Day 2: 2 producing samples → 1×5 = 5 min AC time
# toGrid: 1001 → 1001.5 (delta=0.5), fromGrid: 5001 → 5001.3 (delta=0.3)
lines.append(row(d2+300,  "400",  "1001",   "5001",   "75", "400",  "2,0"))
lines.append(row(d2+600,  "420",  "1001,5", "5001,3", "76", "420",  "4,0"))
# 1 idle
lines.append(row(d2+900,  "0",    "1001,5", "5001,3", "65", "0",    "4,0"))

print('"SOLAXBIOS!' + '0xa'.join(lines) + '0xa"')
FIXTURE
}

REPORT_FIXTURE=$(build_report_fixture)


# ═══════════════════════════════════════════════════════════════════════
note "═══  CREATEGREEN / bios-export.sh  test suite  ═══"
note ""
# ═══════════════════════════════════════════════════════════════════════


# ── 1. PARSER: record splitting ──────────────────────────────────────
note "── Section 1: API response parser ──"

PARSED_SOLAX=$(echo "$SOLAX_API_SAMPLE" | python3 "$WORK/parse.py")
PARSED_OS1=$(echo "$OS1_API_SAMPLE" | python3 "$WORK/parse.py")
PARSED_OS2=$(echo "$OS2_API_SAMPLE" | python3 "$WORK/parse.py")

assert_eq "SOLAXBIOS: 4 records parsed from sample" \
    "4" "$(echo "$PARSED_SOLAX" | wc -l | tr -d ' ')"

assert_eq "OS1BIOS: 2 records parsed from sample" \
    "2" "$(echo "$PARSED_OS1" | wc -l | tr -d ' ')"

assert_eq "OS2BIOS: 1 record parsed from sample" \
    "1" "$(echo "$PARSED_OS2" | wc -l | tr -d ' ')"

# Empty / malformed input
PARSED_EMPTY=$(echo '""' | python3 "$WORK/parse.py")
assert_eq "empty response produces no output" \
    "" "$PARSED_EMPTY"

PARSED_NOID=$(echo '"nodata"' | python3 "$WORK/parse.py")
assert_eq "response without ! delimiter produces no output" \
    "" "$PARSED_NOID"


# ── 2. FIELD STRUCTURE ───────────────────────────────────────────────
note "── Section 2: Field counts and delimiters ──"

# Contract: every field separated by ;
# OS1BIOS/OS2BIOS:  STATION ; TIMESTAMP ; 21 measurements = 23 fields
# SOLAXBIOS:        STATION ; TIMESTAMP ; 15 measurements = 17 fields

SOLAX_LINE1=$(echo "$PARSED_SOLAX" | head -1)
OS1_LINE1=$(echo "$PARSED_OS1" | head -1)
OS2_LINE1=$(echo "$PARSED_OS2" | head -1)

SOLAX_FIELDS=$(echo "$SOLAX_LINE1" | awk -F';' '{print NF}')
OS1_FIELDS=$(echo "$OS1_LINE1"   | awk -F';' '{print NF}')
OS2_FIELDS=$(echo "$OS2_LINE1"   | awk -F';' '{print NF}')

assert_eq "SOLAXBIOS: 17 semicolon-delimited fields (ID+TS+15)" \
    "17" "$SOLAX_FIELDS"

assert_eq "OS1BIOS: 23 semicolon-delimited fields (ID+TS+21)" \
    "23" "$OS1_FIELDS"

assert_eq "OS2BIOS: 23 semicolon-delimited fields (ID+TS+21)" \
    "23" "$OS2_FIELDS"


# ── 3. STATION ID PREFIX ─────────────────────────────────────────────
note "── Section 3: Station ID prefix ──"

assert_match "SOLAXBIOS lines start with SOLAXBIOS;" \
    "^SOLAXBIOS;" "$SOLAX_LINE1"

assert_match "OS1BIOS lines start with OS1BIOS;" \
    "^OS1BIOS;" "$OS1_LINE1"

assert_match "OS2BIOS lines start with OS2BIOS;" \
    "^OS2BIOS;" "$OS2_LINE1"


# ── 4. TIMESTAMP ─────────────────────────────────────────────────────
note "── Section 4: Unix timestamps ──"

SOLAX_TS=$(echo "$SOLAX_LINE1" | cut -d';' -f2)
OS1_TS=$(echo "$OS1_LINE1" | cut -d';' -f2)

assert_match "SOLAXBIOS timestamp is numeric unix epoch" \
    "^[0-9]{10}$" "$SOLAX_TS"

assert_match "OS1BIOS timestamp is numeric unix epoch" \
    "^[0-9]{10}$" "$OS1_TS"

# Verify it decodes to a sane date (2026-02-28, matches the real API sample)
TS_DATE=$(python3 -c "from datetime import datetime,timezone; print(datetime.fromtimestamp($SOLAX_TS, tz=timezone.utc).strftime('%Y-%m-%d'))")
assert_eq "SOLAXBIOS timestamp decodes to 2026-02-28 (real sample)" \
    "2026-02-28" "$TS_DATE"


# ── 5. DECIMAL SEPARATOR ─────────────────────────────────────────────
note "── Section 5: European decimal separator (comma) ──"

# The API returns comma as decimal separator — parser must preserve it
assert_contains "SOLAXBIOS: comma decimal preserved (e.g. -19,468)" \
    "-19,468" "$SOLAX_LINE1"

assert_contains "OS1BIOS: comma decimal preserved (e.g. 1013,2)" \
    "1013,2" "$OS1_LINE1"


# ── 6. EMPTY FIELDS ──────────────────────────────────────────────────
note "── Section 6: Empty measurement fields preserved ──"

# SOLAXBIOS sample has 10 empty fields (between ;;) — the parser must
# not collapse them, otherwise column alignment breaks for PMF NS.
SOLAX_EMPTIES=$(echo "$SOLAX_LINE1" | awk -F';' '{c=0; for(i=1;i<=NF;i++) if($i=="") c++; print c}')

assert_eq "SOLAXBIOS: 10 empty fields preserved in parsed output" \
    "10" "$SOLAX_EMPTIES"


# ── 7. EOL CONVENTION ────────────────────────────────────────────────
note "── Section 7: Unix EOL (0x0a) ──"

# Write parsed output to a file, verify no \r bytes (CR)
echo "$PARSED_SOLAX" > "$WORK/eol_test.txt"
CR_COUNT=$(od -c "$WORK/eol_test.txt" | grep -c '\\r' || true)

assert_eq "output contains no CR (\\r) bytes — pure unix EOL" \
    "0" "$CR_COUNT"

# Verify each line terminates with exactly 0x0a
LAST_BYTE=$(od -An -tx1 "$WORK/eol_test.txt" | tr -d ' \n' | tail -c 2)
assert_eq "file ends with 0x0a" "0a" "$LAST_BYTE"


# ── 8. HEADER LINE CONFORMANCE ───────────────────────────────────────
note "── Section 8: Output file header lines ──"

# Reference headers from the PMF NS specification files
OS1_EXPECTED_HEADER="OS1BIOS;TIMESTAMP;Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative"
OS2_EXPECTED_HEADER="OS2BIOS;TIMESTAMP;Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative"
SOLAX_EXPECTED_HEADER="SOLAXBIOS;TIMESTAMP;Grid.power.total;Grid.energy.toGrid.total;Grid.energy.fromGrid.total;BMS.energy.SOC;Inverter.Meter2.AC.power.total;Inverter.AC.EPS.power.R;Inverter.AC.EPS.power.S;Inverter.AC.EPS.power.T;Inverter.DC.Battery.power.total;Inverter.DC.PV.power.MPPT1;Inverter.DC.PV.power.MPPT2;Inverter.DC.PV.power.MPPT3;Inverter.DC.PV.power.MPPT4;Inverter.AC.power.total;Inverter.AC.energy.out.daily"

# Source the layout headers from bios-export.sh (stations map onto them via stations.conf)
declare -A LAYOUT_HEADERS
eval "$(grep '^LAYOUT_HEADERS\[' "$SCRIPT_DIR/bios-export.sh")"

SCRIPT_OS1_HEADER="OS1BIOS;TIMESTAMP;${LAYOUT_HEADERS[meteo]}"
SCRIPT_OS2_HEADER="OS2BIOS;TIMESTAMP;${LAYOUT_HEADERS[meteo]}"
SCRIPT_SOLAX_HEADER="SOLAXBIOS;TIMESTAMP;${LAYOUT_HEADERS[solar]}"

assert_eq "OS1BIOS header matches PMF NS spec" \
    "$OS1_EXPECTED_HEADER" "$SCRIPT_OS1_HEADER"

assert_eq "OS2BIOS header matches PMF NS spec" \
    "$OS2_EXPECTED_HEADER" "$SCRIPT_OS2_HEADER"

assert_eq "SOLAXBIOS header matches PMF NS spec" \
    "$SOLAX_EXPECTED_HEADER" "$SCRIPT_SOLAX_HEADER"

# Header field count
OS1_HDR_FIELDS=$(echo "$OS1_EXPECTED_HEADER" | awk -F';' '{print NF}')
SOLAX_HDR_FIELDS=$(echo "$SOLAX_EXPECTED_HEADER" | awk -F';' '{print NF}')

assert_eq "OS1BIOS header: 23 fields" "23" "$OS1_HDR_FIELDS"
assert_eq "SOLAXBIOS header: 17 fields" "17" "$SOLAX_HDR_FIELDS"


# ── 9. MONTHLY REPORT HEADER ─────────────────────────────────────────
note "── Section 9: Monthly report header ──"

REPORT_EXPECTED_HEADER="SOLAXBIOS;TIMESTAMP;Effective AC Output Time (min);Total Effective AC Output Time (min);Inverter output (kWh);Exported energy (kWh);Imported energy (kWh)"

REPORT_OUTPUT=$(echo "$REPORT_FIXTURE" | python3 "$WORK/report.py")
REPORT_HDR=$(echo "$REPORT_OUTPUT" | head -1)

assert_eq "monthly report header matches spec" \
    "$REPORT_EXPECTED_HEADER" "$REPORT_HDR"

REPORT_HDR_FIELDS=$(echo "$REPORT_HDR" | awk -F';' '{print NF}')
assert_eq "monthly report header: 7 fields" "7" "$REPORT_HDR_FIELDS"


# ── 10. MONTHLY REPORT: ROW COUNT ────────────────────────────────────
note "── Section 10: Monthly report row count ──"

REPORT_DATA=$(echo "$REPORT_OUTPUT" | tail -n +2)
REPORT_ROWS=$(echo "$REPORT_DATA" | wc -l | tr -d ' ')

assert_eq "monthly report: 2 day rows for 2-day fixture" \
    "2" "$REPORT_ROWS"


# ── 11. MONTHLY REPORT: DAY TIMESTAMPS ───────────────────────────────
note "── Section 11: Monthly report day timestamps ──"

DAY1_ROW=$(echo "$REPORT_DATA" | head -1)
DAY2_ROW=$(echo "$REPORT_DATA" | tail -1)

DAY1_TS=$(echo "$DAY1_ROW" | cut -d';' -f2)
DAY2_TS=$(echo "$DAY2_ROW" | cut -d';' -f2)

assert_eq "day 1 timestamp = 2026-03-01 00:00 UTC" \
    "$MARCH1_00" "$DAY1_TS"

assert_eq "day 2 timestamp = 2026-03-02 00:00 UTC" \
    "$MARCH2_00" "$DAY2_TS"


# ── 12. MONTHLY REPORT: EFFECTIVE AC OUTPUT TIME ─────────────────────
note "── Section 12: Monthly report — Effective AC Output Time ──"

# Day 1: 4 producing samples, 5 min apart → 3 intervals = 15.0 min
DAY1_AC_MIN=$(echo "$DAY1_ROW" | cut -d';' -f3)
assert_eq "day 1: AC output time = 15,0 min (3 intervals × 5 min)" \
    "15,0" "$DAY1_AC_MIN"

# Day 2: 2 producing samples, 5 min apart → 1 interval = 5.0 min
DAY2_AC_MIN=$(echo "$DAY2_ROW" | cut -d';' -f3)
assert_eq "day 2: AC output time = 5,0 min (1 interval × 5 min)" \
    "5,0" "$DAY2_AC_MIN"


# ── 13. MONTHLY REPORT: CUMULATIVE AC TIME ───────────────────────────
note "── Section 13: Monthly report — cumulative AC time ──"

DAY1_CUM=$(echo "$DAY1_ROW" | cut -d';' -f4)
DAY2_CUM=$(echo "$DAY2_ROW" | cut -d';' -f4)

assert_eq "day 1: cumulative AC time = 15,0" \
    "15,0" "$DAY1_CUM"

assert_eq "day 2: cumulative AC time = 20,0 (15 + 5)" \
    "20,0" "$DAY2_CUM"

# Real samples are 299-301 s apart; the running total must still be the sum
# of the printed day values (each day rounded before it is added).
MARCH3_00=$((MARCH2_00 + 86400))
ODD_FIX='"SOLAXBIOS!'
for d0 in "$MARCH1_00" "$MARCH2_00" "$MARCH3_00"; do
    ODD_FIX+="$((d0+300));500;1000;5000;;;;;;;;;;;500;1,00xa"
    ODD_FIX+="$((d0+599));500;1000;5000;;;;;;;;;;;500;1,00xa"   # 299 s = 4,98 min -> 5,0
done
ODD_FIX+='"'
ODD_ROWS=$(echo "$ODD_FIX" | python3 "$WORK/report.py" | tail -n +2)
assert_eq "299 s intervals: each day 5,0 and the total 15,0 (3 x 4,98 unrounded would print 14,9)" \
    "5,0 5,0 5,0 10,0 5,0 15,0" "$(echo "$ODD_ROWS" | awk -F';' '{printf "%s %s ", $3, $4}' | sed 's/ $//')"


# ── 14. MONTHLY REPORT: INVERTER OUTPUT ──────────────────────────────
note "── Section 14: Monthly report — inverter output ──"

# Last Inverter.AC.energy.out.daily of day 1 = 6,0 -> printed with two decimals
# Last Inverter.AC.energy.out.daily of day 2 = 4,0
DAY1_INV=$(echo "$DAY1_ROW" | cut -d';' -f5)
DAY2_INV=$(echo "$DAY2_ROW" | cut -d';' -f5)

assert_eq "day 1: inverter output = 6,00 kWh" \
    "6,00" "$DAY1_INV"

assert_eq "day 2: inverter output = 4,00 kWh" \
    "4,00" "$DAY2_INV"


# ── 15. MONTHLY REPORT: EXPORTED ENERGY ──────────────────────────────
note "── Section 15: Monthly report — exported energy (toGrid delta) ──"

# Day 1: toGrid goes from 1000 → 1000,9 → delta = 0.9
# Day 2: toGrid goes from 1001 → 1001,5 → delta = 0.5
DAY1_EXP=$(echo "$DAY1_ROW" | cut -d';' -f6)
DAY2_EXP=$(echo "$DAY2_ROW" | cut -d';' -f6)

assert_eq "day 1: exported energy = 0,90 kWh" \
    "0,90" "$DAY1_EXP"

assert_eq "day 2: exported energy = 0,50 kWh" \
    "0,50" "$DAY2_EXP"


# ── 16. MONTHLY REPORT: IMPORTED ENERGY ──────────────────────────────
note "── Section 16: Monthly report — imported energy (fromGrid delta) ──"

# Day 1: fromGrid goes from 5000 → 5000,6 → delta = 0.6
# Day 2: fromGrid goes from 5001 → 5001,3 → delta = 0.3
DAY1_IMP=$(echo "$DAY1_ROW" | cut -d';' -f7)
DAY2_IMP=$(echo "$DAY2_ROW" | cut -d';' -f7)

assert_eq "day 1: imported energy = 0,60 kWh" \
    "0,60" "$DAY1_IMP"

assert_eq "day 2: imported energy = 0,30 kWh" \
    "0,30" "$DAY2_IMP"

# Every number in the report has a fixed number of decimals: minutes one,
# kWh two (no "0" next to "515,0", no "32,4" next to "27,32").
assert_match "report numbers: minutes have exactly one decimal, kWh exactly two" \
    '^[A-Z0-9]+;[0-9]+;-?[0-9]+,[0-9];-?[0-9]+,[0-9];(-?[0-9]+,[0-9]{2})?;(-?[0-9]+,[0-9]{2})?;(-?[0-9]+,[0-9]{2})?$' "$DAY1_ROW"
assert_match "report numbers: day 2 row has the same shape" \
    '^[A-Z0-9]+;[0-9]+;-?[0-9]+,[0-9];-?[0-9]+,[0-9];(-?[0-9]+,[0-9]{2})?;(-?[0-9]+,[0-9]{2})?;(-?[0-9]+,[0-9]{2})?$' "$DAY2_ROW"


# ── 17. MONTHLY REPORT: FIELD COUNT PER ROW ──────────────────────────
note "── Section 17: Monthly report — field count per data row ──"

DAY1_ROW_FIELDS=$(echo "$DAY1_ROW" | awk -F';' '{print NF}')
assert_eq "monthly report data row: 7 fields" \
    "7" "$DAY1_ROW_FIELDS"


# ── 18. EDGE CASES ───────────────────────────────────────────────────
note "── Section 18: Edge cases ──"

# Single record (no 0xa separator)
SINGLE='"SOLAXBIOS!1772319601;-10;200;15000;;;;;;;;;;100;500,2"'
PARSED_SINGLE=$(echo "$SINGLE" | python3 "$WORK/parse.py")
SINGLE_COUNT=$(echo "$PARSED_SINGLE" | wc -l | tr -d ' ')
assert_eq "single record (no 0xa) parses to 1 line" \
    "1" "$SINGLE_COUNT"

# Trailing 0xa only (no data before it)
TRAILING='"SOLAXBIOS!0xa"'
PARSED_TRAILING=$(echo "$TRAILING" | python3 "$WORK/parse.py")
assert_eq "trailing 0xa with no data yields no output" \
    "" "$PARSED_TRAILING"

# All-empty measurements (timestamp + 21 empty values = 22 semicolons after !)
ALL_EMPTY='"OS1BIOS!1772319601;;;;;;;;;;;;;;;;;;;;;0xa"'
PARSED_EMPTY_VALS=$(echo "$ALL_EMPTY" | python3 "$WORK/parse.py")
EMPTY_FIELDS=$(echo "$PARSED_EMPTY_VALS" | awk -F';' '{print NF}')
# ID + TS + 21 empty slots = 23 fields
assert_eq "all-empty measurement record: field count = 23 (ID+TS+21)" \
    "23" "$EMPTY_FIELDS"

# Idle-only day in report (AC power always 0)
IDLE_FIXTURE='"SOLAXBIOS!'"$((MARCH1_00+300))"';0;1000;5000;50;;;;;;;;;;0;00xa'"$((MARCH1_00+600))"';0;1000;5000;50;;;;;;;;;;0;00xa"'
IDLE_REPORT=$(echo "$IDLE_FIXTURE" | python3 "$WORK/report.py")
IDLE_DAY=$(echo "$IDLE_REPORT" | tail -1)
IDLE_AC=$(echo "$IDLE_DAY" | cut -d';' -f3)
assert_eq "idle-only day: AC output time = 0,0" \
    "0,0" "$IDLE_AC"

IDLE_EXP=$(echo "$IDLE_DAY" | cut -d';' -f6)
assert_eq "idle-only day: exported energy = 0,00" \
    "0,00" "$IDLE_EXP"


# ── 19. AC TIME: GAP ACROSS IDLE PERIODS ─────────────────────────────
note "── Section 19: AC time does not count across idle gaps ──"

# 2 producing samples, then 1 idle, then 2 producing — gap > 10 min
# ts: +300(produce), +600(produce), +900(idle), +3000(produce), +3300(produce)
# Expected: 5 min from first pair + 5 min from second pair = 10 min
# The 2100s gap between +600 and +3000 must NOT be counted
GAP_FIX='"SOLAXBIOS!'
GAP_FIX+="$((MARCH1_00+300));500;1000;5000;80;;;;;;;;;;500;1,50xa"
GAP_FIX+="$((MARCH1_00+600));510;1000,3;5000;81;;;;;;;;;;510;3,00xa"
GAP_FIX+="$((MARCH1_00+900));0;1000,3;5000;70;;;;;;;;;;0;3,00xa"
GAP_FIX+="$((MARCH1_00+3000));520;1000,6;5000;82;;;;;;;;;;520;4,50xa"
GAP_FIX+="$((MARCH1_00+3300));530;1000,9;5000;83;;;;;;;;;;530;6,00xa"
GAP_FIX+='"'

GAP_REPORT=$(echo "$GAP_FIX" | python3 "$WORK/report.py")
GAP_AC=$(echo "$GAP_REPORT" | tail -1 | cut -d';' -f3)
assert_eq "AC time: idle gap resets accumulation (5+5 = 10,0 min)" \
    "10,0" "$GAP_AC"


# ── 20. AC TIME: LARGE GAP BETWEEN PRODUCING SAMPLES ─────────────────
note "── Section 20: AC time — large inter-sample gap (>10 min) ──"

# 2 producing samples 15 min apart → gap > 10 min threshold → not counted
LARGE_GAP='"SOLAXBIOS!'
LARGE_GAP+="$((MARCH1_00+300));500;1000;5000;80;;;;;;;;;;500;1,50xa"
LARGE_GAP+="$((MARCH1_00+1200));510;1000,3;5000;81;;;;;;;;;;510;3,00xa"
LARGE_GAP+='"'

LGAP_REPORT=$(echo "$LARGE_GAP" | python3 "$WORK/report.py")
LGAP_AC=$(echo "$LGAP_REPORT" | tail -1 | cut -d';' -f3)
assert_eq "15-min gap between producing samples: AC time = 0,0 (gap > 10 min)" \
    "0,0" "$LGAP_AC"


# ── 20a. ENERGY: METER RESET INSIDE A DAY ────────────────────────────
note "── Section 20a: Energy counters — a meter reset is not a negative delta ──"

# Seen on SOLAXBIOS 2026-11-02 (fromGrid 1232 -> 2) and 2026-11-06
# (toGrid 9021 -> 1). last-first would give -815 / -9013 kWh; the report
# sums the increases and skips the drop.
RESET_FIX='"SOLAXBIOS!'
RESET_FIX+="$((MARCH1_00+300));-10;9021;1195;;;;;;;;;;;0;0xa"
RESET_FIX+="$((MARCH1_00+600));-10;9021;1232;;;;;;;;;;;0;0xa"
RESET_FIX+="$((MARCH1_00+900));-10;9021;2;;;;;;;;;;;0;0xa"
RESET_FIX+="$((MARCH1_00+1200));-10;9021;380;;;;;;;;;;;0;0xa"
RESET_FIX+="$((MARCH1_00+1500));-10;1;380,5;;;;;;;;;;;0;0xa"
RESET_FIX+="$((MARCH1_00+1800));-10;3;381;;;;;;;;;;;0;0xa"
RESET_FIX+='"'
RESET_ROW=$(echo "$RESET_FIX" | python3 "$WORK/report.py" | tail -1)
assert_eq "imported energy over a reset = (1232-1195) + (380-2) + 0,5 + 0,5 = 416,00" \
    "416,00" "$(echo "$RESET_ROW" | cut -d';' -f7)"
assert_eq "exported energy over a reset = 0 + (3-1) = 2,00" \
    "2,00" "$(echo "$RESET_ROW" | cut -d';' -f6)"

# A counter that never has a value that day leaves the cell empty; a single
# sample gives 0,00.
ONE_FIX='"SOLAXBIOS!'"$((MARCH1_00+300))"';-10;;17838;;;;;;;;;;;0;0xa"'
ONE_ROW=$(echo "$ONE_FIX" | python3 "$WORK/report.py" | tail -1)
assert_eq "toGrid never sampled: exported cell empty" "" "$(echo "$ONE_ROW" | cut -d';' -f6)"
assert_eq "fromGrid sampled once: imported 0,00" "0,00" "$(echo "$ONE_ROW" | cut -d';' -f7)"
assert_eq "no daily value that day: inverter output cell empty" "" "$(echo "$ONE_ROW" | cut -d';' -f5)"


# ── 20b. WINDOW CLIPPING ─────────────────────────────────────────────
note "── Section 20b: Rows outside the requested window are dropped ──"

# Mars2 may answer a wider (shifted) window than asked; the parser gets the
# requested bounds and keeps only [from, to].
CLIP_FIX='"SOKO46!'
CLIP_FIX+="$((MARCH1_00-300));1;2;3;;;;;;;;;;;0;10xa"     # before the window
CLIP_FIX+="$((MARCH1_00));1;2;3;;;;;;;;;;;0;10xa"         # exactly at from (kept)
CLIP_FIX+="$((MARCH1_00+300));1;2;3;;;;;;;;;;;0;10xa"
CLIP_FIX+="$((MARCH2_00));1;2;3;;;;;;;;;;;0;10xa"         # exactly at to (kept)
CLIP_FIX+="$((MARCH2_00+300));1;2;3;;;;;;;;;;;0;10xa"     # after the window
CLIP_FIX+='"'
CLIPPED=$(echo "$CLIP_FIX" | python3 "$WORK/parse.py" "$MARCH1_00" "$MARCH2_00")
assert_eq "parse: 3 of 5 rows inside [from, to]" "3" "$(echo "$CLIPPED" | wc -l | tr -d ' ')"
assert_eq "parse: first kept row is the one at from" "$MARCH1_00" "$(echo "$CLIPPED" | head -1 | cut -d';' -f2)"
assert_eq "parse: last kept row is the one at to" "$MARCH2_00" "$(echo "$CLIPPED" | tail -1 | cut -d';' -f2)"
UNCLIPPED=$(echo "$CLIP_FIX" | python3 "$WORK/parse.py")
assert_eq "parse without bounds keeps every row (as before)" "5" "$(echo "$UNCLIPPED" | wc -l | tr -d ' ')"

# The monthly report ignores rows outside [first day, first day of next month):
# the row at the next month's 00:00:00 belongs to the next month.
APRIL1_00=$(python3 -c "from datetime import datetime,timezone; print(int(datetime(2026,4,1,tzinfo=timezone.utc).timestamp()))")
MONTH_FIX='"SOLAXBIOS!'
MONTH_FIX+="$((MARCH1_00-3600));0;1000;5000;;;;;;;;;;;0;00xa"   # 28 Feb 23:00 (Mars2 shift artefact)
MONTH_FIX+="$((MARCH1_00+300));0;1000;5000;;;;;;;;;;;0;00xa"
MONTH_FIX+="$((APRIL1_00));0;1000;5000;;;;;;;;;;;0;00xa"        # 1 Apr 00:00:00
MONTH_FIX+='"'
MONTH_DAYS=$(echo "$MONTH_FIX" | python3 "$WORK/report.py" "$MARCH1_00" "$APRIL1_00" | tail -n +2 | cut -d';' -f2)
assert_eq "report with month bounds: only the March day remains" "$MARCH1_00" "$MONTH_DAYS"
assert_eq "report without bounds: three days (as before)" "3" "$(echo "$MONTH_FIX" | python3 "$WORK/report.py" | tail -n +2 | wc -l | tr -d ' ')"


# ── 20c. WINDOW HELPERS ──────────────────────────────────────────────
note "── Section 20c: UTC window helpers ──"

assert_eq "utc_epoch: 2026-03-01 00:00:00 -> ${MARCH1_00}" \
    "$MARCH1_00" "$( . "$SCRIPT_DIR/bios-export.sh"; utc_epoch '2026-03-01 00:00:00' )"
assert_eq "utc_str: ${MARCH1_00} -> 2026-03-01 00:00:00" \
    "2026-03-01 00:00:00" "$( . "$SCRIPT_DIR/bios-export.sh"; utc_str "$MARCH1_00" )"
if ( . "$SCRIPT_DIR/bios-export.sh"; utc_epoch '2026-03-01' ) >/dev/null 2>&1; then
    fail "utc_epoch rejects a date without time"
else
    ok "utc_epoch rejects a date without time"
fi
assert_eq "request window is widened by 2 h on each side (WINDOW_SLACK)" \
    "7200" "$( . "$SCRIPT_DIR/bios-export.sh"; echo "$WINDOW_SLACK" )"
BAD_FROM=$(bash "$SCRIPT_DIR/bios-export.sh" fetch --from "01.03.2026" --to "2026-03-02 00:00:00" --station OS2BIOS 2>&1)
assert_contains "fetch rejects --from that is not YYYY-MM-DD HH:MM:SS before any network call" \
    "must be \"YYYY-MM-DD HH:MM:SS\"" "$BAD_FROM"
BAD_ORDER=$(bash "$SCRIPT_DIR/bios-export.sh" fetch --from "2026-03-02 00:00:00" --to "2026-03-01 00:00:00" --station OS2BIOS 2>&1)
assert_contains "fetch rejects --to before --from" "later than --from" "$BAD_ORDER"
BAD_MONTH=$(bash "$SCRIPT_DIR/bios-export.sh" report --month 2026-13 2>&1)
assert_contains "report rejects month 13" "Month must be YYYY-MM" "$BAD_MONTH"


# ── 21. SCRIPT PLUMBING ──────────────────────────────────────────────
note "── Section 21: Script basics ──"

# bios-export.sh must exist and be parseable
bash -n "$SCRIPT_DIR/bios-export.sh" 2>/dev/null
assert_eq "bios-export.sh passes bash -n syntax check" \
    "0" "$?"

# --help exits 0
bash "$SCRIPT_DIR/bios-export.sh" --help >/dev/null 2>&1
assert_eq "bios-export.sh --help exits 0" "0" "$?"

# fetch without --from fails
bash "$SCRIPT_DIR/bios-export.sh" fetch 2>/dev/null
FETCH_RC=$?
if [ "$FETCH_RC" -ne 0 ]; then ok "fetch without --from exits non-zero"
else fail "fetch without --from exits non-zero"; fi

# report without --month fails
bash "$SCRIPT_DIR/bios-export.sh" report 2>/dev/null
REPORT_RC=$?
if [ "$REPORT_RC" -ne 0 ]; then ok "report without --month exits non-zero"
else fail "report without --month exits non-zero"; fi

# report with bad month format fails
bash "$SCRIPT_DIR/bios-export.sh" report --month "2026/03" 2>/dev/null
BAD_RC=$?
if [ "$BAD_RC" -ne 0 ]; then ok "report with YYYY/MM format exits non-zero"
else fail "report with YYYY/MM format exits non-zero"; fi


# ── 22. STATION CONFIGURATION (stations.conf) ────────────────────────
note "── Section 22: stations.conf ──"

STATIONS_OUT=$(bash "$SCRIPT_DIR/bios-export.sh" stations 2>/dev/null)
assert_eq "stations: two meteo stations and four solar plants are active by default" \
    "OS1BIOS OS2BIOS SOLAXBIOS SOKO46 SOKOBAZEN VETINST" "$(echo "$STATIONS_OUT" | awk -F'\t' '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
assert_contains "stations: SOLAXBIOS has the solar layout (15 columns)" \
    $'SOLAXBIOS\tsolar\t15 columns' "$STATIONS_OUT"
assert_contains "stations: OS2BIOS has the meteo layout (21 columns)" \
    $'OS2BIOS\tmeteo\t21 columns' "$STATIONS_OUT"
for sid in SOKO46 SOKOBAZEN VETINST; do
    assert_contains "stations: ${sid} (vendor plant via the BIOS feed) has the solar layout (15 columns)" \
        "${sid}"$'\tsolar\t15 columns' "$STATIONS_OUT"
done
assert_eq "stations: the unmapped Dvorana Kulturnog centra code stays disabled" \
    "" "$(echo "$STATIONS_OUT" | awk -F'\t' '$1 == "Solarman"')"
# bios-cron.sh produces one monthly report per solar-layout station.
assert_eq "cron: one monthly report per solar-layout station (4)" \
    "4" "$(echo "$STATIONS_OUT" | awk -F'\t' '$2 == "solar"' | wc -l | tr -d ' ')"

# A custom file: comments, blank lines, CRLF and a new solar plant.
printf '# comment\r\n\r\nOS2BIOS|meteo\r\nSOKO46|solar   # trailing comment\r\n' > "$WORK/stations.conf"
CUSTOM_OUT=$(BIOS_STATIONS_FILE="$WORK/stations.conf" bash "$SCRIPT_DIR/bios-export.sh" stations 2>/dev/null)
assert_eq "custom stations.conf: comments, CRLF and blanks are ignored" \
    "OS2BIOS SOKO46" "$(echo "$CUSTOM_OUT" | awk -F'\t' '{print $1}' | tr '\n' ' ' | sed 's/ $//')"
assert_contains "custom stations.conf: new plant gets the solar layout" \
    $'SOKO46\tsolar\t15 columns' "$CUSTOM_OUT"

# Unknown layout is a hard error.
printf 'X|wind\n' > "$WORK/bad.conf"
BAD_OUT=$(BIOS_STATIONS_FILE="$WORK/bad.conf" bash "$SCRIPT_DIR/bios-export.sh" stations 2>&1)
BAD_RC=$?
if [ "$BAD_RC" -ne 0 ]; then ok "unknown layout in stations.conf exits non-zero"
else fail "unknown layout in stations.conf exits non-zero"; fi
assert_contains "unknown layout names the offending station" "unknown layout 'wind' for X" "$BAD_OUT"

# Unknown station on the command line is rejected before any network call.
UNK_OUT=$(bash "$SCRIPT_DIR/bios-export.sh" fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00" --station NOPE 2>&1)
UNK_RC=$?
if [ "$UNK_RC" -ne 0 ]; then ok "fetch --station NOPE exits non-zero"
else fail "fetch --station NOPE exits non-zero"; fi
assert_contains "fetch --station NOPE lists the known stations" "Known stations" "$UNK_OUT"

# The monthly report accepts any solar-layout station and refuses meteo ones,
# both decided before authentication.
METEO_OUT=$(bash "$SCRIPT_DIR/bios-export.sh" report --month 2026-03 --station OS1BIOS 2>&1)
assert_contains "report refuses a meteo-layout station" "needs a solar-layout station" "$METEO_OUT"
SOLAR_OUT=$(BIOS_STATIONS_FILE="$WORK/stations.conf" BIOS_API_BASE="http://127.0.0.1:9" bash "$SCRIPT_DIR/bios-export.sh" report --month 2026-03 --station SOKO46 2>&1)
if echo "$SOLAR_OUT" | grep -qE "Token request failed|Set BIOS_USERNAME|Authenticating"; then ok "report accepts a solar-layout station from stations.conf (fails only at authentication)"
else fail "report accepts a solar-layout station from stations.conf (fails only at authentication)"; note "got: $SOLAR_OUT"; fi

# bios-cron.sh must stay parseable
bash -n "$SCRIPT_DIR/bios-cron.sh" 2>/dev/null
assert_eq "bios-cron.sh passes bash -n syntax check" "0" "$?"


# ═══════════════════════════════════════════════════════════════════════
note ""
note "═══  Results  ═══"
printf "${C_CYAN}# total: %d   passed: %d   failed: %d${C_RST}\n" \
    "$TOTAL" "$PASS" "$FAIL"
note ""

if [ "$FAIL" -gt 0 ]; then
    printf "${C_RED}# SOME TESTS FAILED${C_RST}\n"
    exit 1
else
    printf "${C_GREEN}# ALL TESTS PASSED${C_RST}\n"
    exit 0
fi
