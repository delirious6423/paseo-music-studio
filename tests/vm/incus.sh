# shellcheck shell=bash
# Disposable native Incus VM for this project's tests. Source it, then: vm_start <tag> <MiB> <CPUs>.
# Sets INCUS (client argv), VM (instance name) and GUEST (argv that runs a shell command as user "tester").
# vm_owned checks this run's ownership; vm_cleanup releases only what this run owns and verifies it.
#
# Routes (never a host or container fallback):
#   default  cold VM via the stock `incus` CLI: init → install VM_PACKAGES → test → delete + verify gone.
#            PASEO_MUSIC_INCUS_PROJECT (default "default"), _PROFILE (default "default"; needs a root disk and
#            NIC), _IMAGE (default images:ubuntu/26.04/cloud). Ownership = a random token in user.paseo-music.token.
#   helper   PASEO_MUSIC_INCUS_HELPER=/path/to/lib.sh reuses an existing lifecycle library that provides
#            incus_vm_start/incus_vm_owned/incus_vm_delete (e.g. a warm snapshot pool). Its own ownership checks apply.
VM_PACKAGES="${VM_PACKAGES:-}"
VM="" GUEST=() _VM_TOKEN="" _VM_ROUTE=""

# `incus query` takes the project in the URL, not --project; exit 0 = exists, 3 = confirmed absent, 1 = unknown.
_vm_exists() {
    local out
    out=$(timeout 15 incus --force-local query "/1.0/instances/$1?project=${PASEO_MUSIC_INCUS_PROJECT:-default}" 2>&1) && return 0
    [[ "$out" == *"Instance not found"* ]] && return 3
    echo "$out" >&2; return 1
}

_vm_blocked() { echo "BLOCKED: $*" >&2; return 1; }

vm_start() {
    local tag=$1 mem=$2 cpus=$3
    [[ "$tag" =~ ^[a-z][a-z0-9-]{0,20}$ && "$mem" =~ ^[0-9]+$ && "$cpus" =~ ^[0-9]+$ ]] || return 2
    command -v incus >/dev/null || _vm_blocked "incus CLI not found; install Incus (https://linuxcontainers.org/incus/)" || return 1
    if [ -n "${PASEO_MUSIC_INCUS_HELPER:-}" ]; then
        [ -f "$PASEO_MUSIC_INCUS_HELPER" ] || _vm_blocked "PASEO_MUSIC_INCUS_HELPER not found: $PASEO_MUSIC_INCUS_HELPER" || return 1
        _VM_ROUTE=helper
        # shellcheck source=/dev/null
        source "$PASEO_MUSIC_INCUS_HELPER"
        INCUS_PACKAGES="$VM_PACKAGES" incus_vm_start "$tag" "$mem" "$cpus" || return 1
        VM=$INCUS_VM
        incus_vm_owned || _vm_blocked "helper VM $VM is not owned by this run" || return 1
        return 0
    fi
    _VM_ROUTE=portable
    INCUS=(incus --force-local --project "${PASEO_MUSIC_INCUS_PROJECT:-default}")
    timeout 15 "${INCUS[@]}" info >/dev/null 2>&1 ||
        _vm_blocked "cannot reach the Incus daemon/project (need incus-admin group membership and an existing project)" || return 1
    [[ "$VM_PACKAGES" =~ ^[a-z0-9][a-z0-9+.:=\ -]*$|^$ ]] || return 2
    read -r _VM_TOKEN < /proc/sys/kernel/random/uuid
    VM="pm-$tag-${_VM_TOKEN:0:8}"
    echo "Creating VM $VM (project ${PASEO_MUSIC_INCUS_PROJECT:-default})" >&2
    timeout 600 "${INCUS[@]}" init "${PASEO_MUSIC_INCUS_IMAGE:-images:ubuntu/26.04/cloud}" "$VM" --vm \
        -p "${PASEO_MUSIC_INCUS_PROFILE:-default}" -c "limits.memory=${mem}MiB" -c "limits.cpu=$cpus" \
        -c "user.paseo-music.token=$_VM_TOKEN" || return 1
    timeout 120 "${INCUS[@]}" start "$VM" || return 1
    local end=$((SECONDS + 180))
    until timeout 10 "${INCUS[@]}" exec "$VM" -T -- true >/dev/null 2>&1; do
        [ "$SECONDS" -lt "$end" ] || { echo "VM agent timeout: $VM" >&2; return 1; }
        sleep 1
    done
    timeout 900 "${INCUS[@]}" exec "$VM" -T --env "PKGS=$VM_PACKAGES" -- bash -se <<'SETUP' || return 1
set -eu
rc=0; cloud-init status --wait >/dev/null || rc=$?
[ "$rc" = 0 ] || [ "$rc" = 2 ]
export DEBIAN_FRONTEND=noninteractive
if [ -n "$PKGS" ]; then
    apt-get -o DPkg::Lock::Timeout=120 update -q
    apt-get -o DPkg::Lock::Timeout=120 install -yq $PKGS </dev/null
fi
id tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
printf '%s\n' 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/paseo-music-test
chmod 440 /etc/sudoers.d/paseo-music-test
SETUP
    # shellcheck disable=SC2034  # Used by callers.
    GUEST=("${INCUS[@]}" exec "$VM" -T -- runuser -l tester -c)
}

vm_owned() {
    [ -n "$VM" ] || return 1
    if [ "$_VM_ROUTE" = helper ]; then incus_vm_owned; return; fi
    [ -n "$_VM_TOKEN" ] && [ "$(timeout 15 "${INCUS[@]}" config get "$VM" user.paseo-music.token 2>/dev/null)" = "$_VM_TOKEN" ]
}

# Prints "PASS: ..." or "FAIL: ..." and returns accordingly. Never deletes by name alone.
vm_cleanup() {
    [ -n "$VM" ] || return 0
    local name=$VM rc
    if [ "$_VM_ROUTE" = helper ]; then
        if incus_vm_delete; then echo "PASS: VM cleanup ($INCUS_MODE): $name"; VM=""; return 0; fi
        echo "FAIL: VM cleanup: $name"; return 1
    fi
    if ! vm_owned; then
        rc=0; _vm_exists "$name" || rc=$?
        [ "$rc" != 3 ] || { echo "PASS: VM never created: $name"; VM=""; return 0; }
        echo "FAIL: refusing to delete $name: token mismatch or unknown state"; return 1
    fi
    timeout 120 "${INCUS[@]}" delete "$name" --force || { echo "FAIL: VM delete: $name"; return 1; }
    rc=0; _vm_exists "$name" || rc=$?
    [ "$rc" = 3 ] || { echo "FAIL: VM still present or state unknown after delete: $name"; return 1; }
    echo "PASS: VM deleted and verified absent: $name"
    VM=""
}

# Artifacts/caches: explicit PASEO_MUSIC_TEST_DIR, else $DATA_DIR or the XDG cache, never the repository.
vm_artifact_dir() {
    local base="${PASEO_MUSIC_TEST_DIR:-${DATA_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/paseo-music-tests}"
    mkdir -p "$base" && mktemp -d "$base/$1-$(date +%Y%m%d-%H%M%S)-XXXX"
}
