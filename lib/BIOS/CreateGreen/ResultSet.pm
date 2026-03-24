package BIOS::CreateGreen::ResultSet;

# Simple container for parsed measurement records.
# Returned by BIOS::CreateGreen->read_measurements() et al.

use strict;
use warnings;
use Carp qw(croak);

# ── constructor ──────────────────────────────────────────────────────

sub new {
    my ($class, %args) = @_;
    return bless {
        header      => $args{header},
        field_names => $args{field_names} || [],
        records     => $args{records}     || [],
    }, $class;
}

# ── accessors ────────────────────────────────────────────────────────

sub header      { return $_[0]->{header} }
sub field_names { return @{ $_[0]->{field_names} } }
sub records     { return @{ $_[0]->{records} } }
sub count       { return scalar @{ $_[0]->{records} } }

sub timestamps {
    return map { $_->{timestamp} } @{ $_[0]->{records} };
}

# ── column extraction ────────────────────────────────────────────────

sub column {
    my ($self, $name) = @_;
    croak "column name required" unless defined $name;
    return map { $_->{$name} } @{ $self->{records} };
}

sub column_raw {
    my ($self, $name) = @_;
    croak "column name required" unless defined $name;
    my $key = 'raw_' . $name;
    return map { defined $_->{$key} ? $_->{$key} : '' } @{ $self->{records} };
}

# ── filtering ────────────────────────────────────────────────────────

sub slice {
    my ($self, $from_ts, $to_ts) = @_;
    my @subset = grep {
        $_->{timestamp} >= $from_ts && $_->{timestamp} < $to_ts
    } @{ $self->{records} };

    return (ref $self)->new(
        header      => $self->{header},
        field_names => $self->{field_names},
        records     => \@subset,
    );
}

# ── export ───────────────────────────────────────────────────────────

sub print_tsv {
    my ($self, %opts) = @_;
    my $fh  = $opts{fh}        || \*STDOUT;
    my $sep = $opts{separator} || "\t";

    my @names = $self->field_names;

    print $fh join($sep, 'station_id', 'timestamp', @names), "\n";

    for my $r (@{ $self->{records} }) {
        print $fh join($sep,
            $r->{station_id},
            $r->{timestamp},
            map { defined $r->{$_} ? $r->{$_} : '' } @names
        ), "\n";
    }

    return;
}

1;

__END__

=head1 NAME

BIOS::CreateGreen::ResultSet - container for parsed CREATEGREEN records

=head1 METHODS

=over 4

=item B<count>()

Number of data records.

=item B<records>()

List of hashrefs.  Each has C<station_id>, C<timestamp>, plus one
key per measurement field (numeric, C<undef> if empty) and
C<raw_fieldname> (original string from the file).

=item B<timestamps>()

List of unix timestamps (integers).

=item B<column>($name)

Extract a single measurement as a list.  C<undef> for missing values.

=item B<column_raw>($name)

Same, but returns the original raw strings (comma decimals, empty strings).

=item B<slice>($from_ts, $to_ts)

Returns a new ResultSet with only records where
C<$from_ts <= timestamp < $to_ts>.

=item B<print_tsv>(fh => \*STDOUT, separator => "\t")

Write records as delimited text to a filehandle.
Defaults to tab-separated on STDOUT.

    $rs->print_tsv;                           # to STDOUT
    $rs->print_tsv(fh => $fh);               # to a file
    $rs->print_tsv(separator => ';');         # semicolons

=back

=cut
