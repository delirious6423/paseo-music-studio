import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema, commandProfile, commandProfiles, durationLimit, generateInput, MAX_STEPS, minSteps, settings, trackSchema } from "../shared/music";
import { MusicController, modelCatalog } from "../server/controller";
import { Library, regular } from "../server/library";

async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (!await fn()) { if (Date.now() > end) throw new Error("Timed out"); await delay(20); }
}
async function fixture(scenario = "ok", timeoutSeconds = 5) {
  const root = await mkdtemp(join(tmpdir(), "studio-command-"));
  const state = join(root, "state.json");
  const config = configSchema.parse({ outputsDir: join(root, "library"), profiles: [{
    id: "example-synth", label: "Any model fixture", backend: "command", binary: process.execPath, timeoutSeconds,
    args: [resolve("tests/command-fixture.mjs"), "--prompt={prompt}", "--output={output}", "--seed={seed}", "--steps={steps}", "--duration={duration}", "--scenario=" + scenario, "--state=" + state],
  }] });
  const controller = new MusicController(), library = new Library(config.outputsDir);
  return { root, state, config, controller, library, async close() { await controller.stop(true); await rm(root, { recursive: true, force: true }); } };
}
const input = { title: "Other model", prompt: "jazz; $(touch bad) \"quotes\"", duration: 1, seed: -1, steps: 8 };
async function ready(f: Awaited<ReturnType<typeof fixture>>) { f.controller.start(f.config, "example-synth"); await until(() => f.controller.snapshot().phase === "ready"); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("empty first-run config is valid, v1 settings migrate without resetting paths, and profiles reject unsafe shell/unknown placeholders", async () => {
  assert.deepEqual(configSchema.parse({}), { binary: "", modelsDir: "", outputsDir: "" });
  const old = { binary: "/engine", modelsDir: "/models", outputsDir: "/music" };
  assert.deepEqual(await settings.migrate!(old, 1), old);
  const controller = new MusicController();
  assert.throws(() => controller.start(configSchema.parse({}), "medium"), /output folder/);
  const f = await fixture();
  try {
    const p = f.config.profiles![0];
    for (const bad of [{ ...p, id: "medium" }, { ...p, binary: "/bad.cmd" }, { ...p, binary: "relative" }, { ...p, args: ["{prompt}", "{output}", "{unknown}"] }, { ...p, args: ["-c", "prefix{prompt}", "{output}"] }]) assert.equal(commandProfiles.safeParse([bad]).success, false);
    assert.equal(commandProfiles.safeParse([p, p]).success, false);
  } finally { await f.close(); }
});

test("arbitrary model profile generates without HTTP/model server, records provenance, forwards exact argv and preserves legacy tracks", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await modelCatalog(f.config)).map((m) => m.id), ["example-synth"]);
    await ready(f);
    assert.equal(f.controller.snapshot().backend, "command");
    assert.match(f.controller.snapshot().message, /per take/);
    f.controller.generate(input); await until(() => f.controller.snapshot().message === "Saved to library");
    const [track] = await f.library.list(); assert.equal(track.model, "example-synth"); assert.equal(track.backend, "command");
    const argv = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(argv.prompt, input.prompt); assert.equal(argv.seed, String(track.seed)); assert.ok(track.seed >= 0); assert.equal(track.seedForwarded, true);
    const legacy = { ...track, model: "medium", backend: undefined, modelLabel: undefined, seedForwarded: undefined };
    assert.equal(trackSchema.parse(legacy).model, "medium");
    assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-")), []);
  } finally { await f.close(); }
});

