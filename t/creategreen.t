#!/usr/bin/env perl
# t/creategreen.t -- tests for BIOS::CreateGreen
use strict;
use warnings;
use Test::More;
use File::Temp  qw(tempdir);
use File::Spec;
use FindBin     qw($RealBin);

use lib File::Spec->catdir($RealBin, '..', 'lib');

use_ok('BIOS::CreateGreen');
use_ok('BIOS::CreateGreen::ResultSet');

# ── fixture files ────────────────────────────────────────────────────

my $dir = tempdir(CLEANUP => 1);

write_file($dir, 'os1bios-measurements.txt',
    "OS1BIOS;TIMESTAMP;Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative\n",
    "OS1BIOS;1772319601;22,5;65;3,2;180;450;5;1013,2;0;0,1;400;5;10;60;2;8;12;25;35;2;45;3\n",
    "OS1BIOS;1772319901;22,8;64;3,5;185;460;5;1013,1;0;0,1;402;5;10;58;2;8;11;24;34;2;46;3\n",
    "OS1BIOS;1772320201;;65;;;450;5;1013,0;0;;;;;;;;;;;;\n",
);

write_file($dir, 'os2bios-measurements.txt',
    "OS2BIOS;TIMESTAMP;Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative\n",
    "OS2BIOS;1772319601;23,1;60;2,8;190;440;4;1012,8;0,5;0,2;410;6;11;55;3;9;13;26;36;3;50;4\n",
);

write_file($dir, 'solaxbios-measurements.txt',
    "SOLAXBIOS;TIMESTAMP;Grid.power.total;Grid.energy.toGrid.total;Grid.energy.fromGrid.total;BMS.energy.SOC;Inverter.Meter2.AC.power.total;Inverter.AC.EPS.power.R;Inverter.AC.EPS.power.S;Inverter.AC.EPS.power.T;Inverter.DC.Battery.power.total;Inverter.DC.PV.power.MPPT1;Inverter.DC.PV.power.MPPT2;Inverter.DC.PV.power.MPPT3;Inverter.DC.PV.power.MPPT4;Inverter.AC.power.total;Inverter.AC.energy.out.daily\n",
    "SOLAXBIOS;1772319601;-19,468;288;17838;;;;;;;;;;;0;91239,4\n",
    "SOLAXBIOS;1772319901;-19,2;288;17840;;;;;;;;;;;0;91239,4\n",
    "SOLAXBIOS;1772320201;-20,256;288;17841;;;;;;;;;;;0;91239,4\n",
    "SOLAXBIOS;1772320501;-15,8;288;17843;;;;;;;;;;;0;91239,4\n",
);

write_file($dir, 'solaxbios-monthly-report.txt',
    "SOLAXBIOS;TIMESTAMP;Effective AC Output Time (min);Total Effective AC Output Time (min);Inverter output (kWh);Exported energy (kWh);Imported energy (kWh)\n",
    "SOLAXBIOS;1772323200;15,0;15,0;6,0;0,9;0,6\n",
    "SOLAXBIOS;1772409600;5,0;20,0;4,0;0,5;0,3\n",
);


# ── basics ───────────────────────────────────────────────────────────

my $cg = BIOS::CreateGreen->new(dir => $dir);
isa_ok($cg, 'BIOS::CreateGreen');

is_deeply(
    [ $cg->station_ids ],
    [ qw(OS1BIOS OS2BIOS SOLAXBIOS) ],
    'station_ids',
);

is(scalar $cg->meteo_fields,  21, '21 meteo fields');
is(scalar $cg->solax_fields,  15, '15 solax fields');
is(scalar $cg->report_fields,  5, '5 report fields');
is_deeply(
    [ $cg->fields_for('OS1BIOS') ],
    [ $cg->meteo_fields ],
    'fields_for(OS1BIOS) = meteo',
);
is_deeply(
    [ $cg->fields_for('SOLAXBIOS') ],
    [ $cg->solax_fields ],
    'fields_for(SOLAXBIOS) = solax',
);


# ── OS1BIOS ──────────────────────────────────────────────────────────

subtest 'OS1BIOS' => sub {
    my $rs = $cg->read_measurements('OS1BIOS');
    isa_ok($rs, 'BIOS::CreateGreen::ResultSet');
    is($rs->count, 3, '3 records');

    my @ts = $rs->timestamps;
    is($ts[0], 1772319601, 'first timestamp');
    is($ts[2], 1772320201, 'last timestamp');

    # parsed numeric values (comma → dot)
    my @t = $rs->column('Temperatura');
    is($t[0], 22.5,  'Temperatura comma→dot');
    is($t[1], 22.8,  'Temperatura second row');
    is($t[2], undef, 'Temperatura empty→undef');

    # raw strings preserved
    my @raw = $rs->column_raw('Temperatura');
    is($raw[0], '22,5', 'raw keeps comma');
    is($raw[2], '',     'raw empty stays empty');

    # spot checks
    my $r = ($rs->records)[0];
    is($r->{Relativna_vlaznost}, 65,     'Relativna_vlaznost');
    is($r->{Tlak_zraka},        1013.2,  'Tlak_zraka');
    is($r->{CO2},               400,     'CO2');
    is($r->{Buka},              45,      'Buka');
    is($r->{cumulative},        3,       'cumulative');

    # sparse row
    my $r3 = ($rs->records)[2];
    is($r3->{Brzina_vjetra},     undef, 'sparse: empty→undef');
    is($r3->{Relativna_vlaznost}, 65,   'sparse: non-empty ok');
};


