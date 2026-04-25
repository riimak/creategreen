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
- `bios-cron.sh` refreshes the rolling 72-hour export and monthly report.
- `test_bios_export.sh` validates output format offline.
- `specs/` contains the expected export column layouts.