test("command run clock freezes before a slow library save and disappears after completion", async () => {
  const f = await fixture(), save = Library.prototype.save;
  let entered = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  Library.prototype.save = async function (...args) { entered = true; await gate; return save.apply(this, args); };
  try {
    await ready(f); f.controller.generate(input);
    await until(() => entered);
    const clock = f.controller.snapshot().elapsedSeconds;
    assert.equal(typeof clock, "number");
    assert.equal(f.controller.snapshot().activity, "Saving audio to library…");
    await delay(1100);
    assert.equal(f.controller.snapshot().elapsedSeconds, clock, "Library I/O must not consume the completed engine budget");
    release(); await until(() => f.controller.snapshot().phase === "ready");
    assert.equal(f.controller.snapshot().elapsedSeconds, undefined);
    assert.equal(f.controller.snapshot().activity, undefined);
  } finally { release(); Library.prototype.save = save; await f.close(); }
});

test("failed, malformed, symlink and oversized command output never enters library", async () => {
  for (const scenario of ["fail", "invalid", "header-only", "symlink", "oversized"]) {
    const f = await fixture(scenario);
    try {
      await writeFile(f.state, "outside"); await ready(f);
      f.controller.generate(input); await until(() => f.controller.snapshot().phase === "error");
      assert.equal((await f.library.list()).length, 0); assert.equal(f.controller.snapshot().pendingSave, false);
      assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-")), []);
    } finally { await f.close(); }
  }
});

test("abort/timeout kills a running CLI and its child process group", async () => {
  for (const timeout of [false, true]) {
    const f = await fixture("hang", timeout ? 1 : 30);
    try {
      await ready(f); f.controller.generate(input);
      await until(async () => { try { await readFile(f.state); return true; } catch { return false; } });
      const pids = JSON.parse(await readFile(f.state, "utf8"));
      if (timeout) await until(() => f.controller.snapshot().phase === "error", 8000);
      else await f.controller.stop(true);
      await until(() => !alive(pids.parent) && !alive(pids.child));
      assert.equal((await f.library.list()).length, 0);
    } finally { await f.close(); }
  }
});

test("a completed take survives Abort racing its import and failed saves retain it for retry", async () => {
  const f = await fixture();
  let release!: () => void, didRead = false;
  const gate = new Promise<void>((r) => { release = r; });
  const controller = new MusicController(async (path, limit) => { const bytes = await regular(path, limit); didRead = true; await gate; return bytes; });
  try {
    controller.start(f.config, "example-synth"); await until(() => controller.snapshot().phase === "ready");
    controller.generate(input); await until(() => didRead || controller.snapshot().phase === "error");
    assert.equal(didRead, true, controller.snapshot().message);
    const stop = controller.stop(true); release(); await stop;
    assert.equal((await f.library.list()).length, 1);
  } finally { release(); await controller.stop(true); await f.close(); }
  const retry = await fixture();
  const save = Library.prototype.save;
  try {
    await ready(retry);
    Library.prototype.save = async () => { throw new Error("Synthetic disk failure"); };
    retry.controller.generate(input); await until(() => retry.controller.snapshot().pendingSave);
    await retry.controller.stop(true); Library.prototype.save = save;
    await retry.controller.retrySave(retry.config);
    assert.equal((await retry.library.list()).length, 1);
  } finally { Library.prototype.save = save; await retry.close(); }
});

test("the documented dependency-free tone example produces a valid WAV through the generic backend", async () => {
  const f = await fixture();
  try {
    f.config.profiles![0].args = [resolve("examples/tone-cli.mjs"), "--prompt={prompt}", "--output={output}", "--duration={duration}", "--seed={seed}"];
    await ready(f); f.controller.generate(input); await until(() => f.controller.snapshot().message === "Saved to library" || f.controller.snapshot().phase === "error");
    assert.equal(f.controller.snapshot().phase, "ready", f.controller.snapshot().message);
    const [track] = await f.library.list(), bytes = Buffer.from((await f.library.audio(track.id)).base64, "base64");
    assert.equal(bytes.length, 32044); assert.equal(bytes.readUInt32LE(24), 16000);
  } finally { await f.close(); }
});

