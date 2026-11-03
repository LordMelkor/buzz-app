#!/usr/bin/env bash
# Runs a CI download command up to TRIES times, ending any try that outlasts
# SECONDS. Hermit's first call to a tool fetches it, and that fetch can stall
# until the job's timeout or drop mid-transfer.
set -uo pipefail

if [[ "$#" -lt 3 || ! "$1" =~ ^[1-9][0-9]*$ || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 TRIES SECONDS COMMAND [ARG...]" >&2
  exit 2
fi
tries="$1"
seconds="$2"
shift 2

# timeout(1) is missing on macOS runners; perl is in every runner image.
# A try runs in its own process group. At the deadline the group gets TERM,
# then KILL once the command exits or 5 s pass, whichever comes first, so no
# straggler keeps the output open. A try that runs out of time exits 124, like
# timeout(1).
bounded() {
  perl -e '
    my $limit = shift;
    my $pid = fork;
    die "fork: $!\n" unless defined $pid;
    if (!$pid) {
      setpgrp(0, 0);
      exec { $ARGV[0] } @ARGV;
      print STDERR "$ARGV[0]: $!\n";
      exit 127;
    }
    setpgrp($pid, $pid);
    my $expired = 0;
    $SIG{ALRM} = sub {
      if ($expired++) { kill "KILL", -$pid } else { kill "TERM", -$pid; alarm 5 }
    };
    alarm $limit;
    waitpid $pid, 0;
    my $status = $?;
    alarm 0;
    if ($expired) {
      kill "KILL", -$pid;
      print STDERR "$ARGV[0] did not finish within $limit s\n";
      exit 124;
    }
    exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
  ' "$seconds" "$@"
}

for ((try = 1; ; try++)); do
  bounded "$@" && exit 0
  rc=$?
  if ((try >= tries)); then
    exit "$rc"
  fi
  echo "::warning::$1 failed with exit $rc; starting try $((try + 1)) of $tries"
done
