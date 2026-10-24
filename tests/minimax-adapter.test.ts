import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, chmod, writeFile, readFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MusicController, modelCatalog } from "../server/controller";
import { Library, regular } from "../server/library";
import { configSchema, minimaxOptions } from "../shared/music";
const exec = promisify(execFile), adapter = resolve("examples/minimax-cli.mjs");
async function fixture(readAudio = regular) {
  const root = await mkdtemp(join(tmpdir(), "music-minimax with spaces-")), models = join(root, "models"), outputs = join(root, "outputs"), engine = join(root, "mm-synth");
  await mkdir(models); await mkdir(outputs); await copyFile(resolve("tests/minimax-fixture.mjs"), engine); await chmod(engine, 0o700);
  for (const name of ["language_model-Q8_0", "rvq_depth_decoder-Q8_0", "condition_encoder-F32", "transformer-Q8_0", "vocoder-F32"]) await writeFile(join(models, "MiniMax-Music3-" + name + ".gguf"), "GGUF fixture");
  const profile = { id: "minimax-music3-q8", label: "MiniMax Music 3 · Q8_0", backend: "command" as const, binary: process.execPath, timeoutSeconds: 30, maxDurationSeconds: 360, minSteps: 2, defaultSteps: 30, controls: "minimax" as const,
    args: [adapter, "--engine", engine, "--models", models, "--device", "CPU", "--options-file={minimax}", "--duration", "{duration}", "--steps", "{steps}", "--seed", "{seed}", "--output", "{output}"] };
  const config = configSchema.parse({ binary: "", modelsDir: "", outputsDir: outputs, profiles: [profile] });
  const controller = new MusicController(readAudio), library = new Library(outputs);
  const seen = async () => (await readFile(join(models, "seen.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { root, models, outputs, engine, profile, config, controller, library, seen,
    async close() { await controller.stop(true); await rm(root, { recursive: true, force: true }); } };
}
async function wait(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for MiniMax contract fixture");
}
test("MiniMax adapter imports valid WAVs and forwards both distinct seeds for prompt variations without a shell", async () => {
  const f = await fixture();
  try {
    assert.equal((await modelCatalog(f.config))[0].id, f.profile.id);
    await f.controller.start(f.config, f.profile.id);
    await wait(() => f.controller.snapshot().phase === "ready");
    const prompt = "--beat ; echo $(never-a-command)\n你好 jazz";
    f.controller.generateBatch({ title: "Jazz", prompt, duration: 1, steps: 2, seed: 71, minimax: { ...minimaxOptions.parse({}), format: "wav16", lmSeed: 171 }, count: 2, variations: ["brass", "piano"] });
    await wait(() => f.controller.snapshot().phase !== "generating");
    assert.equal(f.controller.snapshot().phase, "ready", f.controller.snapshot().log);
    assert.equal((await f.library.list()).length, 2);
    const requests = await f.seen();
    assert.deepEqual(requests.map((r) => [r.caption, r.seed, r.lm_seed, r.output_format, r.lyrics]), [[prompt + "\nbrass", 71, 171, "wav16", "[instrumental]"], [prompt + "\npiano", 72, 172, "wav16", "[instrumental]"]]);
    for (const r of requests) await assert.rejects(access(r.requestPath));
    assert.ok(!(await readdir(f.outputs)).some((n) => n.startsWith(".command-")));
    for (const track of await f.library.list()) assert.equal((await f.library.file(track.id)).bytes.toString("ascii", 0, 4), "RIFF");
  } finally { await f.close(); }
});
test("MiniMax native batches preserve separate seeds, float output and replay settings", async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.config, f.profile.id);
    await wait(() => f.controller.snapshot().phase === "ready");
    f.controller.generate({ title: "Native batch", prompt: "jazz", duration: 0.5, steps: 100, seed: 4294967295,
      minimax: minimaxOptions.parse({ lmSeed: 4294967295, lmBatch: 2, synthBatch: 2, format: "wav32", lmCfg: 2.3, ditCfg: 2.7, topK: 77, peakClip: 0, lyrics: "[Verse]\nA new song" }) });
    await wait(() => f.controller.snapshot().phase !== "generating");
    assert.equal(f.controller.snapshot().phase, "ready", f.controller.snapshot().log);
    const tracks = await f.library.list(); assert.equal(tracks.length, 4);
    assert.deepEqual(tracks.map((t) => [t.seed, t.minimax?.lmSeed]).sort(), [[4294967295, 4294967295], [4294967296, 4294967295], [4294967295, 4294967296], [4294967296, 4294967296]].sort());
    const request = (await f.seen())[0];
    assert.deepEqual([request.duration, request.steps, request.lm_cfg, request.dit_cfg, request.lm_top_k, request.peak_clip], [0.5, 100, 2.3, 2.7, 77, 0]);
    const replay = await f.library.replay(tracks[0].id); assert.equal(replay.minimax?.audioCodes, "1,2,3,4,5,6,7,8");
    replay.minimax!.audioCodes = Array(8000).fill("1000,2000,3000,4000,5000,6000,7000,8000").join(","); // Exceeds Linux’s per-argv string limit; replay must use a file.
    assert.ok(tracks.every((t) => !t.minimax?.audioCodes));
    f.controller.generate({ ...replay, title: "Replay", minimax: { ...replay.minimax!, lmBatch: 1, synthBatch: 1, format: "mp3", mp3Bitrate: 192 } });
    await wait(() => f.controller.snapshot().phase !== "generating");
    assert.equal(f.controller.snapshot().phase, "ready", f.controller.snapshot().log);
    const mp3 = (await f.library.list()).find((t) => t.title === "Replay")!;
    assert.ok((await f.library.file(mp3.id)).filename.endsWith(".mp3"));
    assert.equal((await f.library.audioInfo(mp3.id)).mimeType, "audio/mpeg");
    assert.equal((await f.seen())[1].audio_codes, replay.minimax?.audioCodes);
    assert.deepEqual((await readdir(f.outputs)).filter((n) => n.startsWith(".")), []);
  } finally { await f.close(); }
});
test("An unreadable native output keeps its folder but does not lock future generation", async () => {
  let reads = 0;
  const f = await fixture(async (path, limit) => {
    if (++reads === 4) { await rm(path); throw new Error("Output removed during import"); }
    return regular(path, limit);
  });
  try {
    await f.controller.start(f.config, f.profile.id); await wait(() => f.controller.snapshot().phase === "ready");
    const take = { title: "Partial", prompt: "jazz", duration: 1, steps: 30, seed: 1, minimax: minimaxOptions.parse({ lmSeed: 2, synthBatch: 2, format: "wav16" }) };
    f.controller.generate(take); await wait(() => f.controller.snapshot().phase !== "generating");
    assert.equal((await f.library.list()).length, 1);
    assert.equal(f.controller.snapshot().pendingSave, false);
    assert.match(f.controller.snapshot().message, /Partial import/);
    assert.equal((await readdir(f.outputs)).filter((n) => n.startsWith(".command-")).length, 1);
    f.controller.generate({ ...take, minimax: { ...take.minimax, synthBatch: 1 } });
    await wait(() => f.controller.snapshot().phase !== "generating");
    assert.equal(f.controller.snapshot().phase, "ready", f.controller.snapshot().log);
    assert.equal((await f.library.list()).length, 2);
  } finally { await f.close(); }
});
test("MiniMax adapter rejects bad limits before engine execution and cleans request data on engine failure", async () => {
  const f = await fixture(), output = join(f.outputs, "direct.wav");
  const args = [adapter, "--engine", f.engine, "--models", f.models, "--prompt=fail", '--options={"lmSeed":1}', "--seed", "1", "--output", output];
  try {
    for (const extra of [["--duration", "361", "--steps", "2"], ["--duration", "1", "--steps", "1"]]) await assert.rejects(exec(process.execPath, [...args, ...extra], { timeout: 5000 }));
    assert.equal((await f.seen()).length, 0);
    await assert.rejects(exec(process.execPath, [...args, "--duration", "1", "--steps", "2"], { timeout: 5000 }), /MiniMax engine failed/);
    assert.equal((await f.seen()).length, 1);
    assert.deepEqual(await readdir(f.outputs), []);
  } finally { await f.close(); }
});
test("Abort stops the MiniMax wrapper's engine descendant and removes owned staging", async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.config, f.profile.id);
    await wait(() => f.controller.snapshot().phase === "ready");
    f.controller.generate({ title: "Cancel", prompt: "slow", duration: 1, steps: 2, seed: 1 });
    await wait(async () => (await f.seen()).length === 1);
    const pid = (await f.seen())[0].pid;
    await wait(() => /1\/3 windows completed/.test(f.controller.snapshot().activity ?? ""));
    assert.equal(f.controller.snapshot().progress, 0, "No fabricated overall progress");
    assert.ok(f.controller.snapshot().elapsedSeconds! >= 0);
    assert.equal(f.controller.snapshot().timeoutSeconds, 30);
    await f.controller.stop(true);
    assert.equal(f.controller.snapshot().activity, undefined);
    await wait(async () => { try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return /\) Z /.test(stat); } catch { return true; } });
    assert.equal((await f.library.list()).length, 0);
    assert.deepEqual(await readdir(f.outputs), []);
  } finally { await f.close(); }
});
