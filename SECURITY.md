# Security policy

## Supported version

Report issues against the latest 0.5.x source. Fixes are best effort; there is no security SLA or promise of backports.

## Report privately

Do not put credentials, live download links, private prompts, music or host paths in a public issue.
If this repository has GitHub private vulnerability reporting enabled, use **Security → Report a vulnerability**.
Otherwise ask the maintainer for a private reporting channel without describing the exploit publicly.
See [GitHub’s private reporting guidance](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability).
No reporting address or program is promised before the repository is published.

Include the affected commit/version, Paseo and backend versions, OS/architecture, impact and a minimal
synthetic reproduction. Redact bearer URLs and environment/configuration secrets.

## Trust boundaries

- Paseo plug-ins are trusted, unsandboxed code running as the daemon user. Custom command profiles
  can execute arbitrary programs with that user’s filesystem and network permissions. Inspect them first.
- Model engines and weights are separate installations with their own security and license requirements.
  This plug-in does not download them automatically. An external backend may send prompts or audio elsewhere.
- Playback travels over your Paseo connection. Downloads use a separate temporary HTTP listener and bearer URL;
  LAN downloads require explicit confirmation. HTTP is not encrypted. Use only a trusted private route, never
  a public tunnel or an Internet-facing port. Anyone with a live URL may use it until expiry/revocation.
- Track deletion moves files into `.trash`; it is not secure erasure. Already delivered bytes cannot be recalled.
- Failed saves may retain audio in memory and/or an owned staging folder. Recover it before reloading or removing
  the plug-in. Keep backups of music and settings before upgrades.

See [usage and privacy](docs/USAGE.md) and [the backend contract](docs/BACKENDS.md) for operational limits.
