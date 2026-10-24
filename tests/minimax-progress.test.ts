import { test } from "node:test";
import assert from "node:assert/strict";
import { MiniMaxProgress } from "../server/minimax-progress";
import { commandProfile, MAX_TIMEOUT_SECONDS, minimaxOptions, trackSchema } from "../shared/music";

test("MiniMax progress follows real completed stage counters across fragmented streams and native songs", () => {
  const p = new MiniMaxProgress(2);
  assert.match(p.push("[Load] LM backend: CUDA0\n")!, /Loading song model/);
  assert.equal(p.push("[AR] Fra"), undefined);
  assert.equal(p.push("noise on stdout\n", "stdout"), undefined);
  assert.match(p.push("me 100/1500\n")!, /frame 100\/1500 budget/);
  assert.match(p.push("[AR] Song 0: 561 frames (22.4s of music)\n")!, /22.4 s/);
  assert.match(p.push("[DiT] Window 3/5: T=689, 30 steps, 4680 ms\n")!, /song 1\/2 · 3\/5 windows completed/);
  assert.equal(p.push("[DiT] Graph: rebuilt for shorter last window\n"), undefined, "Graph rebuild must not erase the last completed window counter");
  assert.match(p.push("[DiT] CFG=1.7, 5 windows, 30s\n")!, /Decoding song 1\/2/);
  assert.match(p.push("[VAE] Decode: 5 windows -> 22.4s of audio\n")!, /Decoded song 1\/2/);
  assert.match(p.push("[Synth] Song 2/2 (seed=9)\n")!, /song 2\/2/);
  assert.match(p.push("[DiT] Graph: B=2\n")!, /Rendering song 2\/2/);
  assert.match(p.push("[DiT] Window 1/4: T=689, 30 steps\n")!, /song 2\/2 · 1\/4 windows completed/);
  assert.match(p.push("[Done] 44.8 s total\n")!, /Encoding/);
  assert.match(p.push("[MP3] Encoding 29.9s @ 128 kbps\n")!, /Encoding MP3/);
  assert.equal(p.push("[Request] Wrote replay.json"), undefined);
  assert.match(p.finish("stderr")!, /Writing audio and replay/);
  assert.equal(p.push("x".repeat(50000)), undefined);
  assert.equal(p.push("\n"), undefined);
  assert.match(p.push("[AR] Replay: 100 frames from audio_codes\n")!, /conditioning rebuilt/);
  const replay = new MiniMaxProgress(1, true);
  assert.match(replay.push("[Store] Load Depth: 2905 ms\n")!, /Rebuilding conditioning/);
});

test("Replay validation fails before launch; longer deadlines use Node's timer representation, not a one-hour model cap", () => {
  assert.equal(minimaxOptions.safeParse({ audioCodes: "1,2,3", lmBatch: 2 }).success, false);
  assert.equal(minimaxOptions.parse({ audioCodes: "1,2,3" }).lmBatch, 1);
  const profile = { id: "music", label: "Music", binary: "/bin/music", backend: "command", args: ["--prompt={prompt}", "--out={output}"] };
  assert.equal(commandProfile.parse({ ...profile, timeoutSeconds: 7200 }).timeoutSeconds, 7200);
  assert.equal(commandProfile.safeParse({ ...profile, timeoutSeconds: MAX_TIMEOUT_SECONDS + 1 }).success, false);
  // Persisted metadata does not reapply live replay rules or silently invent an output format.
  const track = trackSchema.parse({ id: "0123abcd-0000-4000-8000-000000000000", title: "Music", prompt: "jazz", duration: 60, steps: 30, seed: 1, model: "music", createdAt: new Date().toISOString(), minimax: {} });
  assert.equal(track.minimax?.format, undefined);
});
