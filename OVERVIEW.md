# Paseo Music Studio

Generate, replay and manage music from Paseo using a backend you choose. Studio integrates local
MiniMax Music 3 Q8_0 and Stable Audio F16, and accepts other generators through trusted WAV-producing
command profiles. Select a model, enter a music direction, generate takes, listen on the current
Paseo device and download original audio individually or as a ZIP.

## How it works

Generation runs on the Paseo daemon host, not on your phone. Stable Audio uses an owned resident
sa3-server process. Command profiles load and run their model per take; Ready means the executable
is available, not that its model is already loaded. Nothing installs or downloads automatically.
Model-agnostic means an extensible CLI boundary, not automatic loading of arbitrary checkpoints.

MiniMax exposes instrumental guidance or lyrics, independent song/noise seeds, editable steps
(30 suggested, minimum 2), guidance, top-k, normalization, native song/render batches and output
format/bitrate. MP3, WAV16, WAV24 and float WAV32 remain in their original format. Saved song codes
can refill the form for replay without starting a job; replay mode and its clear action stay visible.

Queue up to 20 sequential runs with optional cycling prompt variations. Native MiniMax batches are
separate: the form shows runs × songs × renders and warns about the whole-run deadline. MiniMax
progress reports stages and completed windows with elapsed time, not an estimated overall percentage.
New songs have a normal budget up to 360 seconds but can end earlier. Stable Audio Medium allows
up to 380 seconds and Small models up to 120. New saves show measured length separately from the request.

## Setup and compatibility

Requires Paseo 0.12.x or 0.13.x on daemon and app, your permission to use plug-ins, a compatible
separately installed engine and its weights/environment, and sufficient host RAM/VRAM. Configure
an absolute writable output folder, then either Stable Audio paths or reviewed custom profiles.
Defaults are blank; existing saved paths migrate without being silently reset. Stop the model before
changing configuration. See the [README](README.md) for installation and backend setup.

Focused native Linux x64 checks and phone/desktop component fixtures pass. Windows x64 smoke and
packaged Paseo web-client checks are historical, not fresh MiniMax UI acceptance. Current ARM runs
are blocked; physical-phone, actual relay, Electron-shell and formal GPU/audio-quality acceptance
are not established. See the [testing matrix](docs/TESTING.md) and [screenshot scope](docs/SCREENSHOTS.md).

## Playback, downloads and recovery

Playback crosses Paseo's authenticated connection and loads the complete original audio before
playing. Large files use chunks but still need device memory. Use Paseo's voice playback control
to interrupt audio; Stop model controls the engine, not playback.

Downloads need a separately reachable private route. Trusted same-Wi-Fi/LAN uses unencrypted HTTP
and requires confirmation each time. Optional Tailscale provides encrypted networking when you
configure it on both devices; setup explains its provider, data handling and removal. Studio never
installs it. Viewing download setup opens no listener; confirming opens only the selected interface.
Links last five minutes for one audio file or 15 minutes for a ZIP of up to 20 tracks. Anyone with
the link and network access can fetch its audio, and browser history may retain the URL. Host
address checks do not establish phone reachability or identify a Wi-Fi network. No public tunnel,
automatic firewall/router change or cloud music upload is configured.

Deletion moves confirmed selections into recoverable `.trash`, without erasing them or freeing disk
space. Saving failures retain valid audio in memory and/or a native-output folder. Recover with
Retry save before reloading or disabling; a restart loses in-memory recovery and the active queue.

## Data access and limitations

Plug-ins and custom generators are trusted, unsandboxed code with the daemon user's filesystem,
process and network permissions. Local engine requests are not sent to a coding-agent provider;
a custom command can contact external services, send prompts/audio or incur charges according to
its implementation. Studio does not configure paid services or authorize payment automatically.
Keep secrets out of settings, arguments and logs.

The host library contains audio, prompts, generation metadata and optional replay sidecars. It is
shared by authorized clients, not isolated per user. Downloaded copies cannot be retracted. There
is no built-in mixing, stem separation, MIDI export or training, and musical properties or exact
reproducibility are not guaranteed. Engines and weights must be obtained separately under their own terms.
