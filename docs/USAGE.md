# Using Paseo Music Studio

[Start here](../README.md) for installation and a first track. This guide covers configuration,
generation, playback, downloads and recovery. [Backend contracts](BACKENDS.md) describe integration code.

## Configure host paths

In Studio **Settings**, choose absolute paths:

| Setting | Meaning |
| --- | --- |
| `outputsDir` | A dedicated writable folder for Studio's music and metadata |
| `binary` | Stable Audio's `sa3-server` executable; optional for command-only use |
| `modelsDir` | Stable Audio's complete model folder; optional for command-only use |
| Custom command profiles | A JSON array of reviewed executable/argument profiles |

Defaults are blank; Studio does not guess or create a music location before you configure one.
Saved version-1 paths migrate without resetting them. An older unsaved sa3.cpp layout, when found,
is displayed behind **Use my existing Stable Audio setup** and adopted only after your action.
Otherwise choose your previous output folder manually; existing music has not been deleted.

Stop the engine before changing settings. Settings are shared by authorized clients of that host;
an active engine keeps the configuration with which it started. Custom commands run with the host
user's permissions and may access files or external services. Review them, acknowledge the warning,
and keep credentials out of profile arguments/settings.

## Stable Audio model files

Studio requests F16 for DiT, SAME and T5Gemma. The conditioner uses the published **F32** file;
the vocabulary has no precision suffix. All variants need:

- `t5gemma-b-b-ul2-encoder-0.3B-v1.0-F16.gguf`
- `t5gemma-b-b-ul2-v1.0-vocab.gguf`

Add the three files for each wanted variant:

| Variant | DiT | Decoder | Conditioner |
| --- | --- | --- | --- |
| Medium | `stable-audio-3-medium-dit-1.5B-v1.0-F16.gguf` | `stable-audio-3-medium-same-l-v1.0-F16.gguf` | `stable-audio-3-medium-conditioner-v1.0-F32.gguf` |
| Small Music | `stable-audio-3-small-music-dit-0.5B-v1.0-F16.gguf` | `stable-audio-3-small-music-same-s-v1.0-F16.gguf` | `stable-audio-3-small-music-conditioner-v1.0-F32.gguf` |
| Small SFX | `stable-audio-3-small-sfx-dit-0.5B-v1.0-F16.gguf` | `stable-audio-3-small-sfx-same-s-v1.0-F16.gguf` | `stable-audio-3-small-sfx-conditioner-v1.0-F32.gguf` |

