#!/usr/bin/env bash
# Headless regression test for the Always visible userscript.
#
# Two passes, both loading index.html with always-visible.user.js inlined
# (headless browsers have no userscript manager) and reading results from the
# beacons the page sends as GET /report?<msg> (see index.html):
#
#   1. Foreground (Firefox): every breakage check passes and nothing detects the
#      script, except the documented worker-tick ceilings (~16ms timer
#      resolution and the extra dispatcher stack frames). Suppression checks pass
#      with the script and fail without it.
#   2. Backgrounded (Chromium, via cdp-background.js): with the tab genuinely
#      hidden, the fakes hold -- no visibility/focus leak, no frame leak, no
#      timer/rAF throttle. The no-script baseline must fire those detections, so
#      the pass can't go green vacuously. Skipped if chromium or node is absent.
set -euo pipefail
cd "$(dirname "$0")"

command -v firefox >/dev/null || { echo "firefox required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 required"; exit 1; }

wait_s=${WAIT:-10}
bg_hold=${BG_HOLD:-9000}
work=$(mktemp -d)
srv=
cleanup() {
  [[ -n ${srv:-} ]] && kill "$srv" 2>/dev/null || true
  pkill -9 -f "$work" 2>/dev/null || true
  rm -rf "$work" || true
  return 0
}
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

serve() { ( cd "$work" && exec python3 -m http.server "$1" ) >"$2" 2>&1 & srv=$!; sleep 1; }
stop()  { [[ -n $srv ]] && kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null || true; srv=; }

# --- Pass 1: foreground, Firefox ---
visit_fg() {
  local prof; prof="$work/ff-$1"; mkdir -p "$prof"
  firefox --headless --no-remote --profile "$prof" "http://localhost:8765/$1.html" >/dev/null 2>&1 &
  local ff=$!; sleep "$wait_s"; kill "$ff" 2>/dev/null || true; wait "$ff" 2>/dev/null || true
}
echo "running (firefox, foreground, with script)..."; serve 8765 "$work/with.log"; visit_fg with; stop
echo "running (firefox, foreground, no script)...";   serve 8765 "$work/base.log"; visit_fg base; stop

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
    print('FAIL (foreground)')
    for e in errs: print('  ' + e)
    sys.exit(1)
print(f'PASS foreground ({passes} checks, {sw_total} suppressions, only documented ceilings detected)')
PY

# --- Pass 2: backgrounded, Chromium ---
if command -v chromium >/dev/null && command -v node >/dev/null; then
  visit_bg() { # $1 page  $2 logfile  $3 httpport  $4 debugport
    serve "$3" "$2"
    local prof="$work/cr-$1"; mkdir -p "$prof"
    chromium --headless=new --no-sandbox --disable-gpu \
      --remote-debugging-port="$4" --user-data-dir="$prof" \
      "http://localhost:$3/$1.html?rvfc=1" >/dev/null 2>&1 &
    disown "$!" 2>/dev/null || true  # we stop it with pkill below; don't let job control print "Killed"
    sleep 2.5
    node ./cdp-background.js "$4" "$bg_hold" >/dev/null 2>&1 || true
    pkill -9 -f "$prof" 2>/dev/null || true
    stop
  }
  echo "running (chromium, backgrounded, with script)..."; visit_bg with "$work/bgwith.log" 8775 9341
  echo "running (chromium, backgrounded, no script)...";   visit_bg base "$work/bgbase.log" 8776 9342

  python3 - "$work/bgwith.log" "$work/bgbase.log" <<'PY'
import sys, re, urllib.parse

def msgs(path):
    out = []
    for l in open(path, errors='replace'):
        m = re.search(r'GET /report\?(\S+)', l)
        if m:
            out.append(urllib.parse.unquote(m.group(1)))
    return out

bgw, bgb = msgs(sys.argv[1]), msgs(sys.argv[2])
CEILING = re.compile(r'callback has \d+ frames|averages [\d.]+ms')

# With the script, a genuinely hidden tab must leak nothing and not be throttled.
# (GAP lines are documented browser-driven paths a page script can't cover; not asserted.)
leaks = [m for m in bgw if m.startswith('DETECTED:') and not CEILING.search(m)]
status = [m for m in bgw if m.startswith('STATUS')]
# The fakes should keep reporting visible even while hidden.
held = any('hidden=false' in s and 'visibilityState=visible' in s for s in status)
# Baseline: the same probes must fire when hidden and unprotected (proves teeth).
base_leaks = [m for m in bgb if m.startswith('DETECTED:')]

errs = []
if not status:
    errs.append('no STATUS beacon with script -- page did not load?')
elif not held:
    errs.append('fakes did not hold while backgrounded: ' + status[-1])
for m in leaks:
    errs.append('leak while backgrounded (with script): ' + m)
if len(base_leaks) < 3:
    errs.append(f'baseline backgrounded fired only {len(base_leaks)} detections -- backgrounding failed?')

if errs:
    print('FAIL (backgrounded)')
    for e in errs: print('  ' + e)
    sys.exit(1)
print(f'PASS backgrounded (fakes held hidden; {len(base_leaks)} leaks detected in baseline)')
PY
else
  echo "skip: chromium + node not found, backgrounded pass skipped"
fi

exit 0
