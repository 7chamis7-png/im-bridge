#!/usr/bin/env bash
# Gate tests: one process per file; each file reports and sets its own exit code.
cd "$(dirname "$0")/.." || exit 1
out="$(mktemp -t im-bridge-gate-test.XXXXXX)"
trap 'rm -f "$out"' EXIT
ok=0; bad=""
for f in test/gate/*.js; do
  if timeout 90 node "$f" >"$out" 2>&1; then ok=$((ok+1));
  else bad="$bad $f"; echo "=== FAILED: $f"; tail -20 "$out"; fi
done
total=$(ls test/gate/*.js | wc -l)
echo "gate tests: passed $ok / $total"
[ -z "$bad" ] || { echo "failed:$bad"; exit 1; }