test("Abort discards an unfinished command even if its SIGTERM handler writes a valid WAV and exits zero", async () => {
  const f = await fixture("graceful-abort", 30);
  try {
    await ready(f); f.controller.generate(input);
    await until(async () => { try { await readFile(f.state); return true; } catch { return false; } });
    await f.controller.stop(true);
    assert.equal((await f.library.list()).length, 0);
    assert.equal(f.controller.snapshot().pendingSave, false);
  } finally { await f.close(); }
});

test("standalone leading-dash prompt fails before executing the CLI or leaving staging", async () => {
  const f = await fixture();
  try {
    f.config.profiles![0].args = f.config.profiles![0].args.map((a) => a === "--prompt={prompt}" ? "{prompt}" : a);
    await ready(f); f.controller.generate({ ...input, prompt: "--output=/tmp/not-allowed" });
    await until(() => f.controller.snapshot().phase === "error");
    assert.match(f.controller.snapshot().message, /standalone prompt/);
    await assert.rejects(readFile(f.state));
    assert.deepEqual(await readdir(f.config.outputsDir), []);
  } finally { await f.close(); }
});

test("50 successful command exits flush their status and kill leftover background workers", async () => {
  const f = await fixture("background", 10);
  try {
    await ready(f);
    for (let n = 0; n < 50; n++) {
      f.controller.generate(input); await until(() => f.controller.snapshot().message === "Saved to library");
      const pids = JSON.parse(await readFile(f.state, "utf8"));
      if (process.platform !== "win32") await until(() => !alive(pids.child));
    }
    assert.equal((await f.library.list()).length, 50);
  } finally { await f.close(); }
});

test("fallback kills the owned process group when the guard is suspended", { skip: process.platform === "win32" }, async () => {
  const f = await fixture("stopped-guard", 30);
  try {
    await ready(f); f.controller.generate(input);
    await until(async () => { try { await readFile(f.state); return true; } catch { return false; } });
    const pids = JSON.parse(await readFile(f.state, "utf8"));
    await f.controller.stop(true);
    await until(() => !alive(pids.parent) && !alive(pids.child));
  } finally { await f.close(); }
});

