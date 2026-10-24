import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readFile, readdir, symlink, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MusicController, installedModels } from "../server/controller";
import { Library } from "../server/library";
import { Downloads } from "../server/downloads";
import { MAX_AUDIO_BYTES, MAX_PLAYBACK_BYTES, durationLimit, configSchema, generateInput, batchInput, type Config } from "../shared/music";

async function setup(scenario = "") {
  const root = await mkdtemp(join(tmpdir(), "paseo-music-test-"));
  const config: Config = { binary: resolve("tests/fake-engine.mjs"), modelsDir: join(root, "models"), outputsDir: join(root, "outputs") };
  await mkdir(config.modelsDir);
  await chmod(config.binary, 0o755);
  for (const file of [
    "stable-audio-3-medium-dit-1.5B-v1.0-F16.gguf",
    "stable-audio-3-medium-same-l-v1.0-F16.gguf",
    "stable-audio-3-medium-conditioner-v1.0-F32.gguf",
    "t5gemma-b-b-ul2-encoder-0.3B-v1.0-F16.gguf",
    "t5gemma-b-b-ul2-v1.0-vocab.gguf",
  ]) await writeFile(join(config.modelsDir, file), "synthetic");
  if (scenario) await writeFile(join(config.modelsDir, "scenario"), scenario);
  const controller = new MusicController();
  return { root, config, controller, library: new Library(config.outputsDir), async close() { await controller.stop(true); await rm(root, { recursive: true, force: true }); } };
}
async function until(fn: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() > deadline) throw new Error("Timed out waiting for state"); await delay(20); }
}
const input = { title: "Test jazz", prompt: "instrumental jazz", duration: 1, steps: 8, seed: -1 };
async function completed() {
  const f = await setup(); f.controller.start(f.config, "medium");
  await until(() => f.controller.snapshot().phase === "ready");
  f.controller.generate(input); await until(() => f.controller.snapshot().message === "Saved to library");
  return f;
}

test("schema rejects unbounded generation, malformed input and model injection", () => {
  assert.deepEqual(configSchema.parse({}), { binary: "", modelsDir: "", outputsDir: "" });
  for (const value of [0, 381, NaN, Infinity]) assert.throws(() => generateInput.parse({ ...input, duration: value }));
  assert.equal(generateInput.parse({ ...input, duration: 1.2 }).duration, 1.2);
  assert.throws(() => generateInput.parse({ ...input, prompt: " " }));
  assert.throws(() => generateInput.parse({ ...input, seed: 3.4 }));
  assert.throws(() => configSchema.parse({ outputsDir: "relative/folder" }));
  assert.equal(configSchema.parse({ binary: "C:\\Music\\sa3-server.exe" }).binary, "C:\\Music\\sa3-server.exe");
  assert.ok(configSchema.parse({ outputsDir: "\\\\server\\music" }).outputsDir);
});

test("duration limits match upstream and stay within Paseo's transport envelope", () => {
  assert.equal(durationLimit("medium"), 380);
  assert.equal(durationLimit("small-music"), 120);
  assert.equal(durationLimit("small-sfx"), 120);
  assert.equal(durationLimit("custom-cli"), 380);
  for (const duration of [60, 61, 120, 300, 380]) assert.equal(generateInput.parse({ ...input, duration }).duration, duration);
  assert.equal(batchInput.parse({ ...input, duration: 380, count: 2 }).duration, 380);
  assert.ok(44 + 380 * 44100 * 2 * 2 <= MAX_AUDIO_BYTES);
  const rpcBytes = Math.ceil(MAX_PLAYBACK_BYTES / 3) * 4 + 65536;
  assert.ok(Math.ceil((rpcBytes + 40) / 3) * 4 < 32 * 1024 * 1024);
});