# ── OS2BIOS ──────────────────────────────────────────────────────────

subtest 'OS2BIOS' => sub {
    my $rs = $cg->read_measurements('OS2BIOS');
    is($rs->count, 1, '1 record');
    my $r = ($rs->records)[0];
    is($r->{station_id},  'OS2BIOS', 'station_id in record');
    is($r->{Temperatura}, 23.1,      'Temperatura');
    is($r->{Kisa},        0.5,       'Kisa');
};


# ── SOLAXBIOS ────────────────────────────────────────────────────────

subtest 'SOLAXBIOS' => sub {
    my $rs = $cg->read_measurements('SOLAXBIOS');
    is($rs->count, 4, '4 records');
    is(scalar $rs->field_names, 15, '15 field names');

    my @gp = $rs->column('Grid_power_total');
    is($gp[0], -19.468, 'negative value');
    is($gp[3], -15.8,   'last value');

    my $r = ($rs->records)[0];
    is($r->{BMS_energy_SOC},              undef,   'empty→undef');
    is($r->{Inverter_AC_power_total},     0,       'zero is zero');
    is($r->{Inverter_AC_energy_out_daily}, 91239.4, 'big number');

    my @raw = $rs->column_raw('Inverter_AC_energy_out_daily');
    is($raw[0], '91239,4', 'raw comma format');
};


# ── monthly report ───────────────────────────────────────────────────

subtest 'report' => sub {
    my $rs = $cg->read_monthly_report;
    is($rs->count, 2, '2 day-rows');

    my @d = $rs->records;
    is($d[0]->{timestamp},                     1772323200, 'day 1 ts');
    is($d[0]->{effective_ac_output_min},       15.0,       'day 1 ac min');
    is($d[0]->{total_effective_ac_output_min}, 15.0,       'day 1 cumul');
    is($d[0]->{inverter_output_kwh},           6.0,        'day 1 inv');
    is($d[0]->{exported_energy_kwh},           0.9,        'day 1 exp');
    is($d[0]->{imported_energy_kwh},           0.6,        'day 1 imp');

    is($d[1]->{effective_ac_output_min},       5.0,  'day 2 ac min');
    is($d[1]->{total_effective_ac_output_min}, 20.0, 'day 2 cumul');
    is($d[1]->{inverter_output_kwh},           4.0,  'day 2 inv');
    is($d[1]->{exported_energy_kwh},           0.5,  'day 2 exp');
    is($d[1]->{imported_energy_kwh},           0.3,  'day 2 imp');

    is_deeply(
        [ $rs->column('inverter_output_kwh') ],
        [ 6.0, 4.0 ],
        'column extraction',
    );
};


# ── slice ────────────────────────────────────────────────────────────

subtest 'slice' => sub {
    my $rs  = $cg->read_measurements('OS1BIOS');
    my $sub = $rs->slice(1772319601, 1772319902);
    is($sub->count, 2, '2 in range');
    is(($sub->records)[0]->{timestamp}, 1772319601, 'lower bound');
    is(($sub->records)[1]->{timestamp}, 1772319901, 'upper bound');

    is($rs->slice(9999999999, 9999999999)->count, 0, 'empty slice');
};


# ── print_tsv ────────────────────────────────────────────────────────

subtest 'print_tsv' => sub {
    my $rs = $cg->read_measurements('OS2BIOS');

    # capture to a string via an in-memory filehandle
    my $buf = '';
    open my $fh, '>', \$buf or die $!;
    $rs->print_tsv(fh => $fh);
    close $fh;

    my @lines = split /\n/, $buf;
    is(scalar @lines, 2, 'header + 1 data line');
    like($lines[0], qr/^station_id\t/, 'tab separated header');

    # semicolon separator
    $buf = '';
    open $fh, '>', \$buf or die $!;
    $rs->print_tsv(fh => $fh, separator => ';');
    close $fh;
    like($buf, qr/^station_id;/, 'custom separator');
};


# ── read_all ─────────────────────────────────────────────────────────

subtest 'read_all' => sub {
    my $all = $cg->read_all;
    is(ref $all, 'HASH', 'hashref');
    ok(exists $all->{OS1BIOS},          'has OS1BIOS');
    ok(exists $all->{OS2BIOS},          'has OS2BIOS');
    ok(exists $all->{SOLAXBIOS},        'has SOLAXBIOS');
    ok(exists $all->{SOLAXBIOS_REPORT}, 'has SOLAXBIOS_REPORT');
    is($all->{OS1BIOS}->count, 3,       'OS1BIOS count');
};


# ── errors ───────────────────────────────────────────────────────────

subtest 'errors' => sub {
    eval { BIOS::CreateGreen->new(dir => '/no/such/dir') };
    like($@, qr/does not exist/, 'bad dir croaks');

    eval { $cg->read_measurements('BOGUS') };
    like($@, qr/file not found/, 'missing file croaks');
};


done_testing();

# ── helper ───────────────────────────────────────────────────────────

sub write_file {
    my ($dir, $name, @lines) = @_;
    my $path = File::Spec->catfile($dir, $name);
    open my $fh, '>', $path or die "cannot write $path: $!";
    print $fh @lines;
    close $fh;
}
