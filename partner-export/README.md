# Partner Export

Novi Sad / partner export tooling for BIOS Mars2 data.

This area contains the scripts and column specs used to fetch BIOS measurements
from Mars2 and produce the ASCII semicolon files required by the partner data
contract.

## Run

From the repository root:

```sh
bash bios-export.sh fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00"
bash bios-export.sh report --month 2026-03
```

Or directly:

```sh
bash partner-export/bios-export.sh fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00" -o output
```

## Files

- `bios-export.sh` fetches measurements and generates monthly reports.
- `bios-cron.sh` refreshes the rolling 72-hour export and one monthly report per solar station (output defaults to `output/` next to the scripts; override with `BIOS_OUTPUT_DIR`).
- `stations.conf` lists the stations to pull (`ID|layout`, layouts `meteo` and `solar`).
- `test_bios_export.sh` validates output format offline.
- `specs/` contains the expected export column layouts.

## Stations

The scripts mirror what the partner pulls from Mars2: every station in
`stations.conf` is fetched as `CustomDataExport/BIOS/<ID>` and written in the
layout named on its line. `bash bios-export.sh stations` prints the active
list. Agreed scope:

| Station | Layout | Status |
| --- | --- | --- |
| `OS1BIOS` | meteo | Mars2 has returned no rows since 2026-04-29; kept until the source is fixed or retired |
| `OS2BIOS` | meteo | active |
| `SOLAXBIOS` (BIOS CREATEGREEN, Solax) | solar | active |
| `SOKO46` (SC Soko 46 kWp, Huawei) | solar | active since 2026-11-12 (Mars2 polls the BIOS feed API, `docs/mars2/feed-contract.md`) |
| `SOKOBAZEN` (SC SOKO Bazen 275.4 kWp, Huawei) | solar | active since 2026-11-12 |
| `VETINST` (Veterinarski Institut, Solis) | solar | active since 2026-11-12 |
| `Solarman` (Dvorana Kulturnog centra) | solar | disabled: the plant exists in Mars2 but none of its variables has a `CustomExport` position, so the export is empty |

The four solar stations share one column layout, the one specified in
`specs/solaxbios-measurements.txt`; the station ID in column 1 and in the
file name (`soko46-measurements.txt`, ...) tells them apart. Vendor plants
publish every 5 minutes; columns a vendor does not provide (battery, EPS,
per-MPPT DC power) stay empty, the same as for `SOLAXBIOS`.

A station that returns no rows for the whole window is logged as a warning
(the file keeps only its header); when every requested station is empty,
`fetch` exits 2 so cron logs show it. The monthly report works for any
`solar` station (`report --month YYYY-MM --station SOKO46`) and
`bios-cron.sh` produces one per solar station.

## File format (what the partner receives)

Measurement files: first line is the header (`ID;TIMESTAMP;<column names>`),
then one record per line, `ID;UNIX_TIMESTAMP;v1;...;vN`, fields separated by
`;`, unix EOL (`0x0a`), decimal comma, empty field = no measurement, ASCII.
Values are passed through from Mars2 untouched. The file holds exactly the
window asked for (`--from` .. `--to`, both inclusive, UTC): Mars2 has been
seen to read `fromUTC`/`toUTC` as Croatian local time, so the tool requests
two hours more on each side and drops the rows outside the window.

Monthly report: one row per UTC day, timestamp = that day at 00:00:00 UTC,
rows outside the month are ignored. Columns:

| Column | Rule |
| --- | --- |
| Effective AC Output Time (min) | minutes with `Inverter.AC.power.total` > 0, counted between consecutive samples at most 10 min apart; one decimal |
| Total Effective AC Output Time (min) | running total of the printed day values; one decimal |
| Inverter output (kWh) | last `Inverter.AC.energy.out.daily` of the day; two decimals; empty when the day has no value (Mars2 writes the SOLAXBIOS daily value once a day at 22:00 UTC) |
| Exported energy (kWh) | increase of `Grid.energy.toGrid.total` over the day; two decimals |
| Imported energy (kWh) | increase of `Grid.energy.fromGrid.total` over the day; two decimals |

The two energy columns come from cumulative meter registers: the increase is
summed between consecutive samples and a decrease is treated as a meter
reset and not counted (SOLAXBIOS reset `fromGrid` on 2026-11-02 and `toGrid`
on 2026-11-06; a plain last-minus-first would print -815 and -9013 kWh).
