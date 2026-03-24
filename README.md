# CREATEGREEN BIOS Data Export

Export and parse measurement data from the BIOS platform (Mars2 API)
for the CREATEGREEN project.

Two components:

1. **`bios-export.sh`** -- bash script that fetches data from the Mars2
   API and writes semicolon-delimited text files.
2. **`BIOS::CreateGreen`** -- Perl module that reads those text files
   and provides structured data for further processing.


## Prerequisites

- bash 4+, curl, python3 (standard on any modern Linux / WSL)
- perl 5.10+ (core modules only, no CPAN dependencies)


## Quick start

```sh
cp .env.example .env       # create config from template
vi .env                    # fill in BIOS_USERNAME and BIOS_PASSWORD
chmod +x bios-export.sh bios-cron.sh
bash bios-export.sh fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00"
```


## Repository layout

```
.env.example                    credentials template (tracked)
.env                            your credentials (NOT tracked in git)
bios-export.sh                  fetch script (producer)
bios-cron.sh                    daily cron wrapper (72 h window)
test_bios_export.sh             bash test suite for the export script
lib/
  BIOS/
    CreateGreen.pm              Perl reader module
    CreateGreen/
      ResultSet.pm              result container
t/
  creategreen.t                 Perl test suite
docs/                           public dashboard served via GitHub Pages
  index.html                    (NOT documentation -- this is the live dashboard)
worker/                         Cloudflare Worker API proxy
  worker.js                     auth + parse + CORS proxy
  wrangler.toml                 Worker config
  README.md                     Worker deploy instructions
os1bios-measurements.txt        column spec -- meteo station 1
os2bios-measurements.txt        column spec -- meteo station 2
solaxbios-measurements.txt      column spec -- FNE (solar inverter)
solaxbios-monthly-report.txt    column spec -- monthly report
Mars2 REST API.html             API reference (Redoc)
```


## 1. Fetching data

### Fetch measurements

```sh
# all three stations, one day
bash bios-export.sh fetch \
    --from "2026-03-01 00:00:00" \
    --to   "2026-03-02 00:00:00"

# single station
bash bios-export.sh fetch \
    --from "2026-03-01 00:00:00" \
    --to   "2026-03-02 00:00:00" \
    --station OS1BIOS

# custom output directory
bash bios-export.sh fetch \
    --from "2026-03-01 00:00:00" \
    --to   "2026-03-02 00:00:00" \
    -o /data/bios
```

### Generate the monthly report

```sh
bash bios-export.sh report --month 2026-03
```

### Output files

All files are written to `./output/` (override with `-o`):

| File                              | Station   | Columns |
|-----------------------------------|-----------|---------|
| `os1bios-measurements.txt`        | OS1BIOS   | 21      |
| `os2bios-measurements.txt`        | OS2BIOS   | 21      |
| `solaxbios-measurements.txt`      | SOLAXBIOS | 15      |
| `solaxbios-monthly-report.txt`    | SOLAXBIOS | 5       |


## 2. Automated daily export (cron)

Per the CREATEGREEN data contract, each file contains the **last 72
hours** of measurements and is regenerated **every day at 00:00 UTC**.
The monthly report for the current month is also regenerated daily.

`bios-cron.sh` handles this.  It computes the 72-hour window
automatically and calls `bios-export.sh` for all stations plus
the report.

### Install the cron job

No root needed -- runs as your regular user.

```sh
# make scripts executable
chmod +x bios-export.sh bios-cron.sh

# create a log directory
mkdir -p ~/.local/log

# open the crontab editor
crontab -e
```

Add this line (adjust path to where you cloned the repo):

```crontab
0 0 * * *  /home/user/bios-creategreen/bios-cron.sh >> ~/.local/log/bios-cron.log 2>&1
```

This runs at midnight UTC every day.  Output and errors are appended
to the log file.  Output files land in `./output/` next to the scripts.

### Configuration

Override defaults with environment variables in the crontab:

```crontab
BIOS_OUTPUT_DIR=/home/user/data/bios
0 0 * * *  /home/user/bios-creategreen/bios-cron.sh >> ~/.local/log/bios-cron.log 2>&1
```

| Variable          | Default                  | Description                      |
|-------------------|--------------------------|----------------------------------|
| `BIOS_OUTPUT_DIR` | `./output` (next to script) | Where the text files are written |
| `BIOS_SCRIPT_DIR` | directory of the script  | Where `bios-export.sh` lives     |

### What it produces

After each run, `BIOS_OUTPUT_DIR` contains:

