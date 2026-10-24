#!/usr/bin/env bash
# Studio component-fixture screenshots in a disposable native Incus VM (routes/env: tests/vm/incus.sh).
# Everything that renders or downloads runs in the guest: npm ci of tests/ui/runtime, Playwright's headless
# Chromium (+ its apt deps), the esbuild bundle and a loopback-only server. The host copies files in/out only.
# Usage: tests/ui/run.sh [--update-assets]   (copies the PNGs to assets/ after all assertions pass)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=tests/vm/incus.sh
source "$ROOT/tests/vm/incus.sh"
UPDATE=0
for a in "$@"; do case "$a" in --update-assets) UPDATE=1 ;; *) echo "usage: $0 [--update-assets]" >&2; exit 2 ;; esac; done
[ -d "$ROOT/node_modules" ] || { echo "Run npm ci first (dependencies are copied into the VM)" >&2; exit 1; }
OUT=$(vm_artifact_dir ui)
exec > >(tee "$OUT/runner.log") 2>&1
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  # A signal to the process group also kills the tee; keep logging (and cleaning up) without it.
  trap '' PIPE
  exec >>"$OUT/runner.log" 2>&1
  if [ -n "$VM" ] && vm_owned; then
    timeout 60 "${INCUS[@]}" file pull -r "$VM/home/tester/ui-artifacts" "$OUT/" || echo "Artifacts unavailable"
  fi
  vm_cleanup | tee "$OUT/cleanup.txt" || rc=1
  if [ "$rc" = 0 ] && [ "$UPDATE" = 1 ]; then
    cp "$OUT/ui-artifacts/studio-desktop.png" "$OUT/ui-artifacts/studio-phone.png" "$ROOT/assets/" && echo "Updated assets/"
  fi
  echo "Artifacts: $OUT"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$ROOT/assets"
VM_PACKAGES="nodejs npm ca-certificates" vm_start music-ui 6144 4
tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=.serena --exclude=assets -cf "$OUT/source.tar" .
tar -C "$ROOT" -cf "$OUT/deps.tar" node_modules
timeout 60 "${INCUS[@]}" file push -q "$OUT/source.tar" "$VM/tmp/music-source.tar"
timeout 60 "${INCUS[@]}" file push -q "$OUT/deps.tar" "$VM/tmp/music-deps.tar"
rm -f "$OUT/source.tar" "$OUT/deps.tar"
timeout 60 "${INCUS[@]}" exec "$VM" -T -- bash -c 'mkdir -p /home/tester/music; tar -xf /tmp/music-source.tar -C /home/tester/music; tar -xf /tmp/music-deps.tar -C /home/tester/music; chown -R tester:tester /home/tester/music'
echo "VM: $VM"
timeout 1500 "${GUEST[@]}" 'bash -se' <<'TEST'
set -euo pipefail
. /etc/os-release; echo "$PRETTY_NAME $(uname -m); node $(node --version)"
mkdir -p ~/runtime ~/ui-artifacts
cp ~/music/tests/ui/runtime/package*.json ~/runtime/
cd ~/runtime
if [ -f package-lock.json ]; then timeout 600 npm ci --no-audit --no-fund; else timeout 600 npm install --no-audit --no-fund; cp package-lock.json ~/ui-artifacts/; fi
timeout 900 ./node_modules/.bin/playwright install --only-shell --with-deps chromium > ~/ui-artifacts/browser-install.log 2>&1 || { tail -20 ~/ui-artifacts/browser-install.log; exit 1; }
cd ~/music
timeout 300 node tests/ui/shoot.mjs ~/runtime ~/ui-artifacts
TEST
echo "PASS: component-fixture screenshots"
