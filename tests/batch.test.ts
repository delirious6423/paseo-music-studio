import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { batchInput, batchTakes, configSchema } from "../shared/music";
import { MusicController } from "../server/controller";
import { Library, regular } from "../server/library";

const input = { title: "Jazz", prompt: "instrumental jazz", duration: 1, steps: 8, seed: 7, count: 4, variations: ["bright brass", "gentle piano"] };
async function until(fn: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms;
  while (!await fn()) { if (Date.now() > end) throw new Error("Batch test timed out"); await delay(20); }
}
async function fixture(scenario = "ok", readAudio = regular) {
  const root = await mkdtemp(join(tmpdir(), "studio-batch-")), state = join(root, "state.json");
  const config = configSchema.parse({ outputsDir: join(root, "library"), profiles: [{
    id: "batch-fixture", label: "Batch fixture", backend: "command", binary: process.execPath, timeoutSeconds: 10,
    args: [resolve("tests/command-fixture.mjs"), "--prompt={prompt}", "--output={output}", "--seed={seed}", "--scenario=" + scenario, "--state=" + state],
  }] });
  const controller = new MusicController(readAudio), library = new Library(config.outputsDir);
  controller.start(config, "batch-fixture"); await until(() => controller.snapshot().phase === "ready");
  return { root, state, config, controller, library, async close() { await controller.stop(true); await rm(root, { recursive: true, force: true }); } };
}

test("batch planning validates the entire queue, cycles directions, numbers titles and wraps distinct seeds", () => {
  const takes = batchTakes(input, Number.MAX_SAFE_INTEGER - 1);
  assert.deepEqual(takes.map((t) => t.seed), [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, 0, 1]);
  assert.deepEqual(takes.map((t) => t.prompt), ["instrumental jazz\nbright brass", "instrumental jazz\ngentle piano", "instrumental jazz\nbright brass", "instrumental jazz\ngentle piano"]);
  assert.deepEqual(takes.map((t) => t.title), ["Jazz · 1/4", "Jazz · 2/4", "Jazz · 3/4", "Jazz · 4/4"]);
  assert(batchTakes({ ...input, title: "x".repeat(100) }, 0).every((t) => t.title.length < 70));
  for (const take of batchTakes({ ...input, title: "x" + "🎹".repeat(49) }, 0)) assert.doesNotThrow(() => encodeURIComponent(take.title));
  assert.equal(batchTakes({ ...input, count: 1, variations: [] }, 7)[0].title, input.title);
  const native = batchTakes(batchInput.parse({ ...input, count: 2, variations: [], minimax: { lmSeed: 10, lmBatch: 2, synthBatch: 3 } }), 7);
  assert.deepEqual(native.map((t) => [t.seed, t.minimax?.lmSeed]), [[7, 10], [10, 12]]); // Native groups do not overlap across outer takes.
  for (const bad of [
    { count: 0 }, { count: 21 }, { count: 1.5 }, { count: 1 }, { variations: [" "] },
    { prompt: "x".repeat(20000) }, { variations: Array(21).fill("jazz") }, { seed: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(batchInput.safeParse({ ...input, ...bad }).success, false, JSON.stringify(bad));
});

test("batch saves sequentially with exact variations and seeds, refuses overlap, and cleans staging before Ready", async () => {
  let activeReads = 0, peakReads = 0;
  const f = await fixture("ok", async (path, limit) => {
    activeReads++; peakReads = Math.max(peakReads, activeReads);
    try { await delay(20); return await regular(path, limit); } finally { activeReads--; }
  });
  try {
    const started = f.controller.generateBatch(input);
    assert.equal(started.phase, "generating"); assert.equal(started.batch?.state, "running");
    assert.throws(() => f.controller.generate(input), /wait until Ready/);
    assert.throws(() => f.controller.generateBatch(input), /wait until Ready/);
    await assert.rejects(f.controller.stop(), /use Abort/);
    await until(() => f.controller.snapshot().batch?.state === "completed");
    const state = f.controller.snapshot();
    assert.equal(state.phase, "ready"); assert.equal(state.batch?.completed, 4); assert.equal(state.batch?.current, 4);
    const tracks = (await f.library.list()).sort((a, b) => a.seed - b.seed);
    assert.deepEqual(tracks.map((t) => ({ title: t.title, prompt: t.prompt, seed: t.seed })), batchTakes(input, 7).map(({ title, prompt, seed }) => ({ title, prompt, seed })));
    assert.equal(new Set(tracks.map((t) => t.id)).size, 4); assert.equal(peakReads, 1);
    assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-")), []);
    f.controller.generate({ ...input, seed: 30 }); await until(() => f.controller.snapshot().phase === "ready");
    assert.equal(f.controller.snapshot().batch, null); assert.equal((await f.library.list()).length, 5);
  } finally { await f.close(); }
});

test("random batches resolve concrete distinct seeds and reject invalid plans before launching a take", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.controller.generateBatch({ ...input, count: 21 }));
    assert.equal(f.controller.snapshot().phase, "ready"); await assert.rejects(readFile(f.state));
    f.controller.generateBatch({ ...input, seed: -1, count: 3 }); await until(() => f.controller.snapshot().batch?.state === "completed");
    const tracks = await f.library.list(); assert.equal(tracks.length, 3);
    assert.equal(new Set(tracks.map((t) => t.seed)).size, 3);
    assert(tracks.every((t) => t.seed >= 0 && t.seed <= 4294967295));
  } finally { await f.close(); }
});