```
os1bios-measurements.txt        last 72 h, meteo station 1
os2bios-measurements.txt        last 72 h, meteo station 2
solaxbios-measurements.txt      last 72 h, solar inverter
solaxbios-monthly-report.txt    current month, one row per day
```

These files are overwritten on each run.  PMF NS fetches them once
daily via curl after they are generated.

### Verifying the cron job

```sh
# check crontab is installed
crontab -l

# manual test run
./bios-cron.sh

# check the log
tail -f ~/.local/log/bios-cron.log
```


## 3. File format

Every file follows the same conventions:

- first line is a header
- one record per line
- fields separated by `;`
- unix EOL (`0x0a`)
- decimal separator is `,` (European)
- empty field = no measurement for that timestamp
- each line starts with `STATION_ID;UNIX_TIMESTAMP;values...`


## 4. Measurement fields

### OS1BIOS / OS2BIOS (meteo stations, 21 columns)

| #  | File header            | Perl key             |
|----|------------------------|----------------------|
| 1  | Temperatura            | Temperatura          |
| 2  | Relativna vlaznost     | Relativna_vlaznost   |
| 3  | Brzina vjetra          | Brzina_vjetra        |
| 4  | Smjer vjetra           | Smjer_vjetra         |
| 5  | Suncevo zracenje       | Suncevo_zracenje     |
| 6  | UV indeks              | UV_indeks            |
| 7  | Tlak zraka             | Tlak_zraka           |
| 8  | Kisa                   | Kisa                 |
| 9  | CO                     | CO                   |
| 10 | CO2                    | CO2                  |
| 11 | NO                     | NO                   |
| 12 | NO2                    | NO2                  |
| 13 | O3                     | O3                   |
| 14 | SO2                    | SO2                  |
| 15 | Lebdece cestice PM1    | PM1                  |
| 16 | Lebdece cestice PM2.5  | PM2_5                |
| 17 | Lebdece cestice PM10   | PM10                 |
| 18 | eaqi-traffic           | eaqi_traffic         |
| 19 | CAQI                   | CAQI                 |
| 20 | Buka                   | Buka                 |
| 21 | cumulative             | cumulative           |

### SOLAXBIOS (FNE / solar inverter, 15 columns)

| #  | File header                       | Perl key                         |
|----|-----------------------------------|----------------------------------|
| 1  | Grid.power.total                  | Grid_power_total                 |
| 2  | Grid.energy.toGrid.total          | Grid_energy_toGrid_total         |
| 3  | Grid.energy.fromGrid.total        | Grid_energy_fromGrid_total       |
| 4  | BMS.energy.SOC                    | BMS_energy_SOC                   |
| 5  | Inverter.Meter2.AC.power.total    | Inverter_Meter2_AC_power_total   |
| 6  | Inverter.AC.EPS.power.R           | Inverter_AC_EPS_power_R          |
| 7  | Inverter.AC.EPS.power.S           | Inverter_AC_EPS_power_S          |
| 8  | Inverter.AC.EPS.power.T           | Inverter_AC_EPS_power_T          |
| 9  | Inverter.DC.Battery.power.total   | Inverter_DC_Battery_power_total  |
| 10 | Inverter.DC.PV.power.MPPT1        | Inverter_DC_PV_power_MPPT1       |
| 11 | Inverter.DC.PV.power.MPPT2        | Inverter_DC_PV_power_MPPT2       |
| 12 | Inverter.DC.PV.power.MPPT3        | Inverter_DC_PV_power_MPPT3       |
| 13 | Inverter.DC.PV.power.MPPT4        | Inverter_DC_PV_power_MPPT4       |
| 14 | Inverter.AC.power.total           | Inverter_AC_power_total          |
| 15 | Inverter.AC.energy.out.daily      | Inverter_AC_energy_out_daily     |

### Monthly report (5 columns)

| #  | File header                         | Perl key                       |
|----|-------------------------------------|--------------------------------|
| 1  | Effective AC Output Time (min)      | effective_ac_output_min        |
| 2  | Total Effective AC Output Time (min)| total_effective_ac_output_min  |
| 3  | Inverter output (kWh)               | inverter_output_kwh            |
| 4  | Exported energy (kWh)               | exported_energy_kwh            |
| 5  | Imported energy (kWh)               | imported_energy_kwh            |


## 5. Using the Perl module

```perl
use lib './lib';
use BIOS::CreateGreen;

my $cg = BIOS::CreateGreen->new(dir => './output');
```

### Read a meteo station

```perl
my $os1 = $cg->read_measurements('OS1BIOS');

for my $rec ($os1->records) {
    printf "%d  T=%s  CO2=%s  PM2.5=%s\n",
        $rec->{timestamp},
        $rec->{Temperatura} // '-',
        $rec->{CO2}         // '-',
        $rec->{PM2_5}       // '-';
}
```

