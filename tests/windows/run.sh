#!/usr/bin/env bash
# Native Windows smoke through a trusted external Incus/SSH lifecycle helper, never on the host.
# Required helper contract: run.sh, common.sh with set_ssh/confirmed_absent, WIN_INCUS_STATE_DIR override.
# Usage: PASEO_MUSIC_WINDOWS_HELPER=/absolute/helper/directory \
#        PASEO_MUSIC_WINDOWS_GOLDEN=/absolute/golden-reference tests/windows/run.sh NODE.zip SHA256
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/tests/vm/incus.sh"
HELPER=${PASEO_MUSIC_WINDOWS_HELPER:-}
GOLDEN=${PASEO_MUSIC_WINDOWS_GOLDEN:-}
ZIP=${1:?usage: run.sh node-vXX-win-x64.zip SHA256 (from the official SHASUMS256.txt)}
SHA=${2:?supply the official SHA256 for the Node ZIP}
[[ "$HELPER" = /* && -f "$HELPER/run.sh" && -f "$HELPER/common.sh" && "$GOLDEN" = /* && -f "$GOLDEN" && ! -L "$GOLDEN" ]] || {
  echo 'BLOCKED: configure an absolute trusted Windows helper directory and a regular golden reference' >&2; exit 1;
}
[[ "$SHA" =~ ^[A-Fa-f0-9]{64}$ ]] || { echo 'Invalid SHA256' >&2; exit 2; }
for f in "$ZIP" "$ROOT/examples/tone-cli.mjs" "$ROOT/tests/command-fixture.mjs"; do
  [ -f "$f" ] && [ ! -L "$f" ] || { echo "Missing or symlinked input: $f" >&2; exit 1; }
done
printf '%s  %s\n' "$SHA" "$ZIP" | sha256sum --check --status || { echo 'Node ZIP checksum mismatch' >&2; exit 1; }
WORK=$(vm_artifact_dir windows)
STATE="$WORK/state"; mkdir -m 700 "$STATE"
export WIN_INCUS_STATE_DIR=$STATE WIN_POOL=0
exec > >(tee "$WORK/runner.log") 2>&1
cleanup() {
  local rc=$? name=""
  trap - EXIT INT TERM
  trap '' PIPE
  exec >>"$WORK/runner.log" 2>&1
  [ ! -f "$STATE/run" ] || read -r name _ < "$STATE/run"
  if timeout 180 bash "$HELPER/run.sh" --stop; then
    if [ -z "$name" ] || ( source "$HELPER/common.sh" && confirmed_absent "$name" ); then
      echo "PASS: Windows cleanup (${name:-no run created}) confirmed absent" | tee "$WORK/cleanup.txt"
      rm -rf "$STATE"
    else echo "FAIL: Windows cleanup; retained $name and $STATE" | tee "$WORK/cleanup.txt"; rc=1; fi
  else echo "FAIL: Windows helper stop; retained $STATE" | tee "$WORK/cleanup.txt"; rc=1; fi
  echo "Artifacts: $WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp --no-preserve=mode "$GOLDEN" "$STATE/golden"; chmod 600 "$STATE/golden"
timeout 60 "$ROOT/node_modules/.bin/esbuild" "$ROOT/tests/native/smoke.ts" --bundle --platform=node \
  --format=esm --target=node22 --outfile="$WORK/smoke.mjs" --log-level=warning
timeout 1200 bash "$HELPER/run.sh"
read -r NAME _ < "$STATE/run"
source "$HELPER/common.sh"
set_ssh "$NAME"
HOSTPART=${SSH[-1]}
SCP=(scp -q -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5)
timeout 60 "${SSH[@]}" 'New-Item -ItemType Directory -Force C:\smoke\root\examples,C:\smoke\root\tests | Out-Null'
timeout 300 "${SCP[@]}" "$ZIP" "$HOSTPART:C:/smoke/node.zip"
timeout 60 "${SCP[@]}" "$WORK/smoke.mjs" "$HOSTPART:C:/smoke/smoke.mjs"
timeout 60 "${SCP[@]}" "$ROOT/examples/tone-cli.mjs" "$HOSTPART:C:/smoke/root/examples/tone-cli.mjs"
timeout 60 "${SCP[@]}" "$ROOT/tests/command-fixture.mjs" "$HOSTPART:C:/smoke/root/tests/command-fixture.mjs"
timeout 300 "${SSH[@]}" '$ErrorActionPreference="Stop"; Expand-Archive -Force C:\smoke\node.zip C:\smoke\node; $n=(Get-ChildItem C:\smoke\node\*\node.exe).FullName; & $n --version; & $n -p process.arch; (Get-CimInstance Win32_OperatingSystem).Caption; (Get-CimInstance Win32_OperatingSystem).Version; $env:PROCESSOR_ARCHITECTURE'
timeout 300 "${SSH[@]}" '$env:PASEO_MUSIC_VM="1"; $n=(Get-ChildItem C:\smoke\node\*\node.exe).FullName; & $n C:\smoke\smoke.mjs C:\smoke\root win32 x64; exit $LASTEXITCODE'
