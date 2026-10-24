// Synthetic RPC responses for the screenshot fixture, keyed by RPC method name. No real paths, hosts or tracks.
// Every response still passes through the plugin's own output schema (callPluginRpc), so drift fails loudly.
const prompt = "Instrumental modern jazz-funk, 118 BPM, punchy drums, walking bass, rhythmic Rhodes piano, short brass accents. Strong groove from the first beat.";

export const tracks = [
  { id: "3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e51", title: "Explainer groove A", prompt, duration: 30, steps: 8, seed: 41207, model: "medium", backend: "sa3", modelLabel: "Stable Audio 3 Medium · F16", createdAt: "2026-10-20T09:15:00.000Z", audioBytes: 5292044 },
  { id: "7a9e4d2b-1c3f-4e5a-8b6c-2d3e4f5a6b72", title: "Brass hits for the outro", prompt: "Short punchy big-band brass stabs, 124 BPM, confident, no vocals.", duration: 12, steps: 8, seed: 9093, model: "medium", backend: "sa3", modelLabel: "Stable Audio 3 Medium · F16", createdAt: "2026-10-20T09:42:00.000Z", audioBytes: 2116844 },
  { id: "c2d4e6f8-0a1b-4c3d-9e5f-6a7b8c9d0e13", title: "Walking bass bed", prompt: "Upright walking bass and brushed drums, 110 BPM, warm, sparse piano comping.", duration: 45, steps: 12, seed: 77, model: "example-cli", backend: "command", modelLabel: "Example music CLI", seedForwarded: true, createdAt: "2026-10-21T14:05:00.000Z", audioBytes: 1440044 },
  // Quick/full boundary (44.1 kHz stereo 16-bit = 176,400 B/s) and a high-bitrate file (48 kHz 24-bit stereo) above 17 MiB.
  { id: "a1b2c3d4-0001-4a00-8a00-000000000100", title: "Edge 100 s", prompt, duration: 100, steps: 8, seed: 1, model: "medium", backend: "sa3", createdAt: "2026-10-19T10:00:00.000Z", audioBytes: 100 * 176400 + 44 },
  { id: "a1b2c3d4-0001-4a00-8a00-000000000101", title: "Edge 101 s", prompt, duration: 101, steps: 8, seed: 2, model: "medium", backend: "sa3", createdAt: "2026-10-19T10:01:00.000Z", audioBytes: 101 * 176400 + 44 },
  { id: "a1b2c3d4-0001-4a00-8a00-000000000090", title: "Hi-res 90 s", prompt, duration: 90, steps: 8, seed: 3, model: "example-cli", backend: "command", createdAt: "2026-10-19T10:02:00.000Z", audioBytes: 90 * 288000 + 44 },
  // 380 s of 44.1 kHz stereo 16-bit: 22 audio chunks.
  { id: "e4f6a8b0-2c3d-4e5f-8a9b-0c1d2e3f4a55", title: "Full-length session", prompt, duration: 380, steps: 8, seed: 512, model: "medium", backend: "sa3", modelLabel: "Stable Audio 3 Medium · F16", createdAt: "2026-10-22T10:00:00.000Z", audioBytes: 67032044 },
];

// Mutable engine snapshot: generate/abort move it like the controller would; tests may also set it directly.
export const engine = { status: { phase: "ready", model: "medium", backend: "sa3", progress: 0, message: "Ready · synthetic fixture engine", log: "", pendingSave: false, batch: null } as Record<string, unknown> };
const update = (patch: Record<string, unknown>) => (engine.status = { ...engine.status, ...patch });

// Synthetic audio: byte i of every track is wavByte(i); chunks honour a test-set delay so cancellation is observable.
export const wavByte = (i: number) => (i * 31 + Math.floor(i / 1048576)) & 255;
// Tests add/remove synthetic library tracks (e.g. >20 for the ZIP cap, deletions for pruning).
export const extra = { tracks: [] as typeof tracks };
export const removal = { fail: [] as string[] };
export const audio = { delayMs: 0, version: "a".repeat(64) };
export const download = { hold: false, fail: false, completed: 0, release: [] as (() => void)[] };
async function downloadLink(zip: boolean) {
  if (download.hold) await new Promise<void>((resolve) => download.release.push(resolve));
  await new Promise((resolve) => setTimeout(resolve, audio.delayMs));
  download.completed++;
  if (download.fail) throw new Error("Synthetic download failure");
  return { url: `http://192.0.2.10:8765/fixture/${zip ? "tracks.zip" : "one.wav"}`, expiresAt: "2026-10-20T09:30:00.000Z" };
}
const CHUNK = 3 * 1024 * 1024;
const size = (id: string) => tracks.find((t) => t.id === id)!.audioBytes;
function chunkBase64(offset: number, length: number) {
  let binary = "";
  for (let start = 0; start < length; start += 32768) {
    const part = new Uint8Array(Math.min(32768, length - start));
    for (let j = 0; j < part.length; j++) part[j] = wavByte(offset + start + j);
    binary += String.fromCharCode(...part);
  }
  return btoa(binary);
}

