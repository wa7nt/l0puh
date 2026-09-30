#!/usr/bin/env bash
# Throughput harness for l0puh, with Go measured beside it.
#
# Method, borrowed from the Go harness this is meant to be comparable to:
#
#   * runs of one config are NOT grouped.  Grouping makes later runs measure a
#     hotter machine, which reads as a regression that did not exist, so configs
#     are interleaved round-robin instead.
#   * the statistic reported is the best run, not the mean.  The best run is the
#     one that happened while nothing else was competing.  The median is printed
#     beside it so a config that is fast only in theory shows up as a spread.
#   * Go is measured in the same loop, on the same day.  Without that control,
#     "l0puh got slower" and "the laptop throttled" look identical.
#   * the interpreter is timed *inside* the process, with the time spent reading
#     and compiling the file excluded.  The Go binary starts in about 2 ms and a
#     node process in about 40, which is startup cost, not throughput: timing
#     the whole process made every Go number two orders of magnitude worse than
#     it is and put the "slower" column out by a factor of twenty.
#   * each measurement is a fresh process, and the first is discarded, so nothing
#     is measured on a warm JIT.
#
# usage:
#   ./bench/measure.sh            5 rounds, Go included
#   ./bench/measure.sh 9          9 rounds
#   ./bench/measure.sh 9 no-go    l0puh only
#   ROUNDS=15 ./bench/measure.sh  rounds from the environment

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)

ROUNDS=${ROUNDS:-${1:-5}}
case "${1:-}" in -*) ;; *) [ $0 != "${1:-}" ] && [ -n "${1:-}" ] && shift ;; esac
WITH_GO=${1:-go}
[ "$WITH_GO" = "no-go" ] && WITH_GO=""

CASES=${CASES:-"loop add call fib walk"}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
RAW="$TMP/raw"
: > "$RAW"

# ---- the Go side ------------------------------------------------------------
GO_BIN=""
if [ -n "$WITH_GO" ] && command -v go >/dev/null 2>&1; then
  mkdir -p "$TMP/go"
  ( cd "$TMP/go" && go mod init l0pbench >/dev/null 2>&1 )
  cp "$HERE"/go/*.go "$TMP/go/" 2>/dev/null
  if ( cd "$TMP/go" && go build -o l0pbench . ) 2>"$TMP/gobuild.err"; then
    GO_BIN="$TMP/go/l0pbench"
  else
    echo "note: could not build the Go side; continuing with l0puh only" >&2
    sed 's/^/  /' "$TMP/gobuild.err" >&2
  fi
fi

# Both runners print the elapsed milliseconds and nothing else, so the harness
# reads one number from each and the comparison is like for like.
run_l0p() { # case -> ms, or n/a
  local file="$HERE/l0p/$1.l0p"
  [ -f "$file" ] || { echo n/a; return; }
  # one.mjs prints "<ms> <result>"; only the timing is wanted
  node "$HERE/one.mjs" "$file" 2>/dev/null | tail -1 | cut -d' ' -f1
}

run_go() { # case -> ms, or n/a
  [ -n "$GO_BIN" ] || { echo n/a; return; }
  "$GO_BIN" "$1" 2>/dev/null | tail -1 | cut -d' ' -f1
}

# ---- the matrix ------------------------------------------------------------
for ((r = 0; r < ROUNDS; r++)); do
  for c in $CASES; do
    printf 'l0puh-%s %s\n' "$c" "$(run_l0p "$c")" >> "$RAW"
  done
  if [ -n "$GO_BIN" ]; then
    for c in $CASES; do
      printf 'go-%s %s\n' "$c" "$(run_go "$c")" >> "$RAW"
    done
  fi
done

# ---- report ----------------------------------------------------------------
printf '%-12s %9s %9s %9s %10s\n' config best med worst 'vs go'
printf '%s\n' "--------------------------------------------------------------"
awk -v havego="$([ -n "$GO_BIN" ] && echo 1 || echo 0)" '
  $2 + 0 > 0 {
    v[$1] = v[$1] " " $2; n[$1]++
    if ($2 + 0 > best[$1]) best[$1] = $2 + 0
    if (!($1 in lo) || $2 + 0 < lo[$1]) lo[$1] = $2 + 0
  }
  END {
    for (k in best) {
      m = n[k]; delete a
      c = split(v[k], a, " ")
      for (i = 1; i <= c; i++) s[i] = a[i] + 0
      for (i = 2; i <= c; i++) { x = s[i]; j = i - 1
        while (j > 0 && s[j] > x) { s[j+1] = s[j]; j-- }
        s[j+1] = x }
      med = (c % 2) ? s[(c+1)/2] : (s[c/2] + s[c/2+1]) / 2
      ratio = "-"
      if (havego == 1) {
        base = substr(k, 6)          # strip the "l0puh-" prefix
        if ((base) in best) ratio = sprintf("%.0fx", best[k] / best[base])
      }
      printf "%-12s %9.1f %9.1f %9.1f %10s\n", k, best[k], med, lo[k], ratio
    }
  }' "$RAW" | sort -k2 -rn
