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
- `bios-cron.sh` refreshes the rolling 72-hour export and one monthly report per solar station.
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
| `SOLAXBIOS` | solar | active |
| `SOKO46BIOS` (SC Soko 46 kWp, Huawei) | solar | commented out until its Mars2 device exists (`docs/mars2/feed-contract.md`) |
| `SOKOBAZENBIOS` (SC SOKO Bazen 275.4 kWp, Huawei) | solar | same |
| `VETINSTBIOS` (Veterinarski Institut, Solis) | solar | same |

A station that returns no rows for the whole window is logged as a warning
(the file keeps only its header); when every requested station is empty,
`fetch` exits 2 so cron logs show it. The monthly report works for any
`solar` station (`report --month YYYY-MM --station SOKO46BIOS`).
