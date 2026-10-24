# Contributing

This project is experimental. Keep changes small, preserve completed music and add a regression
test for behavior changes. Do not bundle model weights, generated music, credentials or machine
logs in contributions.

## Source layout

| Path | Responsibility |
| --- | --- |
| `index.client.tsx`, `client/` | Paseo registrations, React Native studio and download onboarding |
| `index.server.ts`, `server/controller.ts` | RPC handlers and owned-engine lifecycle |
| `server/guard.ts` | Child-engine watchdog |
| `server/library.ts` | Validated UUID library, atomic saves and recoverable deletion |
| `server/downloads.ts`, `server/download-routes.ts` | Scoped temporary downloads and route validation |
| `shared/music.ts` | Zod schemas, settings and typed RPC contracts |
| `tests/` | Synthetic engine fixtures and integration regressions |
| `tests/vm/run.sh` | Maintainer's disposable native Linux VM controller |

Follow the current [Paseo plug-in reference](https://paseo.sh/docs/plugins/reference.md).
Client code must use host theme colors and React Native primitives. No Node imports in client
or shared modules; no client imports in server code. Keep filesystem paths and process control
on the server. Do not bypass validation at RPC, filesystem or network boundaries.

## Static checks

From the checkout:

```bash
npm ci --ignore-scripts
npm run typecheck -- --noUnusedLocals --noUnusedParameters
git diff --check
```

These do not launch the engine or load models. The latest application checks used Node.js 22.22.1.

## Integration tests: use a disposable VM

Tests launch synthetic child engines, bind sockets and write fixture files. Run them inside a
throwaway native VM, not your everyday desktop. No real weights or GPU are needed.

The portable `npm test` wrapper uses stock Incus, a configured VM-capable project/profile and an
image available to that daemon. It fails closed if isolation is unavailable. Project, profile,
image and artifact paths are configurable; [docs/TESTING.md](docs/TESTING.md) documents the optional
external warm-pool adapter. No private sibling repository is required for the default route.

On a configured Linux/Incus host:

```bash
npm test
```

The wrapper allocates a disposable Linux x64 VM (4 GiB RAM, four CPUs), copies source and installed
dependencies without home/credentials/host mounts, runs typecheck and the integration suite, and
checks cleanup. It does not launch real music models.

For an independently provisioned disposable VM, transfer only source and its locked dependencies.
Install development dependencies inside that VM if needed. Run **in the guest**:

```bash
npm run typecheck
npm run test:integration
```

Destroy the test-owned VM after collecting results. Do not interpret the guest command as
permission to run fixture processes on the host. Ensure the guest has a private IPv4 LAN interface:
one acceptance test verifies a real HTTP attachment over that guest interface, not just loopback.

Coverage includes child ownership and parent death, abort/stop races, failed-save recovery,
library traversal/symlink safety, download expiry and attachment bytes, explicit download consent,
private-route validation, no discovery-time listener, and network-change cleanup.

## Acceptance and reporting

- State OS/architecture, exact command, results, limitations and cleanup status.
- Do not infer native OS, GPU or phone support from compilation or synthetic Linux tests.
- Real engine/GPU, desktop interaction and physical phone tests need a separately scoped plan and
  explicit host-test approval in the maintainer workflow. Never silently fall back from a blocked VM.
- Keep the test report current without personal host names, identifiers, live URLs or private paths.
- Use [the backend contract](docs/BACKENDS.md) when adding model integrations. Preserve legacy
  settings and tracks, and test worker cleanup, import/save cancellation races and output validation.
- Never publish/push, restart the daemon, change firewall/router rules or delete user music as a
  side effect of tests. Reload only a test installation when testing runtime integration.

For bug reports, include Paseo/engine versions, OS/architecture, selected model, operation and
redacted logs. Never post a live bearer download URL, private host paths, prompts or music without
the owner's consent. Review the separate engine/model licenses when changing supported artifacts.