test("Small models reject oversized single and batch requests before launching a job", async () => {
  for (const model of ["small-music", "small-sfx"]) {
    const f = await setup();
    try {
      for (const file of [`stable-audio-3-${model}-dit-0.5B-v1.0-F16.gguf`, `stable-audio-3-${model}-same-s-v1.0-F16.gguf`, `stable-audio-3-${model}-conditioner-v1.0-F32.gguf`]) await writeFile(join(f.config.modelsDir, file), "synthetic");
      f.controller.start(f.config, model); await until(() => f.controller.snapshot().phase === "ready");
      assert.throws(() => f.controller.generate({ ...input, duration: 121 }), /at most 120 seconds/);
      assert.throws(() => f.controller.generateBatch({ ...input, duration: 380, count: 2, variations: [] }), /at most 120 seconds/);
      assert.equal(f.controller.snapshot().phase, "ready"); assert.equal(f.controller.snapshot().batch, null);
      f.controller.generate({ ...input, duration: 120 }); await until(() => f.controller.snapshot().message === "Saved to library");
      const request = JSON.parse(await readFile(join(f.config.modelsDir, "request.json"), "utf8"));
      assert.equal(request.maxDuration, "120"); assert.equal(request.duration, 120);
      assert.equal((await f.library.list())[0].duration, 120);
    } finally { await f.close(); }
  }
});

test("380-second stereo WAV survives HTTP/save/download; large in-app playback fails safely", async () => {
  const f = await setup("long-audio");
  const downloads = new Downloads(() => "127.0.0.1");
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    f.controller.generate({ ...input, duration: 380 });
    await until(() => f.controller.snapshot().phase !== "generating", 30000);
    assert.equal(f.controller.snapshot().message, "Saved to library");
    const request = JSON.parse(await readFile(join(f.config.modelsDir, "request.json"), "utf8"));
    assert.equal(request.maxDuration, "380"); assert.equal(request.duration, 380);
    const [track] = await f.library.list(); assert.equal(track.duration, 380);
    const file = await f.library.file(track.id); assert.equal(file.bytes.length, 44 + 380 * 44100 * 4);
    assert.equal(track.audioBytes, file.bytes.length);
    await assert.rejects(f.library.audio(track.id), /Use Download for the full-quality track/);
    const link = await downloads.create(f.library, track.id), response = await fetch(link.url);
    assert.equal(response.status, 200); assert.equal(Number(response.headers.get("content-length")), file.bytes.length);
    assert.equal((await response.arrayBuffer()).byteLength, file.bytes.length);
  } finally { await downloads.close(); await f.close(); }
});

test("installed selector lists complete F16 models only", async () => {
  const f = await setup();
  try {
    assert.deepEqual(await installedModels(f.config), ["medium"]);
    await rm(join(f.config.modelsDir, "t5gemma-b-b-ul2-v1.0-vocab.gguf"));
    assert.deepEqual(await installedModels(f.config), []);
  } finally { await f.close(); }
});

test("launch, generate, native playback payload, persistent library and recoverable delete", async () => {
  const f = await completed();
  try {
    const tracks = await f.library.list(); assert.equal(tracks.length, 1); assert.equal(tracks[0].seed, 123);
    const media = await f.library.audio(tracks[0].id);
    assert.equal(media.mimeType, "audio/wav"); assert.equal(Buffer.from(media.base64, "base64").toString("ascii", 0, 4), "RIFF");
    await f.controller.stop(); assert.equal(f.controller.snapshot().phase, "stopped");
    assert.equal((await new Library(f.config.outputsDir).list()).length, 1);
    const unrelated = join(f.config.outputsDir, "original.wav"); await writeFile(unrelated, "keep");
    assert.deepEqual(await f.library.remove(tracks[0].id), { deleted: true });
    assert.equal((await f.library.list()).length, 0); assert.equal(await readFile(unrelated, "utf8"), "keep");
    const trash = await readdir(join(f.config.outputsDir, ".trash")); assert.equal(trash.length, 1);
    assert.equal((await lstat(join(f.config.outputsDir, ".trash", trash[0], "audio.wav"))).isFile(), true);
  } finally { await f.close(); }
});

