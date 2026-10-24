# Release preparation

**Preparation is not publication.** This document does not authorize a remote push, public release,
npm publication or Paseo registry submission. Keep `package.json` marked `private: true` until a
separate npm decision is approved. A local name does not establish public name availability.

## Proposed public identity

| Field | Recommended value |
| --- | --- |
| Product | Paseo Music Studio |
| Repository / package name | `paseo-music-studio` |
| Stable runtime ID | `paseo-music` — preserve this for existing installations/settings |
| Version | `0.5.1` |
| About description | A model-agnostic music studio for Paseo: generate, replay and manage music with your own backends |
| Suggested topics | `paseo`, `paseo-plugin`, `music-generation`, `minimax`, `stable-audio`, `typescript`, `local-ai` |
| License | MIT for Studio's code; separate engine, dependency and model terms |

Repository URL, owner/scope, name availability and publication date remain unassigned here.
Recommend **a reviewed public Git repository first**; npm and registry listing are separate options.
Do not add a fictional clone command, package badge or installation target before one exists.

## Prepare the clean source snapshot

- [ ] Start a separate, clean-history public snapshot. Preserve the original development checkout
  and its history; do not rewrite, delete or push private development history.
- [ ] Include source, manifest, locked package metadata, examples, tests, contribution/security
  guidance, changelog, license/notices and every linked document/image.
- [ ] Exclude private `PLAN.md` / `PROGRESS.md`, transcripts, review artifacts, logs, settings,
  generated music/replay data, model weights, dependency/cache folders and editor/agent state.
- [ ] Review **all exported files and the entire new history**, including author identity, for secrets,
  private paths, host names, real IPs, bearer URLs and personal prompt/audio data.
- [ ] Keep the manifest runtime ID and supported Paseo range accurate. Synchronize package/lock
  version, name and description; use real repository metadata only after the destination is chosen.
- [ ] Check [screenshot provenance](docs/SCREENSHOTS.md) and package/manifest media paths. Use current
  sample-data UI captures; never present component fixtures or historical tones as live GPU evidence.
- [ ] Keep [OVERVIEW.md](OVERVIEW.md) factual: capabilities, operation, setup, permissions and limits.
  Current Paseo listing rules exclude install commands, changelogs, badges and license/contributor sections.
- [ ] Review [testing scope](docs/TESTING.md) and [third-party notices](THIRD_PARTY_NOTICES.md). Do not
  add overlapping test counts or label historical Windows/packaged/ARM evidence as current acceptance.

Static checks from the prepared checkout:

```bash
npm ci --ignore-scripts
npm run typecheck -- --noUnusedLocals --noUnusedParameters
git diff --check
npm pack --dry-run --ignore-scripts
```

Inspect the actual dry-run file list as well as repository contents: npm packaging and a Git export
have different inclusion rules. These commands prepare dependencies/check source; they do not
publish. App/install/runtime checks still belong in disposable native VMs, not the desktop.

## Publication sequence — only after explicit approval

1. Confirm the public owner, repository name, author identity and visibility; verify availability.
   Review the clean snapshot and factual limitations with the owner before uploading it.
2. Once authorized, create/push only that reviewed public repository. Add the real source links
   and Git installation instructions, and verify the published tree does not include private history.
3. If requested separately, create a tagged source release with accurate
   [release notes](CHANGELOG.md). A Git source release does not require removing npm's `private` guard.
4. For npm, obtain explicit approval for the account/scope and publishing action, remove `private`
   only then, add genuine repository metadata and check the distribution file list again. Follow
   the current [Paseo publishing guide](https://paseo.sh/docs/plugins/publishing.md), including
   runtime-dependency lock/preparation requirements; keep credentials out of source.
5. After an actual approved public source exists, request registry review through the
   [Paseo submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml).
   Supply its real source/ref, description, overview and current interface media. Review
   [Paseo's policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md); submission is not approval.
6. Verify installation of the exact released artifact in an owned disposable VM. Record version,
   scope and cleanup; do not turn a compatibility override into release acceptance.

No step grants permission to restart a user's daemon, modify host networking, download weights,
change live settings or discard pending music. Source review and dry-runs do not imply publication.

## Settings upgrade and rollback

Settings schema version 2 retains the v1 paths and adds optional command profiles. Saved v1 paths
migrate without resetting them, and legacy track metadata remains readable. Runtime ID stability
is essential even if the checkout/repository/package name changes.

**The 0.1 runtime cannot read a saved v2 settings document.** Before an upgrade requiring rollback,
export/back up the current configuration. Returning to 0.1 requires restoring its v1 document or
re-entering paths there; older code cannot recover unsupported custom profiles. Do not delete music.
Recover pending takes before any reload, disable or rollback: in-memory recovery is lost on restart,
and retained native staging does not automatically restore its import queue.
