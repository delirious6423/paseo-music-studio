# Testing and acceptance

Application, integration and UI tests run in **owned disposable native VMs**, not on the everyday
host. Synthetic engines exercise the actual controller, library and download code without weights
or GPU access. Static checks may run on the host. No runner silently falls back to host execution.

## Current evidence: 0.5.1

| Check | Result and scope |
| --- | --- |
| Focused Linux x64 core | **42/42 PASS**, no failures/skips: commands, MiniMax adapter/formats, progress, storage and batch files; typecheck passed. |
| Linux x64 follow-up | **16/16 PASS**, no failures/skips: commands and progress after final parser/timer refinements, including freezing the run clock before a slow save. |
| Component UI | **PASS**: 390×844 light-phone and 1280×1000 dark-desktop flows, fresh MiniMax captures and the final corrected-field/error-clearing regression. |
| SDK compatibility | Strict TypeScript checks passed against Paseo SDK 0.12 and 0.13. This is not packaged-app or OS acceptance. |
| Cleanup | Owned Linux guests were reset/returned to their warm pool, with PASS cleanup receipts. |

The core runs **overlap**: they are not 58 unique tests or a final full-suite run. They used native
Ubuntu 26.04.1 x86_64 and Node.js 22.22.1. UI evidence used Chromium headless shell 156.0.8078.4.
The final UI pass followed fixture refresh/wording corrections; earlier unsuccessful attempts are
not acceptance evidence. Private machine names and artifact paths are intentionally not published.

Covered regressions include independent seeds above 32 bits, fractional requested duration, native
batches, long replay codes passed through an owned file rather than argv, recovery/cancellation,
MP3/WAV16/WAV24/float-WAV32 storage and MIME, exact playback assembly, HTTP attachments and mixed ZIP
names. New measured duration is separate from requested settings; old tracks are not rewritten.
Progress uses actual stage counters, not an invented overall percentage. UI checks cover wrong-model
recipe reuse, visible replay mode, native workload totals, scoped errors and cancelled hidden transfers.

A user-initiated five-take MiniMax batch was observed completing in real use. That is **not** a
controlled GPU/performance/quality benchmark, formal encoder audibility check or portable acceptance
result. Structural MP3 fixtures validate framing and transfer, not decoder quality or musical output.

## Platform and runtime matrix

| Target/layer | 0.5.1 status | Historical evidence, not a substitute |
| --- | --- | --- |
| Native Linux x64 core + component UI | **PASS**, focused scope above | Earlier 0.4.0 core suite: 85/85 passed. |
| Native Windows x64 | **NOT RUN** for 0.5.1 | 0.5.0 focused smoke: 22 assertions passed, with cleanup; not real MiniMax inference or GUI acceptance. |
| Native Linux ARM64 | **BLOCKED** on native VM resource access/capacity | 0.2.0 pre-batch smoke: 11 assertions passed, with cleanup. |
| Native Windows ARM64 | **BLOCKED** on native VM resource access/ownership | 0.2.0 pre-batch smoke: 11 assertions passed, with cleanup. |
| Native macOS ARM64 | **BLOCKED** on native VM resource access/capacity | 0.2.0 pre-batch smoke: 11 assertions passed, with cleanup. |
| Actual packaged Paseo daemon + web client | **NOT RUN** for 0.5.1 | 0.4.0 with Paseo 0.13.0: 15 steps passed, including diagnostic tones, batch/reconnect, large audio assembly, guest-LAN ZIP and trash. |
| Electron window shell, physical phone, actual encrypted relay | **NOT VALIDATED** | Component viewports and local packaged-web checks do not establish these. |
| Formal real-engine GPU / audio-quality acceptance | **NOT VALIDATED** | The observed real batch is not a controlled acceptance suite. |

Documentation-only changes do not require an app-platform rerun: **NOT APPLICABLE** when executable
behavior is unchanged. Functional changes should report each applicable target honestly, including
blocked routes; do not describe static checks or x64 emulation as native ARM acceptance.

## Run checks

From a source checkout, install the locked development dependencies and run static checks:

```bash
npm ci --ignore-scripts
npm run typecheck -- --noUnusedLocals --noUnusedParameters
git diff --check
```

On a configured Linux host with native Incus VM access:

```bash
npm test
```

To rerun only affected files:

```bash
npm test -- tests/commands.test.ts tests/minimax-progress.test.ts
```

| Check | Controller command | Execution location |
| --- | --- | --- |
| Integration | `npm test` / `tests/vm/run.sh` | Disposable native Incus VM |
| Component UI/screenshots | `tests/ui/run.sh` | Disposable native Incus VM |
| Refresh base screenshots | `tests/ui/run.sh --update-assets` | Guest render; copy reviewed assets only after assertions and cleanup pass |
| Packaged app | `PASEO_APPIMAGE=/absolute/path/Paseo.AppImage tests/app/run.sh` | AppImage extracted and daemon/web client run only in the guest |
| Interrupted-run cleanup | `node tests/vm/signal.mjs` | Host orchestrates and interrupts its owned guest runner; no host app launch |

Runners copy source and installed dependencies, not `.git`, credentials, the user's home, GPU or audio
devices; they do not expose writable host mounts. Core runs request 4 GiB/four CPUs; UI/app runs
request 6 GiB/four CPUs. Missing isolation stops with `BLOCKED` and a nonzero exit.

