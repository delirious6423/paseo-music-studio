#!/usr/bin/env bash
# Packaged-app smoke in a disposable native Incus VM (routes/env: tests/vm/incus.sh). Inside the guest only:
# extract a Paseo AppImage, run its bundled daemon with a fresh private --home and HOME, install this plug-in
# from the working tree (no node_modules), then drive Paseo's packaged web client in headless Chromium:
# first-run setup → trusted command profile (examples/tone-cli.mjs, a 2 s synthetic tone, no ML/GPU) →
# activate → generate → select the saved take → 3-take batch with prompt variations. The AppImage is copied
# in read-only and never run on the host.
# Usage: PASEO_APPIMAGE=/path/to/Paseo.AppImage tests/app/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=tests/vm/incus.sh
source "$ROOT/tests/vm/incus.sh"
: "${PASEO_APPIMAGE:?Set PASEO_APPIMAGE to a Paseo Linux x64 AppImage}"
[ -f "$PASEO_APPIMAGE" ] || { echo "Not found: $PASEO_APPIMAGE" >&2; exit 1; }
OUT=$(vm_artifact_dir app)
exec > >(tee "$OUT/runner.log") 2>&1
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  # A signal to the process group also kills the tee; keep logging (and cleaning up) without it.
  trap '' PIPE
  exec >>"$OUT/runner.log" 2>&1
  if [ -n "$VM" ] && vm_owned; then
    timeout 60 "${INCUS[@]}" file pull -r "$VM/home/tester/app-artifacts" "$OUT/" || echo "Artifacts unavailable"
  fi
  vm_cleanup | tee "$OUT/cleanup.txt" || rc=1
  echo "Artifacts: $OUT"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sha256sum "$PASEO_APPIMAGE" | tee "$OUT/appimage.sha256"
# Electron's binary links GTK/NSS even when it runs as Node.
VM_PACKAGES="nodejs npm ca-certificates curl file unzip python3 libnss3 libgtk-3-0t64 libgbm1 libasound2t64" vm_start music-app 6144 4
# What a public install gets: tracked and new (not ignored) files, no node_modules.
(cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 tar -cf - --) > "$OUT/plugin.tar"
# Pre-check only: PASEO_MUSIC_TEST_PASEO_RANGE overrides requirements.paseo in the guest copy (never the repo).
if [ -n "${PASEO_MUSIC_TEST_PASEO_RANGE:-}" ]; then
  echo "PRE-CHECK: guest manifest requirements.paseo overridden to: $PASEO_MUSIC_TEST_PASEO_RANGE"
  t=$(mktemp -d); tar -xf "$OUT/plugin.tar" -C "$t"
  python3 -I -c 'import json,sys; p=sys.argv[1]; m=json.load(open(p)); m["requirements"]["paseo"]=sys.argv[2]; json.dump(m,open(p,"w"),indent=2)' "$t/paseo-plugin.json" "$PASEO_MUSIC_TEST_PASEO_RANGE"
  tar -C "$t" -cf "$OUT/plugin.tar" . && rm -rf "$t"
fi
timeout 60 "${INCUS[@]}" file push -q "$OUT/plugin.tar" "$VM/tmp/plugin.tar"
timeout 120 "${INCUS[@]}" file push -q "$PASEO_APPIMAGE" "$VM/tmp/Paseo.AppImage"
rm -f "$OUT/plugin.tar"
# shellcheck disable=SC2016  # Expands in the guest.
timeout 60 "${INCUS[@]}" exec "$VM" -T -- bash -c 'set -e; d=/home/tester; mkdir -p $d/plugin $d/app; tar -xf /tmp/plugin.tar -C $d/plugin; mv /tmp/Paseo.AppImage $d/app/; chmod 0755 $d/app/Paseo.AppImage; chown -R tester:tester $d/plugin $d/app'
echo "VM: $VM"
timeout 1500 "${GUEST[@]}" 'bash -se' <<'TEST'
set -euo pipefail
A=~/app-artifacts; mkdir -p "$A" ~/paseo-home ~/music-out
. /etc/os-release; echo "$PRETTY_NAME $(uname -m); node $(node --version)" | tee "$A/guest.txt"
cd ~/app && ./Paseo.AppImage --appimage-extract >/dev/null
file -L squashfs-root/* | grep ELF | head -3 | tee -a "$A/guest.txt"
P=~/app/squashfs-root/resources/bin/paseo
# No speech-model downloads: the packaged daemon otherwise fetches its local dictation model on start.
echo '{"version":1,"pluginsEnabled":true,"features":{"dictation":{"enabled":false},"voiceMode":{"enabled":false}}}' > ~/paseo-home/config.json
PASEO_LISTEN=127.0.0.1:6767 PASEO_RELAY_ENABLED=false PASEO_WEB_UI_ENABLED=true \
  PASEO_WEB_UI_DIST_DIR=$HOME/app/squashfs-root/resources/app-dist \
  setsid "$P" daemon run --home ~/paseo-home > "$A/daemon.log" 2>&1 < /dev/null &
echo $! > ~/daemon.pid
stop() { "$P" daemon stop --home ~/paseo-home --force --timeout 10 >/dev/null 2>&1 || kill "$(cat ~/daemon.pid)" 2>/dev/null || true; }
trap stop EXIT
for _ in $(seq 60); do curl -sf -m 2 http://127.0.0.1:6767/api/health >/dev/null && break; sleep 1; done
curl -sf -m 5 http://127.0.0.1:6767/api/health | tee "$A/health.json"; echo
"$P" --version | tee -a "$A/guest.txt"
"$P" plugin add ~/plugin --home ~/paseo-home 2>&1 | tee "$A/plugin-add.log"
"$P" plugin ls --home ~/paseo-home 2>&1 | tee -a "$A/plugin-add.log"
mkdir -p ~/runtime && cp ~/plugin/tests/ui/runtime/package*.json ~/runtime/
(cd ~/runtime && timeout 600 npm ci --no-audit --no-fund >/dev/null && timeout 900 ./node_modules/.bin/playwright install --only-shell --with-deps chromium > "$A/browser-install.log" 2>&1)
timeout 600 node ~/plugin/tests/app/drive.mjs ~/runtime "$A" http://127.0.0.1:6767 ~/music-out ~/plugin/examples/tone-cli.mjs
TEST
echo "PASS: packaged-app smoke"