test("command owner process-group SIGKILL terminates descendants; no shell interpolation or detached orphan", async () => {
  const f = await fixture("hang", 30);
  const owner = spawn(process.execPath, ["--import", "tsx", "tests/command-owner.ts", JSON.stringify(f.config), f.state], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"] });
  try {
    await until(async () => { try { await readFile(f.state); return true; } catch { return false; } });
    const pids = JSON.parse(await readFile(f.state, "utf8"));
    const done = once(owner, "close"); if (process.platform !== "win32") process.kill(-owner.pid!, "SIGKILL"); else owner.kill("SIGKILL"); await done;
    await until(() => !alive(pids.parent) && !alive(pids.child));
  } finally { owner.kill("SIGKILL"); await f.close(); }
});

test("command staging is removed even when termination fails, and the still-live-worker error is reported", async () => {
  const f = await fixture("hang", 1);
  const owned = f.controller as unknown as { terminate?: (s: unknown) => Promise<void> };
  const terminate = owned.terminate!.bind(f.controller);
  try {
    await ready(f);
    owned.terminate = async (s) => { await terminate(s); throw new Error("Synthetic stuck worker; Retry Stop."); };
    f.controller.generate(input);
    await until(async () => { try { await readFile(f.state); return true; } catch { return false; } });
    const pids = JSON.parse(await readFile(f.state, "utf8"));
    await until(() => f.controller.snapshot().phase === "error", 10000);
    assert.match(f.controller.snapshot().message, /Synthetic stuck worker/);
    assert.equal(f.controller.snapshot().pendingSave, false);
    assert.deepEqual((await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-")), []);
    await until(() => !alive(pids.parent) && !alive(pids.child));
  } finally { delete owned.terminate; await f.close(); }
});

test("optional profile bounds narrow seconds and raise the step floor on every RPC path, with no Studio step ceiling; old profiles keep 380 s / 1 step", async () => {
  const f = await fixture();
  try {
    const base = f.config.profiles![0];
    assert.deepEqual(Object.keys(commandProfile.parse(base)).sort(), Object.keys(base).sort(), "old profiles gain no keys");
    for (const bad of [{ maxDurationSeconds: 0 }, { maxDurationSeconds: 381 }, { maxDurationSeconds: 1.5 }, { minSteps: 0 }, { minSteps: MAX_STEPS + 1 }, { defaultSteps: 0 }, { minSteps: 2, defaultSteps: 1 }]) assert.equal(commandProfiles.safeParse([{ ...base, ...bad }]).success, false, JSON.stringify(bad));
    for (const good of [{ minSteps: 33 }, { minSteps: MAX_STEPS }, { minSteps: 2, defaultSteps: 30 }]) assert.equal(commandProfiles.safeParse([{ ...base, ...good }]).success, true, JSON.stringify(good));
    // Steps are bounded only by the C++ int guard (steps + 1 must fit), for every model and in saved metadata.
    for (const steps of [33, 100, 1000, MAX_STEPS]) { assert.equal(generateInput.parse({ ...input, steps }).steps, steps); assert.equal(trackSchema.parse({ ...input, seed: 1, steps, id: "0123abcd-0000-4000-8000-000000000000", model: "x", createdAt: new Date().toISOString() }).steps, steps); }
    for (const steps of [0, MAX_STEPS + 1, 2.5]) assert.equal(generateInput.safeParse({ ...input, steps }).success, false, String(steps));
    assert.deepEqual(await modelCatalog(f.config), [{ id: "example-synth", label: base.label, backend: "command", timeoutSeconds: base.timeoutSeconds }]);
    assert.equal(durationLimit(base.id, base), 380); assert.equal(minSteps(base), 1);
    assert.equal(durationLimit("small-music", {}), 120); assert.equal(durationLimit("medium"), 380);
    await ready(f);
    f.controller.generate({ ...input, duration: 380, steps: 1 }); await until(() => f.controller.snapshot().message === "Saved to library");
    await f.controller.stop();

    const bounded = configSchema.parse({ ...f.config, profiles: [{ ...base, maxDurationSeconds: 360, minSteps: 2, defaultSteps: 30 }] });
    assert.deepEqual(await modelCatalog(bounded), [{ id: "example-synth", label: base.label, backend: "command", timeoutSeconds: base.timeoutSeconds, maxDurationSeconds: 360, minSteps: 2, defaultSteps: 30 }]);
    f.controller.start(bounded, "example-synth"); await until(() => f.controller.snapshot().phase === "ready");
    for (const take of [{ duration: 361, steps: 2 }, { duration: 360, steps: 1 }]) {
      const error = take.duration > 360 ? /at most 360 seconds/ : /at least 2 steps/;
      assert.throws(() => f.controller.generate({ ...input, ...take }), error);
      assert.throws(() => f.controller.generateBatch({ ...input, ...take, count: 2, variations: [] }), error);
    }
    assert.equal(f.controller.snapshot().phase, "ready"); assert.equal(f.controller.snapshot().batch, null);
    f.controller.generateBatch({ ...input, duration: 360, steps: 2, count: 2, variations: [] });
    await until(() => f.controller.snapshot().batch?.state === "completed");
    const argv = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(argv.duration, "360"); assert.equal(argv.steps, "2");
    for (const steps of [33, 100]) {
      f.controller.generate({ ...input, duration: 360, steps }); await until(() => f.controller.snapshot().message === "Saved to library");
      assert.equal(JSON.parse(await readFile(f.state, "utf8")).steps, String(steps));
    }
    const tracks = await f.library.list();
    assert.equal(tracks.length, 5); assert.deepEqual(tracks.map((t) => t.steps).sort((a, b) => a - b), [1, 2, 2, 33, 100]);
  } finally { await f.close(); }
});
