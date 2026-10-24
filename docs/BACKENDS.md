# Bring your own music model

Paseo Music Studio is model-agnostic at the **backend boundary**, not a universal weight loader.
Choose either the bundled Stable Audio integration or a trusted command profile for a generator
you have already installed. Arbitrary checkpoint formats are not interchangeable, and no model,
Python environment, account, API key or dependency is installed automatically.

## Backend choices

| Backend | Model loading | Requirements |
| --- | --- | --- |
| Stable Audio (`sa3`) | Owned resident sa3-server, loaded at activation | Complete supported F16 GGUF set and a compatible server |
| Command (`command`) | One owned executable per take; loads its model when called | A CLI or wrapper that writes a regular RIFF/WAVE file to a supplied path |

The command backend is not tied to Stable Audio, GGUF, Python or a particular architecture.
Use any model whose generator can meet this contract. A model without a suitable CLI needs a
small wrapper; compatibility is not automatic merely because its name appears in a profile.

## Configure a command profile

1. Install your chosen generator and weights separately, reviewing their license and data policy.
2. In Studio **Settings**, set an absolute music output folder.
3. Paste a JSON array into **Custom command profiles**. Start from
   [command-profile.json](../examples/command-profile.json), replacing executable/script/model paths
   and argument names to match your actual CLI.
4. Review and acknowledge the custom-command permissions, save, select the profile and
   **Activate model**. Ready validates the executable; it does not mean the model is loaded.
5. Generate. The executable loads/runs per take and must exit zero only after a complete WAV is written.

A profile has a unique short `id`, display `label`, `backend: "command"`, absolute `binary`,
an `args` array and `timeoutSeconds` (1–2,147,483, default 300). The upper bound is Node’s signed-32-bit millisecond timer representation, not a model limit. Set a realistic per-run deadline: MiniMax writes files only after the entire native batch finishes; exceeding the deadline before that leaves no completed audio to import. IDs `medium`, `small-music` and
`small-sfx` are reserved. At most 32 profiles / 65,536 JSON code units are accepted.
Profiles may set `maxDurationSeconds`, `minSteps` and `defaultSteps` to describe backend constraints and a suggested starting value. Defaults are editable, not quality ceilings. The current 380-second global duration bound is a Studio constraint, not a universal model limit.
Windows `.bat`/`.cmd` launchers are rejected: point `binary` at an executable interpreter and put
the script path in `args`. There is no shell fallback.

### Argument placeholders

| Placeholder | Value |
| --- | --- |
| `{prompt}` | Exact music direction string |
| `{output}` | Plug-in-generated absolute path to the take's staging WAV |
| `{duration}` | Requested seconds, positive and at most 380 (Studio safeguard); generic profiles require whole seconds, MiniMax accepts fractional seconds and normally caps at 360 |
| `{seed}` | Concrete nonnegative seed; random is resolved before launch |
| `{steps}` | Requested integer steps, minimum 1 or the profile’s `minSteps`; no Studio quality ceiling. A C++ integer-representation guard limits values to 2,147,483,646. |
| `{minimax}` | Owned temporary JSON-file path for the MiniMax controls, including the resolved LM seed and replay codes; pass `--options-file={minimax}` with `controls: "minimax"`. Large song codes never enter argv. |

Generic profiles require `{prompt}` and `{output}`. MiniMax profiles require `{minimax}` and `{output}`; their owned options file carries the caption and large controls without command-line length limits. Other controls only reach your CLI if their placeholders
are present; a CLI may ignore them, so do not infer exact duration or deterministic output.
Metadata records whether the seed was forwarded. The generic duration/steps fields remain requested
settings, not measurements or a guarantee your generator supports those controls.

Each array entry is one argv element, substituted once. Quotes, spaces and shell metacharacters
inside a prompt are not reparsed by a shell. Prefer `"--prompt={prompt}"` to prevent option
injection; a standalone `"{prompt}"` rejects text beginning with `-`.
Unknown named placeholders and unsafe prompt prefixes are rejected.