### Read the solar inverter

```perl
my $solax = $cg->read_measurements('SOLAXBIOS');

for my $rec ($solax->records) {
    printf "%d  grid=%s  pv1=%s  ac=%s\n",
        $rec->{timestamp},
        $rec->{Grid_power_total}           // '-',
        $rec->{Inverter_DC_PV_power_MPPT1} // '-',
        $rec->{Inverter_AC_power_total}    // '-';
}
```

### Read the monthly report

```perl
my $rpt = $cg->read_monthly_report;

for my $day ($rpt->records) {
    printf "%d  inv=%.1f kWh  exp=%.2f  imp=%.2f\n",
        $day->{timestamp},
        $day->{inverter_output_kwh}  // 0,
        $day->{exported_energy_kwh}  // 0,
        $day->{imported_energy_kwh}  // 0;
}
```

### Extract a column

```perl
my @temps = $os1->column('Temperatura');       # (22.5, 22.8, undef, ...)
my @raw   = $os1->column_raw('Temperatura');   # ('22,5', '22,8', '', ...)
```

### Time-slice

```perl
my $window = $os1->slice(1772319600, 1772323200);
printf "%d records in range\n", $window->count;
```

### Export as delimited text

```perl
# tab-separated to stdout
$os1->print_tsv;

# semicolons to a file
open my $fh, '>', 'export.csv' or die $!;
$os1->print_tsv(fh => $fh, separator => ';');
close $fh;
```

### Read everything at once

```perl
my $all = $cg->read_all;
# $all->{OS1BIOS}          -- ResultSet
# $all->{OS2BIOS}          -- ResultSet
# $all->{SOLAXBIOS}        -- ResultSet
# $all->{SOLAXBIOS_REPORT} -- ResultSet
```


## 6. Values and empty fields

The Perl module converts European comma decimals to native Perl
numbers (`22,5` becomes `22.5`).  Empty measurements become `undef`.

To access the original raw string from the file, prefix the field
name with `raw_`:

```perl
$rec->{Temperatura}       # 22.5   (number)
$rec->{raw_Temperatura}   # '22,5' (string, as in the file)
```


## 7. Running the tests

```sh
# test the export script (bash, offline, no API needed)
bash test_bios_export.sh

# test the Perl module
prove -Ilib t/
```


## 8. API details

The export script authenticates against the Mars2 REST API:

- Token endpoint: `POST /Token` (grant_type=password)
- Data endpoint: `GET /api/public/CustomDataExport/BIOS/{station_id}`
- Query params: `fromUTC`, `toUTC` (URL-encoded datetime strings)
- Response: quoted string, station ID separated by `!` from data,
  records separated by literal `0xa`

See `Mars2 REST API.html` for the full API reference.


## 9. Public dashboard

A visual representation of the data and API capabilities is available
as a live dashboard:

**https://riimak.github.io/creategreen/**

This is not part of the project scope -- it was built as a
demonstration of the Mars2 API and the data pipeline described in
this repository.  It visualises real-time measurements from all
three stations (OS1BIOS, OS2BIOS, SOLAXBIOS) using the same API
endpoints that `bios-export.sh` consumes.

The `docs/` directory is **not documentation** -- it is a single
HTML file served by GitHub Pages as the live dashboard.

### What it shows

- KPI cards: temperature, humidity, pressure, solar radiation,
  air quality (PM2.5, PM10), noise, grid power, AC output, daily energy
- Time-series charts (Chart.js): temperature/humidity, solar
  radiation, air quality, grid power/AC output, energy production
- Time range selector: 6 h / 24 h / 72 h
- Station tabs: switch between OS1 BIOS and OS2 BIOS meteo stations
- Auto-refreshes every 5 minutes

### Architecture

```
Browser (GitHub Pages)  -->  Cloudflare Worker  -->  Mars2 API
docs/index.html              worker/worker.js       :81/CustomDataExport
static, no build step        auth + parse + CORS     Bearer token auth
```

The Cloudflare Worker is a thin proxy that authenticates to the
Mars2 API using credentials stored as Worker secrets (never
exposed to the browser), fetches the raw wire-format data, and
returns clean JSON to the dashboard.

### Deploy the worker

```sh
cd worker
npx wrangler deploy
npx wrangler secret put BIOS_USERNAME
npx wrangler secret put BIOS_PASSWORD
```

### Enable GitHub Pages

In the repository settings: **Pages > Source > Deploy from branch >
`master` > `/docs`**.

See `worker/README.md` for the full worker API documentation.
