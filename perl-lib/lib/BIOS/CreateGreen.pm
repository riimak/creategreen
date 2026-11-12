package BIOS::CreateGreen;

# BIOS::CreateGreen -- read CREATEGREEN measurement files
#
# Input:  semicolon-delimited text files produced by bios-export.sh
# Output: array of hashrefs, one per measurement row
#
# Core modules only.  No CPAN dependencies.

use strict;
use warnings;
use Carp       qw(croak);
use File::Spec ();
use BIOS::CreateGreen::ResultSet;

our $VERSION = '0.03';

# ── column name tables ───────────────────────────────────────────────
# These match the header order in each file, 1:1.

my @METEO_FIELDS = qw(
    Temperatura
    Relativna_vlaznost
    Brzina_vjetra
    Smjer_vjetra
    Suncevo_zracenje
    UV_indeks
    Tlak_zraka
    Kisa
    CO  CO2  NO  NO2  O3  SO2
    PM1  PM2_5  PM10
    eaqi_traffic
    CAQI
    Buka
    cumulative
);

my @SOLAX_FIELDS = qw(
    Grid_power_total
    Grid_energy_toGrid_total
    Grid_energy_fromGrid_total
    BMS_energy_SOC
    Inverter_Meter2_AC_power_total
    Inverter_AC_EPS_power_R
    Inverter_AC_EPS_power_S
    Inverter_AC_EPS_power_T
    Inverter_DC_Battery_power_total
    Inverter_DC_PV_power_MPPT1
    Inverter_DC_PV_power_MPPT2
    Inverter_DC_PV_power_MPPT3
    Inverter_DC_PV_power_MPPT4
    Inverter_AC_power_total
    Inverter_AC_energy_out_daily
);

my @REPORT_FIELDS = qw(
    effective_ac_output_min
    total_effective_ac_output_min
    inverter_output_kwh
    exported_energy_kwh
    imported_energy_kwh
);

# Meteo stations use the 21-column layout; every other station is a solar
# plant in the 15-column SOLAXBIOS layout (SOLAXBIOS itself and the vendor
# plants SOKO46, SOKOBAZEN, VETINST that Mars2 publishes from the BIOS feed).
my %IS_METEO = map { $_ => 1 } qw(OS1BIOS OS2BIOS);

my @STATION_IDS = qw(OS1BIOS OS2BIOS SOLAXBIOS SOKO46 SOKOBAZEN VETINST);

# ── public: field name accessors ─────────────────────────────────────

sub meteo_fields  { @METEO_FIELDS  }
sub solax_fields  { @SOLAX_FIELDS  }
sub report_fields { @REPORT_FIELDS }
sub station_ids   { @STATION_IDS }
sub solar_station_ids { grep { !$IS_METEO{$_} } @STATION_IDS }

sub fields_for {
    my ($class_or_self, $station_id) = @_;
    return $IS_METEO{$station_id} ? @METEO_FIELDS : @SOLAX_FIELDS;
}

# ── constructor ──────────────────────────────────────────────────────

sub new {
    my ($class, %opts) = @_;
    my $dir = defined $opts{dir} ? $opts{dir} : '.';
    croak "BIOS::CreateGreen: directory '$dir' does not exist"
        unless -d $dir;
    return bless { dir => $dir }, $class;
}

# ── reading files ────────────────────────────────────────────────────

sub read_measurements {
    my ($self, $station_id) = @_;
    croak "station_id required" unless defined $station_id;

    my $file   = $self->_filepath(lc($station_id) . '-measurements.txt');
    my @fields = $IS_METEO{$station_id} ? @METEO_FIELDS : @SOLAX_FIELDS;

    return $self->_read($file, \@fields);
}

# Monthly report of a solar station (default SOLAXBIOS, as before 0.03):
# <station>-monthly-report.txt
sub read_monthly_report {
    my ($self, $station_id) = @_;
    $station_id = 'SOLAXBIOS' unless defined $station_id;

    my $file = $self->_filepath(lc($station_id) . '-monthly-report.txt');

    return $self->_read($file, \@REPORT_FIELDS);
}

# Everything bios-export.sh wrote into the directory: one entry per
# <station>-measurements.txt keyed by station ID, and one <STATION>_REPORT
# entry per <station>-monthly-report.txt. Stations are discovered from the
# files (the ID comes from each file's header), so a plant added to
# stations.conf shows up here without a code change.
sub read_all {
    my ($self) = @_;
    my %out;

    for my $found ($self->_station_files('measurements')) {
        $out{ $found->{station_id} } = $self->read_measurements($found->{station_id});
    }
    for my $found ($self->_station_files('monthly-report')) {
        $out{ $found->{station_id} . '_REPORT' } = $self->read_monthly_report($found->{station_id});
    }

    return \%out;
}

# ── internals ────────────────────────────────────────────────────────

