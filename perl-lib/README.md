# BIOS Perl Parser

Reusable Perl parser for BIOS export files produced by `partner-export/`.

## Test

```sh
prove -Iperl-lib/lib perl-lib/t/
```

## Usage

```perl
use lib 'perl-lib/lib';
use BIOS::CreateGreen;

my $cg = BIOS::CreateGreen->new(dir => 'output');
my $os1  = $cg->read_measurements('OS1BIOS');   # meteo, 21 columns
my $soko = $cg->read_measurements('SOKO46');    # solar plant, 15 columns (as SOLAXBIOS)
my $rpt  = $cg->read_monthly_report('SOKO46');  # default station: SOLAXBIOS
my $all  = $cg->read_all;   # every <station>-measurements.txt and <STATION>_REPORT found in the directory
```

Stations: `OS1BIOS`, `OS2BIOS` (meteo) and `SOLAXBIOS`, `SOKO46`, `SOKOBAZEN`,
`VETINST` (solar). Any other station file is read with the solar layout.
