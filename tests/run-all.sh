#!/usr/bin/env bash
# Runs every check: version consistency, unit tests, lint, HTML validation and the browser tests in
# Chromium, Firefox and WebKit. Usage, from anywhere:
#   tests/run-all.sh                 # all browsers
#   BROWSERS="chromium" tests/run-all.sh
#   PERF=1 tests/run-all.sh          # also run the performance benchmark
# Needs Node ≥ 18, Python 3 and playwright-cli (npm i -g @playwright/cli) with its browsers installed
# (playwright-cli install-browser firefox / webkit). The a11y test loads axe-core from cdnjs.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSERS="${BROWSERS:-chromium firefox webkit}"
E2E="core storage a11y"; [ "${PERF:-0}" = "1" ] && E2E="$E2E perf"
FAIL=0
step() { printf '\n== %s\n' "$1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

step "version consistency"
V_APP=$(sed -n 's/.*version: "\([0-9.]*\)".*/\1/p' "$ROOT/app.js" | head -1)
V_CFF=$(sed -n 's/^version: //p' "$ROOT/CITATION.cff")
V_HTML=$(grep -o '?v=[0-9.]*' "$ROOT/index.html" | sort -u | tr '\n' ' ')
echo "app.js $V_APP · CITATION.cff $V_CFF · index.html $V_HTML"
[ "$V_APP" = "$V_CFF" ] && [ "$V_HTML" = "?v=$V_APP " ] || bad "versions differ (bump all three together; index.html ?v= busts browser caches)"

step "unit tests"
(cd "$ROOT" && node --test tests/) >/tmp/morphotrace-unit.$$ 2>&1 && grep -E '^ℹ (pass|fail)' /tmp/morphotrace-unit.$$ || { cat /tmp/morphotrace-unit.$$; bad "unit tests"; }
rm -f /tmp/morphotrace-unit.$$

step "ESLint"
(cd "$ROOT" && npx --yes eslint@9.39.1 .) && echo "clean" || bad "eslint"

step "HTML validation"
(cd "$ROOT" && npx --yes html-validate@9.5.5 index.html) && echo "clean" || bad "html-validate"

step "browser tests"
PORT=$((20000 + RANDOM % 20000))
(cd "$ROOT" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER=$!
WORK=$(mktemp -d)  # playwright-cli writes snapshots and downloads to its working directory
trap 'kill $SERVER 2>/dev/null; for b in $BROWSERS; do (cd "$WORK" && playwright-cli -s="mt-$b" close >/dev/null 2>&1); done; rm -rf "$WORK"' EXIT
sleep 1
for b in $BROWSERS; do
  (cd "$WORK" && playwright-cli -s="mt-$b" open --browser="$b" "http://127.0.0.1:$PORT/" >/dev/null 2>&1) || { bad "$b: could not open (playwright-cli install-browser $b?)"; continue; }
  for t in $E2E; do
    out=$(cd "$WORK" && playwright-cli -s="mt-$b" goto "http://127.0.0.1:$PORT/" >/dev/null 2>&1; playwright-cli -s="mt-$b" --raw run-code --filename="$ROOT/tests/e2e/$t.e2e.js" 2>&1)
    summary=$(printf '%s' "$out" | node -e '
      let s = require("fs").readFileSync(0, "utf8").trim();
      try { let r = JSON.parse(s); if (typeof r === "string") r = JSON.parse(r);
        if (Array.isArray(r)) { console.log(`${r.length} passed, 0 failed`); process.exit(0); }
        console.log(`${r.passed} passed, ${r.failed} failed`);
        for (const c of r.results.filter((c) => !c.ok)) console.log(`    ✗ ${c.check} — ${c.detail}`);
        process.exit(r.failed ? 1 : 0);
      } catch (e) { console.log("error: " + s.split("\n").slice(0, 6).join(" ")); process.exit(1); }')
    status=$?
    printf '%-9s %-8s %s\n' "$b" "$t" "$summary"
    [ $status -eq 0 ] || bad "$b $t"
  done
done

printf '\n'; [ $FAIL -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $FAIL
