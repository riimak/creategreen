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
my $os1 = $cg->read_measurements('OS1BIOS');
```