test("first or later generation failure stops the queue without deleting completed tracks", async () => {
  for (const seed of [7, 8]) {
    const f = await fixture("seed-fail");
    try {
      f.controller.generateBatch({ ...input, seed }); await until(() => f.controller.snapshot().phase === "error");
      const expected = seed === 7 ? 1 : 0, state = f.controller.snapshot();
      assert.equal((await f.library.list()).length, expected);
      assert.equal(state.batch?.state, "failed"); assert.equal(state.batch?.completed, expected); assert.equal(state.batch?.current, expected + 1);
      assert.equal(state.pendingSave, false);
      assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-")), []);
    } finally { await f.close(); }
  }
});

test("Abort kills the current batch CLI tree, discards queued takes and keeps earlier saves", async () => {
  const f = await fixture("seed-hang");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    f.controller.generateBatch(input);
    await until(async () => { try { return Boolean(JSON.parse(await readFile(f.state, "utf8")).child); } catch { return false; } });
    const pids = JSON.parse(await readFile(f.state, "utf8"));
    await f.controller.stop(true); await until(() => !alive(pids.parent) && !alive(pids.child));
    const state = f.controller.snapshot();
    assert.equal(state.phase, "stopped"); assert.equal(state.batch?.state, "cancelled");
    assert.equal(state.batch?.current, 2); assert.equal(state.batch?.completed, 1);
    assert.equal((await f.library.list()).length, 1);
    assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-")), []);
  } finally { await f.close(); }
});

test("Abort during completed-take import retains that take and never starts the next one", async () => {
  let didRead = false, release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = await fixture("ok", async (path, limit) => { const bytes = await regular(path, limit); didRead = true; await gate; return bytes; });
  try {
    f.controller.generateBatch(input); await until(() => didRead);
    const stopping = f.controller.stop(true); release(); await stopping;
    assert.equal((await f.library.list()).length, 1);
    assert.deepEqual(f.controller.snapshot().batch, { total: 4, current: 1, completed: 1, state: "cancelled" });
  } finally { release(); await f.close(); }
});

test("Abort during a failing save remains cancelled after recovery, without losing the finished take", async () => {
  const f = await fixture(), save = Library.prototype.save;
  let started = false, release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  try {
    Library.prototype.save = async () => { started = true; await gate; throw new Error("Synthetic disk failure"); };
    f.controller.generateBatch(input); await until(() => started);
    const stopping = f.controller.stop(true); release(); await stopping;
    assert.equal(f.controller.snapshot().pendingSave, true);
    assert.equal(f.controller.snapshot().batch?.state, "cancelled");
    Library.prototype.save = save; await f.controller.retrySave(f.config);
    assert.equal((await f.library.list()).length, 1);
    assert.equal(f.controller.snapshot().batch?.state, "cancelled");
    assert.equal(f.controller.snapshot().batch?.completed, 1);
  } finally { release(); Library.prototype.save = save; await f.close(); }
});

test("batch save failure retains the take, stops the queue, and Retry save does not restart queued jobs", async () => {
  const f = await fixture(), save = Library.prototype.save;
  try {
    Library.prototype.save = async function (track, audio) { if (track.seed === 8) throw new Error("Synthetic disk failure"); return save.call(this, track, audio); };
    f.controller.generateBatch(input); await until(() => f.controller.snapshot().phase === "ready" && f.controller.snapshot().pendingSave);
    assert.equal((await f.library.list()).length, 1);
    assert.deepEqual(f.controller.snapshot().batch, { total: 4, current: 2, completed: 1, state: "save-pending" });
    assert.throws(() => f.controller.generateBatch(input), /recovered take/);
    await f.controller.stop(); Library.prototype.save = save;
    await Promise.all([f.controller.retrySave(f.config), f.controller.retrySave(f.config)]);
    await delay(50);
    assert.equal((await f.library.list()).length, 2);
    assert.equal(f.controller.snapshot().pendingSave, false);
    assert.deepEqual(f.controller.snapshot().batch, { total: 4, current: 2, completed: 2, state: "stopped" });
  } finally { Library.prototype.save = save; await f.close(); }
});
