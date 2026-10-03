#!/usr/bin/env bash
# Headless regression test for the Always visible userscript.
#
# Loads index.html in headless Firefox twice -- once plain, once with
# always-visible.user.js inlined (headless has no userscript manager) -- and
# checks that with the script active every breakage check still passes and
# nothing detects the script, except the documented worker-tick ceilings
# (~16ms timer resolution and the extra dispatcher stack frames).
#
# The page beacons each result to the local server as GET /report?<msg>
# (see index.html), so we read results straight from the server log; no browser
# automation protocol needed. GAP/leak probes need a real backgrounded tab and
# cannot fire headless, so they are not asserted here.
set -euo pipefail
cd "$(dirname "$0")"

command -v firefox >/dev/null || { echo "firefox required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 required"; exit 1; }

port=${PORT:-8765}
wait_s=${WAIT:-10}
work=$(mktemp -d)
srv=
cleanup() { [[ -n $srv ]] && kill "$srv" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

cp index.html "$work/base.html"
python3 - "$work/with.html" <<'PY'
import sys
html = open('index.html').read()
us = open('always-visible.user.js').read()
# Run the userscript before the page's own script, as @run-at document-start would.
html = html.replace('<meta charset="utf-8">',
                    '<meta charset="utf-8">\n<script>' + us + '</script>', 1)
open(sys.argv[1], 'w').write(html)
PY

serve() { ( cd "$work" && exec python3 -m http.server "$port" ) >"$1" 2>&1 & srv=$!; sleep 1; }
stop()  { kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null || true; srv=; }
visit() {
  local prof; prof=$(mktemp -d)
  firefox --headless --no-remote --profile "$prof" "http://localhost:$port/$1.html" >/dev/null 2>&1 &
  local ff=$!; sleep "$wait_s"; kill "$ff" 2>/dev/null; wait "$ff" 2>/dev/null || true
  rm -rf "$prof"
}

echo "running (with script)..."; serve "$work/with.log"; visit with; stop
echo "running (no script)...";   serve "$work/base.log"; visit base; stop

python3 - "$work/with.log" "$work/base.log" <<'PY'
import sys, re, urllib.parse

def msgs(path):
    out = []
    for l in open(path, errors='replace'):
        m = re.search(r'GET /report\?(\S+)', l)
        if m:
            out.append(urllib.parse.unquote(m.group(1)))
    return out

with_m, base_m = msgs(sys.argv[1]), msgs(sys.argv[2])

# Detections inherent to driving timers off a Worker; see the ponytail note in
# always-visible.user.js. Everything else detecting the script is a failure.
CEILING = re.compile(r'callback has \d+ frames|averages [\d.]+ms')

fails = [m for m in with_m if m.startswith('CHECK FAIL')]
dets  = [m for m in with_m if m.startswith('DETECTED:') and not CEILING.search(m)]
passes = sum(m.startswith('CHECK PASS') for m in with_m)
base_fails = [m for m in base_m if m.startswith('CHECK FAIL')]

# Suppression: every swallowed event must PASS with the script and FAIL without it
# (a PASS without the script means the test didn't actually fire the event).
sw_fail_with = [m for m in with_m if m.startswith('SWALLOW FAIL')]
sw_pass_base = [m for m in base_m if m.startswith('SWALLOW PASS')]
sw_total = sum(m.startswith('SWALLOW ') for m in with_m)

errs = []
if passes < 20:
    errs.append(f'only {passes} checks ran with the script -- page did not load?')
if sw_total < 5:
    errs.append(f'only {sw_total} suppression checks ran -- page did not load?')
for m in fails:        errs.append('breakage: ' + m)
for m in dets:         errs.append('detected: ' + m)
for m in sw_fail_with: errs.append('not suppressed with script: ' + m)
for m in base_fails:   errs.append('baseline breakage (no script): ' + m)
for m in sw_pass_base: errs.append('suppressed without script (test lacks teeth): ' + m)

if errs:
    print('FAIL')
    for e in errs: print('  ' + e)
    sys.exit(1)
print(f'PASS ({passes} checks, {sw_total} suppressions, only documented ceilings detected)')
PY