test("reject duplicate launches/jobs; idle stop refuses busy engine; abort preserves finished tracks", async () => {
  const f = await completed();
  try {
    assert.throws(() => f.controller.start(f.config, "medium"));
    f.controller.generate({ ...input, prompt: "hang" });
    assert.throws(() => f.controller.generate(input));
    await assert.rejects(f.controller.stop(), /Abort/);
    await until(() => f.controller.snapshot().progress === 42);
    await f.controller.stop(true); assert.equal(f.controller.snapshot().phase, "stopped");
    assert.equal((await f.library.list()).length, 1);
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    await f.controller.stop();
  } finally { await f.close(); }
});

test("abort during startup prevents a late launch", async () => {
  const f = await setup("slow-start");
  try {
    f.controller.start(f.config, "medium"); await f.controller.stop(true);
    await delay(1200); assert.equal(f.controller.snapshot().phase, "stopped");
    f.controller.start(f.config, "medium"); await delay(100); await f.controller.stop(true);
    assert.equal(f.controller.snapshot().phase, "stopped");
  } finally { await f.close(); }
});

test("abort interrupts a blocked model load", async () => {
  const f = await setup("load-hang");
  try {
    f.controller.start(f.config, "medium"); await delay(500);
    const start = Date.now(); await f.controller.stop(true);
    assert.ok(Date.now() - start < 4000); assert.equal(f.controller.snapshot().phase, "stopped");
  } finally { await f.close(); }
});

test("stop escalates an owned child that ignores SIGTERM", async () => {
  const f = await setup("ignore-term");
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    const start = Date.now(); await f.controller.stop(); assert.ok(Date.now() - start < 5000);
    assert.equal(f.controller.snapshot().phase, "stopped");
  } finally { await f.close(); }
});

test("startup and generation failures do not advertise a ready engine", async () => {
  const f = await setup("exit");
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "error");
    await f.controller.stop(); assert.equal(f.controller.snapshot().phase, "stopped");
    await rm(join(f.config.modelsDir, "scenario")); f.controller.start(f.config, "medium");
    await until(() => f.controller.snapshot().phase === "ready");
    f.controller.generate({ ...input, prompt: "fail" }); await until(() => f.controller.snapshot().phase === "error");
    await f.controller.stop(); assert.equal((await f.library.list()).length, 0);
  } finally { await f.close(); }
});

test("traversal, forged metadata, file symlinks and trash symlinks cannot delete/read outside tracks", async () => {
  const f = await completed();
  try {
    const [track] = await f.library.list();
    await assert.rejects(f.library.audio("../original")); await assert.rejects(f.library.remove("../original"));
    const path = join(f.config.outputsDir, track.id);
    const original = join(f.root, "outside.wav"); await writeFile(original, "outside");
    await rm(join(path, "audio.wav")); await symlink(original, join(path, "audio.wav"));
    await assert.rejects(f.library.audio(track.id));
    await mkdir(join(f.root, "outside")); await symlink(join(f.root, "outside"), join(f.config.outputsDir, ".trash"));
    await assert.rejects(f.library.remove(track.id)); assert.equal(await readFile(original, "utf8"), "outside");
    assert.deepEqual(await readdir(join(f.root, "outside")), []);
    await writeFile(join(path, "track.json"), JSON.stringify({ ...track, id: randomUUID() }));
    await assert.rejects(f.library.remove(track.id), /mismatch/);
    assert.deepEqual(await f.library.list(), []);
  } finally { await f.close(); }
});

test("generation prompts are data, not shell commands; missing binary gives actionable error", async () => {
  const f = await setup();
  try {
    f.controller.start({ ...f.config, binary: join(f.root, "not-installed") }, "medium");
    await until(() => f.controller.snapshot().phase === "error");
    assert.match(f.controller.snapshot().message, /ENOENT/);
    await f.controller.stop();
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    f.controller.generate({ ...input, prompt: 'jazz; $(touch /tmp/should-not-exist) " && exit' });
    await until(() => f.controller.snapshot().message === "Saved to library");
    const [track] = await f.library.list(); assert.ok(track.prompt.includes("$(touch"));
  } finally { await f.close(); }
});