### Command contract

- Run synchronously in the supplied per-take staging directory. Do not daemonize, create a new
  session/process group, start unrelated services or leave detached processes behind.
- Write exactly the supplied `{output}` path, close it, then exit zero. Nonzero means failure.
- Output must be a regular, non-symlink RIFF/WAVE file, 44 bytes–128 MiB. Close/finalize it before
  exiting: declared RIFF/chunk sizes must match, with a valid format chunk followed by nonempty,
  frame-aligned audio data. PCM, IEEE float and their extensible forms are supported; extra metadata
  chunks are allowed. Header-only files, truncated chunks and streaming `0xFFFFFFFF` size placeholders
  are rejected, even if the CLI exits zero. This checks structure, not whether the music sounds good. In-app playback retrieves 3 MiB raw chunks and reassembles the original WAV locally, keeping each encrypted relay frame below 32 MiB. The full file must arrive before playback; Download remains an alternative. The legacy single-message audio RPC is capped at 17 MiB. Encode/resample inside your
  wrapper if needed. Generic command profiles still produce WAV. MiniMax profiles also support validated MPEG Layer III audio and native multi-file imports. Remote URLs, FIFOs and arbitrary output-path imports are unsupported.
- stdout/stderr become the Studio log (last 12 KB). Do not print secrets.
- No extra environment-variable passthrough is configured. The child receives a restricted host
  environment (PATH/home/system/temp/library/CUDA basics), not arbitrary daemon API-key variables.
- Cancellation or timeout terminates the owned job. Once the watchdog reports success before Abort, a valid take
  is retained through a racing Abort or save failure. Staging is cleaned only after termination/import.

On POSIX the watchdog owns a separate group and the CLI inherits it. Owner death closes its pipe;
the guard terminates that group, including workers, and normal CLI exit cleans leftover group
members. The actual exit result is flushed over IPC before group cleanup. If the guard hangs,
the controller's bounded fallback targets that same owned group.

Processes that escape the group are not covered; explicitly killing only the watchdog with SIGKILL
can defeat cleanup. Studio adds no kernel cgroup/Job Object sandbox. Windows uses a PID-targeted
taskkill tree on cancellation. Native Windows x64 smoke checks passed cancellation of the CLI and
its child, as well as background-worker cleanup after normal exit; an earlier suspected worker leak
did not reproduce. This does not establish owner-death behavior, escaped services or every Windows
runtime. See [the measured scope](TESTING.md), rather than assuming Linux results prove other targets.

## Dependency-free adapter smoke test

[tone-cli.mjs](../examples/tone-cli.mjs) writes a short audible PCM WAV using Node's standard library.
It is a diagnostic tone sequence, **not an AI model or evidence of music-generation quality**.
To try it, use your actual Node executable as `binary` and these arguments:

```json
[
  "/absolute/path/to/paseo-music-studio/examples/tone-cli.mjs",
  "--prompt={prompt}",
  "--duration={duration}",
  "--seed={seed}",
  "--output={output}"
]
```

No model/network download is required. Then replace the executable/arguments with your own
generator. Full fixture integration tests run only inside disposable VMs; do not treat an example
as a hardware benchmark or an automatic permission to load a GPU model.

## MiniMax Music 3 (local Q8_0)