Follow [sa3.cpp's setup instructions](https://github.com/betweentwomidnights/sa3.cpp) and the exact
model repositories' current terms. Its [model download helper](https://github.com/betweentwomidnights/sa3.cpp/blob/main/models.sh)
selects Medium, Small Music or Small SFX with `--variant` and includes the shared T5Gemma files.
Choose F16 for DiT, SAME and T5Gemma (`--encoding f16 --ae-encoding f16 --t5-encoding f16`);
the helper’s default autoencoder precision is F32, not Studio’s supported F16 set. Review the
helper before running it: it downloads weights from Hugging Face into its selected output folder.
Studio does not run it. Discovery checks readable filenames, not checksums or license acceptance. Quantized or differently named files do not constitute this supported F16 set.

## MiniMax controls and replay

Use the [MiniMax Q8_0 setup](BACKENDS.md#minimax-music-3-local-q8_0) and replace the example's paths
with your own Node, adapter, `mm-synth` and five-file model folder. Activation checks the executable;
the engine loads its models when a take starts.

The panel supports Instrumental or Sung lyrics, independent song-structure (**LM seed**) and noise
(**Seed**) seeds, editable steps (30 suggested, minimum 2), LM/DiT guidance, top-k, peak normalization,
MP3 bitrate and native batches. Output remains the selected MP3, PCM WAV16/WAV24 or float WAV32;
Studio does not transcode it. The engine bypasses peak normalization for float WAV32.

Fractional seconds are allowed. The normal new-song budget is 9,000 LM frames at 25 fps: up to
360 seconds, possibly shorter because of context space or an early end-of-audio token.
Character limits in Studio are storage/transport safeguards, not the engine's token budget.
More steps or a larger batch can take much longer or exhaust host memory; there is no 32-step ceiling.

For a saved MiniMax track, **Use settings and song codes** fills the form without starting a job.
Stop a different active model first; Studio will not stop it automatically. Replay uses saved song
structure rather than sampling new codes. The language model still rebuilds conditioning;
direction and lyrics still affect the result. Length follows the codes rather than the Seconds field.
Replay requires one LM song, but may use multiple noise renders. Its banner and **Clear song codes
(create a new song)** action stay visible outside Advanced; the submit button explicitly says Replay.
Tracks without replay codes offer **Use these settings** instead.

Replay sidecars retain native codes separately from ordinary track metadata and library-list RPCs.
A replay is not a guarantee of bit-identical audio across engine versions, devices or changed settings.

## Sequential and native batches

**Take count (1–20)** runs a sequential queue. With no variation lines, each run uses the same music
direction and a different seed. To vary the prompt, enter one suffix per line:

```text
Muted trumpet lead, punchy drums
Piano trio, softer drums and warm upright bass
```

Six takes cycle through these two lines three times—not six takes per line. Each suffix is appended
to the base direction. Use at least as many takes as lines; each combined prompt must fit 20,000
characters and the metadata budget. Numbered titles preserve their index in downloads.

MiniMax's **LM songs per run × Noise renders per song** is a separate native multiplier. For
example, 5 sequential runs × 2 songs × 3 renders produces 30 files. The summary and Generate label
show the total even with Advanced collapsed. Render variations are 1–9; native song count is limited
by engine resources and Studio's import envelope, not a promise of unlimited practical capacity.

**Prefer sequential takes for long jobs.** A native run renders all its songs/variations before
writing outputs. Its configured timeout covers the entire engine run; timing out during rendering
leaves no completed output from that run. Sequential runs save after each completed run.

Fixed seeds advance across takes, accounting for native song/render group sizes. MiniMax LM seed
is independent; **−1** requests random selection. Studio represents seeds exactly up to
9,007,199,254,740,991; outer sequences wrap at that boundary, while native offsets that exceed it
are rejected rather than silently wrapped. Commands that ignore the forwarded seed can still
produce identical audio. Recorded settings do not promise determinism or audible variation.

The daemon queue continues when the screen closes or a phone disconnects, but not across a plug-in
or daemon restart. Stable Audio stays resident; command models can reload every run. **Cancel batch**
stops the unfinished job and remaining queue, keeping saved or backend-completed takes. Generation
or save errors stop the queue. **Retry save** recovers retained outputs; it does not generate the
unstarted remainder. Start another batch deliberately.

## Progress, deadlines and cancellation

- Stable Audio reports the engine's progress percentage and has a 30-minute processing deadline.
- MiniMax reports observed stages: loading, composing, rebuilding replay conditioning, rendering,
  decoding, encoding, checking and saving. A frame count is a budget that may finish early; a window
  count means completed windows within that song, not overall completion or a predicted ETA.
- Command profiles use their configured per-run timeout (300 seconds if omitted; the MiniMax example
  uses 3,600). Node's timer representation allows up to 2,147,483 seconds; that is not a model limit.
  Choose a realistic deadline before starting. Elapsed engine time stops advancing when the command
  exits, while checking/saving may still be in progress.
- **Stop model** ends an idle engine. **Abort generation** and **Cancel launch** terminate the owned
  job; activate again to generate. They do not delete saved music or stop device playback.

A watchdog owns the engine's process group/tree and normal-exit worker cleanup. Detached or
session/group-escaping services are unsupported; this is not a sandbox or protection against a
malicious executable. A stuck GPU driver can outlast the seven-second stop deadline; an error is
reported rather than claiming the engine stopped. See [backend ownership details](BACKENDS.md).

Active status refreshes every second; idle status every 15 seconds. Observed completion and local
mutations refresh tracks immediately, with a 30-second fallback for other clients' changes.
Network/request time is additional.

## Playback and saved information

New tracks show measured audio length; requested seconds remain separate so settings reuse does not
silently change the recipe. Legacy tracks without a measurement show **requested** length and are
not rewritten. The saved music-direction prompt starts collapsed below track actions and collapses
again when selecting another track.

**Quick playback** uses one transfer for audio up to 100 seconds and 17 MiB. Longer/larger audio
uses **Full-track loading**, fetching 3 MiB raw chunks and assembling the exact original WAV/MP3.
Both wait for the entire file before playing; neither is live streaming. File versions, chunks and
MIME types are checked before playback. Changing selection, entering multi-select, cancelling the
load or leaving the screen stops an unfinished transfer.

Large files still need device memory. Playback uses Paseo's audio/voice queue; the plug-in API has
no independent Pause/Resume/Stop controls. Use Paseo's available voice playback control to interrupt.
**Stop model is not a playback stop button.**

## Download to a phone or computer

Select a track and press **Download WAV** or **Download MP3**. Setup offers two private routes:

| Route | Setup | Privacy |
| --- | --- | --- |
| Same Wi-Fi/LAN | Both devices on the same trusted router; choose the host interface | Unencrypted HTTP. Avoid public/guest Wi-Fi and confirm trust for every download. |
| Tailscale | Host and device connected to the same tailnet | Optional encrypted private networking; choice is remembered only in the open library view. |

Viewing setup starts no listener. Confirming a route opens only that interface and creates a
reusable bearer link: **five minutes for a single audio file, 15 minutes for a ZIP**. Native mobile
clients attempt to open the browser after preparation unless the selection/view has changed.
On web/desktop, use **Open WAV/MP3 download** or **Open ZIP download**. Safari normally offers
Download or Share → Save to Files; other browsers use Downloads. Physical-phone saving remains
outside the current acceptance evidence.

Use **Download setup / Change connection** and **Recheck connections** to retry. Host address
discovery does not test phone reachability, firewall permissions or guest-Wi-Fi isolation. Tailscale
detection needs a named IPv4 adapter; macOS utun and userspace mode are unsupported for that route.
There is no public tunnel, router forwarding, automatic firewall change or cloud music upload.
Playback through Paseo may work even when neither browser-download route is reachable.

[Tailscale Inc.'s app](https://tailscale.com/download) creates a virtual adapter and exchanges
account/device connection metadata with its service. Studio never installs it. Review the
[privacy policy](https://tailscale.com/privacy-policy); disconnect or
[uninstall](https://tailscale.com/docs/features/client/uninstall) to undo setup.

Anyone with the link **and network reachability** can fetch its audio until expiry. LAN observers
can read the traffic; browser or synchronized history may retain URLs. Interface/address/CIDR checks
cannot identify a switch to a different network with identical settings. Do not use these links as
permanent public shares. Deletion cannot retract bytes already delivered or downloaded copies.

### ZIP downloads and transfer limits

Choose **Select tracks**, check up to 20, and press **Download selected as ZIP (N)**. **Select all**
chooses the newest 20. Confirm a route as above; changing selection invalidates a pending link request.

ZIP entries are numbered, uniquely named original WAV/MP3 files, uncompressed and not re-encoded.
Archives stream without a temporary ZIP on the host. At the 128 MiB per-file guard, 20 tracks can
require about 2.5 GiB plus ZIP headers on the receiving device. iPhone Files normally extracts a ZIP
when tapped; that physical-device flow has not been acceptance-tested.

Start before expiry. Accepted transfers may finish afterward, but have a bounded request deadline:
30 minutes plus one minute per started 25 MiB of Content-Length, including preparation (about
133 minutes for the largest allowed ZIP). After preparation, 30 seconds without network progress
can also stop a transfer. Range/resume is unsupported. Choose smaller selections on slow connections.
Route revocation and plug-in cleanup force-close active transfers; deleting a track can interrupt a ZIP.

Advanced guards: eight current route choices, 16 active/draining services, 32 links and four concurrent
responses/connections per service. Route checks run at issuance and request time, with a one-second
watcher. Expired services stop accepting connections while accepted responses drain. HEAD probes
and link authorization check metadata without reading entire audio files.

## Delete, restore and recover

**Delete selected track** requires confirmation. For batches, select tracks, choose **Delete selected
(N)** and confirm the exact selection. Changing selection cancels confirmation; failed moves remain
selected with an error. Finish active downloads before deleting their source tracks.

Deletion moves a complete UUID folder into `<outputsDir>/.trash/`. It is not permanent erasure and
does not free disk space. To restore, while Studio is not writing the track, move the folder back
to `<outputsDir>/<id>` using the exact `id` from `track.json`. Keep **all** files together: `audio.wav`
or `audio.mp3`, `track.json`, and `replay.json` when present. Do not overwrite an existing destination.
Only valid plug-in UUID track folders are listed; unrelated audio folders are not automatically imported.

Output must pass structural WAV/MP3 and metadata validation before saving. Invalid output fails
without creating an impossible-to-save pending take. If a filesystem save fails, valid audio remains
in memory and/or an owned native-output folder, and new generation is blocked until recovery.
Stop the engine, fix disk space/permissions or the output setting, then **Retry save**. Native queued
outputs continue importing without inference; unreadable retained outputs are reported and left
for inspection rather than permanently blocking every future job.

**Recover before reload, disable, removal or restart.** In-memory recovery cannot survive those
operations. Native retained files may survive on disk, but the queue is not automatically restored.
A crash can leave hidden `.pending-<uuid>` or `.command-<random>` folders. Studio does not delete
old leftovers automatically. Inspect for wanted audio before manually removing anything, only when
no generation/save is running. The status/log identifies retained native output locations.

Authorized clients share the host library; it is not per-user private storage. Saved settings,
metadata, prompts and replay files can be sensitive. See [security boundaries](../SECURITY.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Studio missing | Correct Paseo host, your global plug-in permission, and `paseo plugin ls` status; inspect `paseo plugin logs paseo-music`. |
| No models | Executable/profile paths or the complete Stable Audio filenames; set an output folder before activation. |
| Ready but no model loaded | Expected for command profiles: loading begins on Generate. |
| MiniMax run takes a long time | Stage and elapsed/profile deadline; native song/render multiplier; steps and available memory. No ETA is promised. |
| Editing Seconds does not change replay length | Codes determine replay length. Use Clear song codes to compose a new song. |
| Generate rejected | Read the error below Generate; check numbers, profile limits, metadata size and replay's one-LM-song rule. |
| Playback loads slowly | The entire original file must arrive. Cancel loading or use Download; stopping the engine does not stop playback. |
| Download cannot connect | Correct private route on both devices, firewall/VPN rules and guest-network isolation; recheck connections. |
| Save failed | Recover using Retry save before reloading; inspect the retained-output message and disk permissions/space. |
| Music disappeared after changing paths | Select the previous output folder; check `.trash`. Do not overwrite or reimport originals blindly. |

## Uninstall

Recover pending saves and finish downloads first. These commands remove only Studio's installation:

```bash
paseo plugin disable paseo-music
paseo plugin remove paseo-music
```

Cleanup stops owned engines and listeners. The source checkout, engines, weights, output folder and
`.trash` remain. Remove those separately only if you intend to erase them. For settings-version
rollback details, see [release preparation](../RELEASING.md#settings-upgrade-and-rollback).