# Files named <station>-<kind>.txt in the directory, with the station ID
# taken from the header line (file names are lower-cased by the exporter).
# Known stations come first in their canonical order, then any others.
sub _station_files {
    my ($self, $kind) = @_;

    opendir my $dh, $self->{dir} or croak "cannot read directory $self->{dir}: $!";
    my @names = sort grep { /\A [a-z0-9_-]+ - \Q$kind\E \.txt \z/x } readdir $dh;
    closedir $dh;

    my %rank = map { $STATION_IDS[$_] => $_ } 0 .. $#STATION_IDS;
    my @found;
    for my $name (@names) {
        my $path = File::Spec->catfile($self->{dir}, $name);
        next unless -f $path;
        open my $fh, '<', $path or next;
        my $header = <$fh>;
        close $fh;
        next unless defined $header;
        my ($sid) = split /;/, $header, 2;
        next unless defined $sid and $sid =~ /\A [A-Za-z0-9_-]+ \z/x;
        (my $stem = $name) =~ s/ - \Q$kind\E \.txt \z//x;
        next unless lc($sid) eq $stem;    # header and file name must agree
        push @found, { station_id => $sid, path => $path };
    }

    return sort {
        (exists $rank{$a->{station_id}} ? $rank{$a->{station_id}} : @STATION_IDS)
            <=> (exists $rank{$b->{station_id}} ? $rank{$b->{station_id}} : @STATION_IDS)
        or $a->{station_id} cmp $b->{station_id}
    } @found;
}

sub _filepath {
    my ($self, $name) = @_;
    my $path = File::Spec->catfile($self->{dir}, $name);
    croak "file not found: $path" unless -f $path;
    return $path;
}

sub _parse_number {
    my ($raw) = @_;
    return undef unless defined $raw and $raw ne '';
    (my $s = $raw) =~ s/,/./;
    return undef unless $s =~ /\A -? [0-9]* \.? [0-9]+ \z/x;
    return $s + 0;
}

sub _read {
    my ($self, $file, $field_names) = @_;

    open my $fh, '<', $file or croak "cannot open $file: $!";

    # first line is the header -- keep it but skip parsing
    my $header = <$fh>;
    chomp $header if defined $header;

    my @records;
    while (my $line = <$fh>) {
        chomp $line;
        next if $line eq '';

        # split preserving trailing empty fields
        my @cols = split /;/, $line, -1;

        my $sid = shift @cols;
        my $ts  = shift @cols;

        next unless defined $ts and $ts =~ /\A [0-9]+ \z/x;

        my %rec;
        $rec{station_id} = $sid;
        $rec{timestamp}  = $ts + 0;

        for my $i (0 .. $#$field_names) {
            my $raw = (defined $cols[$i]) ? $cols[$i] : '';
            $rec{ $field_names->[$i] }       = _parse_number($raw);
            $rec{ 'raw_' . $field_names->[$i] } = $raw;
        }

        push @records, \%rec;
    }
    close $fh;

    return BIOS::CreateGreen::ResultSet->new(
        header      => $header,
        field_names => [ @$field_names ],
        records     => \@records,
    );
}

1;

__END__

=head1 NAME

BIOS::CreateGreen - read CREATEGREEN / BIOS measurement files

=head1 SYNOPSIS

    use BIOS::CreateGreen;

    my $cg = BIOS::CreateGreen->new(dir => './output');

    # meteo station
    my $os1 = $cg->read_measurements('OS1BIOS');
    for my $rec ($os1->records) {
        printf "%d  T=%s  RH=%s\n",
            $rec->{timestamp},
            $rec->{Temperatura}        // '-',
            $rec->{Relativna_vlaznost} // '-';
    }

    # solar plants: SOLAXBIOS, SOKO46, SOKOBAZEN, VETINST (same 15 columns)
    my $solax = $cg->read_measurements('SOLAXBIOS');
    my $soko  = $cg->read_measurements('SOKO46');

    # monthly report (SOLAXBIOS when no station is given)
    my $rpt      = $cg->read_monthly_report;
    my $soko_rpt = $cg->read_monthly_report('SOKO46');

    # everything in the directory at once:
    # $all->{SOKO46}, $all->{SOKO46_REPORT}, ... for every station file found
    my $all = $cg->read_all;

=head1 DESCRIPTION

Parses the semicolon-delimited text files produced by C<bios-export.sh>.
European decimal commas are converted to Perl numbers; empty fields
become C<undef>.  Original raw strings available as C<raw_fieldname>.

Meteo stations (C<OS1BIOS>, C<OS2BIOS>) have 21 columns; every other
station is a solar plant with the 15-column SOLAXBIOS layout, so a plant
that is new to C<stations.conf> is read correctly without a code change.

Core modules only.  No CPAN dependencies.

=head1 SEE ALSO

L<BIOS::CreateGreen::ResultSet> - container returned by the read methods.

=cut