test("save failure retains completed audio for retry without killing engine", async () => {
  const f = await setup();
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    await rm(f.config.outputsDir, { recursive: true }); await writeFile(f.config.outputsDir, "blocked");
    f.controller.generate(input); await until(() => f.controller.snapshot().phase === "ready" && f.controller.snapshot().pendingSave);
    assert.throws(() => f.controller.generate(input), /recovered take/);
    await f.controller.stop(); assert.equal(f.controller.snapshot().pendingSave, true);
    await rm(f.config.outputsDir); await f.controller.retrySave(f.config);
    assert.equal((await f.library.list()).length, 1); assert.equal(f.controller.snapshot().pendingSave, false);
  } finally { await f.close(); }
});

test("escaped long metadata and symlinked output roots remain readable/deletable", async () => {
  const f = await completed();
  try {
    const [original] = await f.library.list();
    const bytes = (await f.library.audio(original.id)).base64;
    const track = { ...original, id: randomUUID(), prompt: "\u0001".repeat(2000) };
    await f.library.save(track, bytes);
    assert.equal((await f.library.list()).length, 2);
    const linked = join(f.root, "linked"); await symlink(f.config.outputsDir, linked);
    const library = new Library(linked); assert.equal((await library.list()).length, 2);
    await library.audio(track.id); await library.remove(track.id);
    assert.equal((await f.library.list()).length, 1);
  } finally { await f.close(); }
});

test("resident backend keeps one engine loaded through a sequential batch and records every variation", async () => {
  const f = await setup();
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    const pid = await readFile(join(f.config.modelsDir, "engine.pid"), "utf8");
    f.controller.generateBatch({ ...input, seed: 7, count: 3, variations: ["bright brass", "soft piano"] });
    await until(() => f.controller.snapshot().batch?.state === "completed");
    assert.equal(f.controller.snapshot().phase, "ready"); assert.equal(f.controller.snapshot().batch?.completed, 3);
    assert.equal(await readFile(join(f.config.modelsDir, "engine.pid"), "utf8"), pid);
    assert.doesNotThrow(() => process.kill(Number(pid), 0));
    const tracks = (await f.library.list()).sort((a, b) => a.seed - b.seed);
    assert.deepEqual(tracks.map((t) => t.seed), [7, 8, 9]);
    assert.deepEqual(tracks.map((t) => t.prompt), [input.prompt + "\nbright brass", input.prompt + "\nsoft piano", input.prompt + "\nbright brass"]);
  } finally { await f.close(); }
});

test("engine exit during a completed take's save marks the batch failed, not cancelled, and keeps the take", async () => {
  const f = await setup("exit-after-audio"), save = Library.prototype.save;
  let release!: () => void, saving = false;
  const gate = new Promise<void>((r) => { release = r; });
  try {
    Library.prototype.save = async function (track, audio) { saving = true; await gate; return save.call(this, track, audio); };
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    f.controller.generateBatch({ ...input, seed: 7, count: 3, variations: [] });
    await until(() => saving && f.controller.snapshot().phase === "error");
    release(); await until(() => f.controller.snapshot().batch?.state === "failed");
    assert.equal(f.controller.snapshot().phase, "error");
    assert.equal((await f.library.list()).length, 1);
    assert.equal(f.controller.snapshot().batch?.completed, 1);
  } finally { release(); Library.prototype.save = save; await f.close(); }
});

test("resident backend batch failure stops its engine and preserves earlier saved takes", async () => {
  const f = await setup("seed-fail");
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    const pid = Number(await readFile(join(f.config.modelsDir, "engine.pid"), "utf8"));
    f.controller.generateBatch({ ...input, seed: 7, count: 3, variations: [] });
    await until(() => f.controller.snapshot().phase === "error");
    assert.equal((await f.library.list()).length, 1);
    assert.deepEqual(f.controller.snapshot().batch, { total: 3, current: 2, completed: 1, state: "failed" });
    assert.throws(() => process.kill(pid, 0));
  } finally { await f.close(); }
});

test("wrong model fails promptly rather than being swallowed as a startup timeout", async () => {
  const f = await setup("wrong-model");
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "error");
    assert.match(f.controller.snapshot().message, /Unexpected model/);
  } finally { await f.close(); }
});

