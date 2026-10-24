#!/usr/bin/env bash
# Typecheck + integration tests in a disposable native Incus VM (see tests/vm/incus.sh for routes/env).
# Copies only the working tree (no .git) and the installed node_modules; no host home, credentials or mounts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=tests/vm/incus.sh
source "$ROOT/tests/vm/incus.sh"
[ -d "$ROOT/node_modules" ] || { echo "Run npm ci first (dependencies are copied into the VM)" >&2; exit 1; }
# Optional explicit files keep regression reruns focused; no arbitrary shell arguments reach the guest.
RUN_TESTS='npm run test:integration'
if [ "$#" -gt 0 ]; then
  for f in "$@"; do [[ "$f" =~ ^tests/[a-zA-Z0-9._-]+\.test\.ts$ && -f "$ROOT/$f" ]] || { echo "Invalid test file: $f" >&2; exit 2; }; done
  RUN_TESTS="./node_modules/.bin/tsx --test $*"
fi
OUT=$(vm_artifact_dir integration)
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  vm_cleanup | tee "$OUT/cleanup.txt" || rc=1
  echo "Artifacts: $OUT"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
VM_PACKAGES="nodejs npm python3 unzip" vm_start music-plugin 4096 4
tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=.serena -cf "$OUT/source.tar" .
tar -C "$ROOT" -cf "$OUT/deps.tar" node_modules
timeout 60 "${INCUS[@]}" file push -q "$OUT/source.tar" "$VM/tmp/music-source.tar"
timeout 60 "${INCUS[@]}" file push -q "$OUT/deps.tar" "$VM/tmp/music-deps.tar"
rm -f "$OUT/source.tar" "$OUT/deps.tar"
timeout 60 "${INCUS[@]}" exec "$VM" -T -- bash -c 'mkdir -p /home/tester/music; tar -xf /tmp/music-source.tar -C /home/tester/music; tar -xf /tmp/music-deps.tar -C /home/tester/music; chown -R tester:tester /home/tester/music'
echo "VM: $VM; command: npm run typecheck && $RUN_TESTS"
timeout 300 "${GUEST[@]}" "cd /home/tester/music && . /etc/os-release && echo \"\$PRETTY_NAME \$(uname -m)\" && node --version && npm run typecheck && $RUN_TESTS" 2>&1 | tee "$OUT/test.log"