export const responses: Record<string, unknown> = {
  "music.audio": ({ id }: { id: string }) => {
    if (size(id) > 17 * 1024 * 1024) throw new Error("This WAV is too large for safe in-app playback through Paseo’s relay. Use Download for the full-quality track.");
    return { base64: chunkBase64(0, size(id)), mimeType: "audio/wav" };
  },
  "music.audio-info": ({ id }: { id: string }) => ({ total: size(id), version: audio.version }),
  "music.audio-chunk": async ({ id, offset }: { id: string; offset: number }) => {
    await new Promise((r) => setTimeout(r, audio.delayMs));
    return { total: size(id), version: audio.version, offset, base64: chunkBase64(offset, Math.min(CHUNK, size(id) - offset)) };
  },
  "music.status": () => engine.status,
  "music.generate": () => update({ phase: "generating", progress: 0, message: "Generating…", batch: null }),
  "music.generate-batch": (input: { count: number }) => update({ phase: "generating", progress: 0, message: "Generating…", batch: { total: input.count, current: 1, completed: 0, state: "running" } }),
  "music.abort": () => update({ phase: "stopped", model: null, backend: null, progress: 0, message: "Aborted · engine stopped · finished tracks kept",
    batch: engine.status.batch ? { ...(engine.status.batch as object), state: "cancelled" } : null }),
  "music.models": [
    { id: "medium", label: "Stable Audio 3 Medium · F16", backend: "sa3" },
    { id: "small-music", label: "Stable Audio 3 Small Music · F16", backend: "sa3" },
    { id: "example-cli", label: "Example music CLI", backend: "command", maxDurationSeconds: 360, minSteps: 2, defaultSteps: 30 },
    { id: "minimax-q8", label: "MiniMax Music 3 · Q8_0", backend: "command", timeoutSeconds: 3600, maxDurationSeconds: 360, minSteps: 2, defaultSteps: 30, controls: "minimax" },
  ],
  // Saved settings plus synthetic song codes; the real handler reads them from the track's replay.json.
  "music.replay": ({ id }: { id: string }) => {
    const { title, prompt, duration, steps, seed, minimax } = [...tracks, ...extra.tracks].find((t) => t.id === id) as typeof tracks[number] & { minimax: object };
    return { title, prompt, duration, steps, seed, minimax: { ...minimax, audioCodes: "1,2,3" } };
  },
  "music.tracks": () => [...tracks, ...extra.tracks],
  "music.retry-save": () => update({ pendingSave: false, message: "Saved to library" }),
  "music.download": () => downloadLink(false),
  "music.remove-batch": ({ ids }: { ids: string[] }) => {
    const failed = ids.filter((id) => removal.fail.includes(id)).map((id) => ({ id, error: "Unsafe track directory" }));
    const deleted = ids.filter((id) => !removal.fail.includes(id));
    extra.tracks = extra.tracks.filter((t) => !deleted.includes(t.id));
    return { deleted, failed };
  },
  "music.download-batch": () => downloadLink(true),
  "music.download-options": [{ kind: "lan", address: "192.0.2.10", interface: "eth0", cidr: "192.0.2.0/24" }],
  "settings.engine.read": { status: "ready", revision: "fixture-1", values: { binary: "/opt/music-engine/bin/sa3-server", modelsDir: "/srv/music/models", outputsDir: "/srv/music/outputs",
    profiles: [{ id: "example-cli", label: "Example music CLI", backend: "command", binary: "/opt/example-music/bin/generate", timeoutSeconds: 300, maxDurationSeconds: 360, minSteps: 2, defaultSteps: 30, args: ["--prompt={prompt}", "--seconds", "{duration}", "--seed", "{seed}", "--out", "{output}"] }] } },
};
