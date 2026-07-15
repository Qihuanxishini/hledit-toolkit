#!/usr/bin/env bash
set -euo pipefail

HLEDIT_BIN="${HLEDIT_BIN:-hledit}"
WORKDIR="$(mktemp -d)"
cd "$WORKDIR"

say() {
  printf '\n\033[1;36m# %s\033[0m\n' "$*"
  sleep 1.6
}

run() {
  printf '\n\033[1;32m$ %s\033[0m\n' "$*"
  sleep 1.0
  eval "$@"
  sleep 1.6
}

clear
say "hledit: hash-anchored edits for collaborative agents"

cat > app.go <<'EOF'
package main

func greet() {
    println("hello")
}
EOF

run "cat app.go"

say "Agent reads file and gets LN#ANCHOR references"
run "$HLEDIT_BIN read app.go"

ANCHOR="$($HLEDIT_BIN read app.go | awk '/hello/{print $1}' | tr -d ':')"
printf '\nSaved anchor for target line: %s\n' "$ANCHOR"
sleep 1.6

say "Meanwhile, another agent or human edits the same line"
python3 - <<'PY'
from pathlib import Path
p = Path('app.go')
s = p.read_text()
s = s.replace('    println("hello")', '    println("hello from teammate")')
p.write_text(s)
PY
run "cat app.go"

say "Original agent tries stale anchored edit"
printf '\n\033[1;32m$ printf ... | hledit replace app.go %s -\033[0m\n' "$ANCHOR"
sleep 1.0
printf '    println("hello from agent")\n' | "$HLEDIT_BIN" replace app.go "$ANCHOR" -
sleep 1.6

say "File unchanged: stale edit failed loud, not silent"
run "cat app.go"

say "Agent re-reads, gets fresh anchor, then applies edit"
run "$HLEDIT_BIN read app.go"
FRESH="$($HLEDIT_BIN read app.go | awk '/teammate/{print $1}' | tr -d ':')"
printf '\nFresh anchor: %s\n' "$FRESH"
sleep 1.6
printf '\n\033[1;32m$ printf ... | hledit replace app.go %s -\033[0m\n' "$FRESH"
sleep 1.0
printf '    println("hello from agent")\n' | "$HLEDIT_BIN" replace app.go "$FRESH" -
sleep 1.6

say "Final file"
run "cat app.go"

say "Takeaway: shared edit coordinates let stale collaborative edits fail safely"
sleep 2.4