Build `mm-synth` using [minimaxmusic.cpp’s instructions](https://github.com/ServeurpersoCom/minimaxmusic.cpp#build).
Studio was checked against upstream commit [b260bc3](https://github.com/ServeurpersoCom/minimaxmusic.cpp/commit/b260bc3).
Obtain the following five files from the [MiniMax Music 3 GGUF distribution](https://huggingface.co/Serveurperso/MiniMax-Music3-GGUF/tree/main)
and put them together in one folder. These are the exact filenames required by the adapter:

| Component | Filename |
| --- | --- |
| Language model | `MiniMax-Music3-language_model-Q8_0.gguf` |
| Depth decoder | `MiniMax-Music3-rvq_depth_decoder-Q8_0.gguf` |
| Transformer | `MiniMax-Music3-transformer-Q8_0.gguf` |
| Condition encoder | `MiniMax-Music3-condition_encoder-F32.gguf` |
| Vocoder | `MiniMax-Music3-vocoder-F32.gguf` |

The engine is separate MIT-licensed software; model weights have their own terms. Downloads contact
GitHub/Hugging Face and consume disk space; review their terms before downloading. Studio does not
install either. To undo, remove only the separately installed engine/weights you no longer need,
not your Studio music folder.

Use [minimax-profile.json](../examples/minimax-profile.json) with [minimax-cli.mjs](../examples/minimax-cli.mjs).
Paste the complete JSON array into **Custom command profiles**. If you already have profiles, merge
its entry into your existing array instead of replacing it. Set absolute paths to Node, the adapter,
your built `mm-synth`, and that model folder;
choose a device supported by that engine build. No installation, account, download or public listener is added.
The profile declares `controls: "minimax"`, `minSteps: 2`, `defaultSteps: 30` and `maxDurationSeconds: 360`.
Stable Audio paths and profiles remain independent.

The MiniMax panel exposes lyrics/instrumental guidance, fractional duration, separate song-structure and
noise seeds, steps, both guidance scales, top-k, normalization, native song/render batches, output format,
MP3 bitrate and song-code replay. Defaults follow the engine: 60 seconds, 30 steps, random independent
seeds, LM CFG 1.5, DiT CFG 1.7, top-k 50, one song/one variation, MP3 128 kbps, peak clip 10.
Instrumental mode supplies a section tag; it is guidance, not a guarantee that the model produces no vocals.

Real backend constraints: steps at least 2; new LM generation has at most 9,000 frames at 25 fps
(360 seconds, possibly shorter from available context or early ending); render variations are 1–9.
Native song batches scale with engine memory capacity and Studio’s import-envelope budget. The engine uses 64-bit seeds; Studio accepts exact JSON integers up to 9,007,199,254,740,991, and native song/render offsets are never silently wrapped at 32 bits. Higher steps and larger batches can take much
longer or exhaust memory; the UI does not invent a 32-step quality ceiling. The engine HTTP API enforces
5,000 combined caption/lyric tokens; character counts are not token counts.

MP3, PCM WAV16/WAV24 and float WAV32 are saved in their selected format, without transcoding. WAV32
bypasses the engine’s peak normalization. MP3 bitrate choices are the encoder’s MPEG-1 Layer III table.
The adapter emits a bounded import manifest, with one normalized audio file and replay sidecar per output;
all outputs are checked before import. Replay codes are kept beside the audio, not in library-list responses.
Use a saved track’s **Use settings and song codes** action to load its recipe without starting generation.
Code replay skips new song-code sampling, but the language model still rebuilds conditioning from the direction, lyrics and saved codes. It uses one LM song and can still create different render variations.

Studio safeguards are separate from model capabilities: 128 MiB per audio file, 1 MiB import manifest,
1 MiB song codes, 4 MiB replay sidecar, 64 KiB saved metadata, configured per-job timeout, and
1–20 sequential outer takes. Native batching is separate from that outer queue. A failed disk save retains
completed outputs and a pending import queue; Retry save continues importing, without generating again.
If the plug-in restarts, retained hidden staging is not deleted; its logged path permits manual recovery.

## Trust and data

Profiles are trusted code, not sandboxed model descriptions. Their executables can read host
files and make network requests with the daemon user's permissions. A wrapper for a hosted API
can send prompts/audio off-host and incur charges: Studio never configures one automatically or
approves payment. Inspect the generator yourself and disclose its service/terms/data handling.

Paths, profile arguments and logs are visible to authorized host clients. Keep secrets out of
settings and command lines. Model/engine licenses are separate from the Studio's MIT license.
