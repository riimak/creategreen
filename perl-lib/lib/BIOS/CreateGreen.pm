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

our $VERSION = '0.02';

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

my %IS_METEO = map { $_ => 1 } qw(OS1BIOS OS2BIOS);

# ── public: field name accessors ─────────────────────────────────────

sub meteo_fields  { @METEO_FIELDS  }
sub solax_fields  { @SOLAX_FIELDS  }
sub report_fields { @REPORT_FIELDS }
sub station_ids   { qw(OS1BIOS OS2BIOS SOLAXBIOS) }

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

sub read_monthly_report {
    my ($self) = @_;

    my $file = $self->_filepath('solaxbios-monthly-report.txt');

    return $self->_read($file, \@REPORT_FIELDS);
}

sub read_all {
    my ($self) = @_;
    my %out;

    for my $sid ($self->station_ids) {
        my $path = File::Spec->catfile(
            $self->{dir}, lc($sid) . '-measurements.txt'
        );
        next unless -f $path;
        $out{$sid} = $self->read_measurements($sid);
    }

    my $rpt = File::Spec->catfile($self->{dir}, 'solaxbios-monthly-report.txt');
    if (-f $rpt) {
        $out{SOLAXBIOS_REPORT} = $self->read_monthly_report;
    }

    return \%out;
}

# ── internals ────────────────────────────────────────────────────────

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

    # solar inverter
    my $solax = $cg->read_measurements('SOLAXBIOS');

    # monthly report
    my $rpt = $cg->read_monthly_report;

    # everything at once
    my $all = $cg->read_all;

=head1 DESCRIPTION

Parses the semicolon-delimited text files produced by C<bios-export.sh>.
European decimal commas are converted to Perl numbers; empty fields
become C<undef>.  Original raw strings available as C<raw_fieldname>.

Core modules only.  No CPAN dependencies.

=head1 SEE ALSO

L<BIOS::CreateGreen::ResultSet> - container returned by the read methods.

=cut