test("plug-in owner SIGKILL kills its engine; stopping does not touch unrelated processes", async () => {
  const f = await setup();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const owner = spawn(process.execPath, ["--import", "tsx", "tests/owner-fixture.ts", JSON.stringify(f.config)], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await Promise.race([new Promise<void>((resolve) => owner.stdout.on("data", (data) => { if (String(data).includes("ready")) resolve(); })), delay(8000).then(() => { throw new Error("Owner did not become ready"); })]);
    const pid = Number(await readFile(join(f.config.modelsDir, "engine.pid"), "utf8"));
    const closed = once(owner, "close"); owner.kill("SIGKILL"); await closed;
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 6000);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally {
    owner.kill("SIGKILL"); const exit = once(unrelated, "close"); unrelated.kill(); await exit; await f.close();
  }
});

test("invalid completed resident audio fails the take without wedging recovery; the next launch generates", async () => {
  for (const scenario of ["invalid-audio", "header-only"]) {
    const f = await setup(scenario);
    try {
      f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
      f.controller.generate(input); await until(() => f.controller.snapshot().phase === "error");
      const state = f.controller.snapshot();
      assert.equal(state.pendingSave, false, scenario); assert.match(state.message, /unusable audio; nothing was saved \(Invalid WAV/);
      await f.controller.retrySave(f.config); await f.controller.stop();
      await rm(join(f.config.modelsDir, "scenario"));
      f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
      f.controller.generate(input); await until(() => f.controller.snapshot().message === "Saved to library");
      assert.equal((await f.library.list()).length, 1);
      assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".pending-")), []);
    } finally { await f.close(); }
  }
});

test("a healthy save never reports pendingSave; only a failed save does", async () => {
  const f = await setup(), save = Library.prototype.save;
  let release!: () => void, saving = false;
  const gate = new Promise<void>((r) => { release = r; });
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    Library.prototype.save = async function (track, audio) { saving = true; await gate; return save.call(this, track, audio); };
    f.controller.generate(input); await until(() => saving);
    assert.equal(f.controller.snapshot().phase, "generating"); assert.equal(f.controller.snapshot().pendingSave, false);
    assert.throws(() => f.controller.generate(input), /wait until Ready/);
    release(); await until(() => f.controller.snapshot().message === "Saved to library");
    assert.equal(f.controller.snapshot().pendingSave, false);
    Library.prototype.save = async () => { throw new Error("Synthetic disk failure"); };
    f.controller.generate(input); await until(() => f.controller.snapshot().pendingSave);
    assert.equal(f.controller.snapshot().phase, "ready"); assert.match(f.controller.snapshot().message, /Retry save/);
    Library.prototype.save = save; await f.controller.retrySave(f.config);
    assert.equal(f.controller.snapshot().pendingSave, false); assert.equal((await f.library.list()).length, 2);
  } finally { release(); Library.prototype.save = save; await f.close(); }
});

test("resident completions consume the engine's audio copy, including when the save fails", async () => {
  const f = await setup(), jobs = async () => JSON.parse(await readFile(join(f.config.modelsDir, "jobs.json"), "utf8"));
  try {
    f.controller.start(f.config, "medium"); await until(() => f.controller.snapshot().phase === "ready");
    f.controller.generate(input); await until(() => f.controller.snapshot().message === "Saved to library");
    assert.deepEqual(await jobs(), { retained: 0, consumed: 1 });
    await rm(f.config.outputsDir, { recursive: true }); await writeFile(f.config.outputsDir, "blocked");
    f.controller.generate(input); await until(() => f.controller.snapshot().phase === "ready" && f.controller.snapshot().pendingSave);
    assert.deepEqual(await jobs(), { retained: 0, consumed: 2 }); // The controller's retained copy is the only one left.
    await f.controller.stop(); await rm(f.config.outputsDir); await f.controller.retrySave(f.config);
    assert.equal(f.controller.snapshot().pendingSave, false); assert.equal((await f.library.list()).length, 1);
  } finally { await f.close(); }
});