For an independently provisioned disposable VM, copy only source/locked dependencies and run
`npm run typecheck` followed by `npm run test:integration` **inside that guest**. A private IPv4
interface is needed for real guest-LAN download coverage. Collect artifacts and destroy only your
owned guest afterward. That guest command is not permission to run fixture servers on the host.

## Linux VM configuration

The default lifecycle uses [Incus](https://linuxcontainers.org/incus/) from the Linux Containers
project. Incus daemon administration is root-equivalent. It creates a token-owned native VM;
the first image download and package installation use the configured public image/package sources.
No separate private lifecycle repository is required.

| Environment variable | Default / purpose |
| --- | --- |
| `PASEO_MUSIC_INCUS_PROJECT` | `default`; an existing VM-capable project |
| `PASEO_MUSIC_INCUS_PROFILE` | `default`; needs a root disk and NIC |
| `PASEO_MUSIC_INCUS_IMAGE` | `images:ubuntu/26.04/cloud`; cached by Incus after download |
| `PASEO_MUSIC_TEST_DIR` | Explicit artifact location; otherwise `paseo-music-tests` under `DATA_DIR`, then the XDG cache / `~/.cache` |
| `PASEO_MUSIC_INCUS_HELPER` | Optional existing lifecycle library exporting `incus_vm_start`, `incus_vm_owned`, `incus_vm_delete`; replaces the cold route, for example with a resettable warm pool |

Cold cleanup verifies ownership, deletes its VM and confirms absence. Warm-helper cleanup can reset
and return the owned slot rather than delete it. Read `cleanup.txt`: a failure means a retained
resource, even if assertions passed. Never delete a VM by an assumed name or claim another run's
resource. `tests/vm/signal.mjs` checks cleanup when a runner/logging pipe is interrupted.

## What screenshots establish

`tests/ui/run.sh` bundles `index.client.tsx` and the real Studio components for react-native-web,
using the SDK RPC provider with schema-validated synthetic answers. Settings and host UI helpers
are fixture stand-ins. The guest installs its locked UI runtime and Playwright browser/dependencies
from npm, the Playwright CDN and guest package sources, then serves on guest loopback.

Assertions include requests/state changes, validation, playback assembly boundaries, selection and
cancellation, no page/console errors and no horizontal overflow. Screenshots are **component-fixture
evidence**, not the packaged loader, native mobile UI, audible output or physical phones.
See [screenshot provenance](SCREENSHOTS.md) for image-by-image scope. `--update-assets` updates the
base desktop/phone images; additional state captures remain in artifacts until explicitly reviewed.

`tests/app/run.sh` instead runs a real packaged Paseo daemon/web build in a fresh guest home with
relay/dictation/voice services disabled. Its diagnostic-tone generator needs no model weights. It
reaches the local playback boundary and verifies bytes, but does not launch the Electron window shell.
The bundled packaged screenshot is **historical 0.4.0**, not current 0.5.1 MiniMax evidence.

A guest-only `PASEO_MUSIC_TEST_PASEO_RANGE` override exists for compatibility investigation. It is
labelled PRE-CHECK and must be unset for acceptance with the actual manifest. Do not infer a wider
supported Paseo range from an override run.

## Windows and other native guests

`tests/windows/run.sh NODE.zip SHA256` uses an official native Windows x64 Node ZIP with its verified
checksum. It bundles controller/library code and runs only in a disposable native Windows guest.
It needs existing trusted lifecycle infrastructure, not credentials committed to this repository:

- `PASEO_MUSIC_WINDOWS_HELPER`: absolute directory with `run.sh` and `common.sh`.
- `PASEO_MUSIC_WINDOWS_GOLDEN`: regular file holding that helper's golden reference.
- Helper contract: `run.sh` starts and `run.sh --stop` removes only its owned run; `common.sh` exposes
  `set_ssh`, `SSH`, `KEY`, `confirmed_absent`; respect private `WIN_INCUS_STATE_DIR` and `WIN_POOL=0`.

The focused smoke covers command/library/batch/ZIP/trash/worker cleanup, not Windows GUI, owner-death,
GPU or phone acceptance. Missing configuration fails closed; no helper or Windows image is bundled.

For your own isolated native ARM/macOS runner, bundle `tests/native/smoke.ts` as Node ESM with esbuild.
Copy it plus `examples/tone-cli.mjs` and `tests/command-fixture.mjs`, preserving those relative paths,
into the guest. With a native Node runtime, **in the guest only**, set `PASEO_MUSIC_VM=1` and run
`node smoke.mjs FIXTURE_ROOT PLATFORM ARCH`. Do not copy credentials or use another session's VM.

## Reporting results

Record version/revision, native OS/architecture, runtime, exact command, PASS/FAIL/BLOCKED scope,
artifact location and cleanup outcome. Label focused reruns, fixtures, historical results and live
observations separately. Sanitize shared logs/screenshots: no private paths, host names, prompts,
music or live bearer URLs. Do not publish/push, change firewall/settings or reload a live installation
as a side effect of testing. See [contributor guidance](../CONTRIBUTING.md).
