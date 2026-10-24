// Native guest smoke for the command backend. Bundle on the controller; run only in an owned VM.
// Prints one PASS/FAIL line per check; exit 1 on FAIL.
import { execFileSync } from "node:child_process";
import { Downloads } from "../../server/downloads";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AUDIO_CHUNK_BYTES, configSchema } from "../../shared/music";
import { MusicController, modelCatalog } from "../../server/controller";
import { Library } from "../../server/library";
import { assembleAudio } from "../../client/audio";

if (process.env.PASEO_MUSIC_VM !== "1") throw new Error("Run only inside an owned disposable native VM with PASEO_MUSIC_VM=1");
const root = resolve(process.argv[2] ?? ".");
let failed = 0;
const report = (status: "PASS" | "FAIL", name: string, detail = "") => {
  if (status === "FAIL") failed++;
  console.log(`${status}: ${name}${detail ? " · " + detail : ""}`);
};
async function until(fn: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!await fn()) { if (Date.now() > end) return false; await delay(50); }
  return true;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const input = { title: "Native smoke", prompt: "jazz; & | \"quotes\" %PATH% ^caret", duration: 1, seed: 7, steps: 8 };

async function fixture(id: string, args: string[], timeoutSeconds = 30) {
  const dir = await mkdtemp(join(tmpdir(), "studio-native-"));
  const config = configSchema.parse({ outputsDir: join(dir, "library"), profiles: [{ id, label: id, backend: "command", binary: process.execPath, timeoutSeconds, args }] });
  return { dir, config, controller: new MusicController(), library: new Library(config.outputsDir) };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  f.controller.start(f.config, id);
  return until(() => f.controller.snapshot().phase === "ready");
}

console.log(`Node ${process.version} ${process.platform}/${process.arch}`);
const [expectedOS, expectedArch] = process.argv.slice(3);
if (!expectedOS || !expectedArch) throw new Error("Supply fixture root, expected platform and native architecture");
report(process.platform === expectedOS && process.arch === expectedArch ? "PASS" : "FAIL", "native runtime", `${process.platform}/${process.arch}, expected ${expectedOS}/${expectedArch}`);

// 1. Tone CLI: generate, save, list, read, recoverable delete, stop.
{
  const f = await fixture("tone", [join(root, "examples", "tone-cli.mjs"), "--prompt={prompt}", "--output={output}", "--duration={duration}", "--seed={seed}"]);
  try {
    const catalog = (await modelCatalog(f.config)).map((m) => m.id).join(",");
    report(catalog === "tone" ? "PASS" : "FAIL", "catalog lists command profile", catalog);
    report(await ready(f, "tone") ? "PASS" : "FAIL", "command backend ready without child", f.controller.snapshot().message);
    f.controller.generate(input);
    const saved = await until(() => f.controller.snapshot().message === "Saved to library", 30000);
    const tracks = await f.library.list();
    report(saved && tracks.length === 1 && tracks[0].seed === 7 && tracks[0].backend === "command" ? "PASS" : "FAIL", "generate + library save", f.controller.snapshot().message);
    if (tracks[0]) {
      const audio = Buffer.from((await f.library.audio(tracks[0].id)).base64, "base64");
      report(audio.toString("ascii", 0, 4) === "RIFF" && audio.length === 44 + 16000 * 2 ? "PASS" : "FAIL", "saved WAV readable", `${audio.length} bytes`);
      await f.library.remove(tracks[0].id);
      const trash = await readdir(join(f.config.outputsDir, ".trash"));
      report((await f.library.list()).length === 0 && trash.length === 1 ? "PASS" : "FAIL", "delete moves track to .trash");
    }
    const staging = (await readdir(f.config.outputsDir)).filter((p) => p.startsWith(".command-"));
    report(staging.length === 0 ? "PASS" : "FAIL", "staging folder removed");
    await f.controller.stop();
    report(f.controller.snapshot().phase === "stopped" ? "PASS" : "FAIL", "stop");
  } catch (error) { report("FAIL", "tone CLI flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// One archive download must extract on the native platform's independent ZIP reader.
{
  const f = await fixture("zip-tone", [join(root, "examples", "tone-cli.mjs"), "--prompt={prompt}", "--output={output}", "--duration={duration}", "--seed={seed}"]);
  const downloads = new Downloads(() => "127.0.0.1");
  try {
    if (!await ready(f, "zip-tone")) throw new Error(f.controller.snapshot().message);
    for (let i = 0; i < 2; i++) {
      f.controller.generate({ ...input, title: "ZIP take " + i });
      if (!await until(() => f.controller.snapshot().message === "Saved to library")) throw new Error(f.controller.snapshot().message);
    }
    const tracks = await f.library.list(), link = await downloads.create(f.library, tracks.map((t) => t.id));
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30000);
    const response = await fetch(link.url, { signal: abort.signal }), zip = join(f.dir, "batch.zip"), output = join(f.dir, "extracted");
    clearTimeout(timer);
    if (response.status !== 200 || response.headers.get("content-type") !== "application/zip") throw new Error("ZIP HTTP failed");
    await writeFile(zip, Buffer.from(await response.arrayBuffer()));
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:MUSIC_TEST_ZIP,$env:MUSIC_TEST_OUTPUT)"], { timeout: 15000, env: { ...process.env, MUSIC_TEST_ZIP: zip, MUSIC_TEST_OUTPUT: output } });
    } else execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])", zip, output], { timeout: 15000 });
    const names = (await readdir(output)).sort();
    const expected = await Promise.all(tracks.map((t) => f.library.file(t.id)));
    let exact = names.length === 2;
    for (const [i, name] of names.entries()) exact &&= (await readFile(join(output, name))).equals(expected[i].bytes);
    report(exact ? "PASS" : "FAIL", "batch ZIP extracts byte-exact WAVs with native reader");
    const removed = await f.library.removeBatch(tracks.map((t) => t.id)), trash = await readdir(join(f.config.outputsDir, ".trash"));
    let preserved = removed.deleted.length === 2 && removed.failed.length === 0 && (await f.library.list()).length === 0 && trash.length === 2;
    for (const [i, track] of tracks.entries()) {
      const entry = trash.find((name) => name.startsWith(track.id + "-"));
      preserved &&= !!entry && (await readFile(join(f.config.outputsDir, ".trash", entry!, "audio.wav"))).equals(expected[i].bytes);
    }
    report(preserved && (await fetch(link.url)).status === 404 ? "PASS" : "FAIL", "batch delete keeps exact WAVs in trash and revokes old ZIP access");
  } catch (error) { report("FAIL", "batch ZIP native extraction", String(error)); }
  finally { await downloads.close(); await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// The long-duration path must work on each native target, not just accept a new input label.
{
  const f = await fixture("long-tone", [join(root, "examples", "tone-cli.mjs"), "--prompt={prompt}", "--output={output}", "--duration={duration}", "--seed={seed}"]);
  try {
    if (!await ready(f, "long-tone")) throw new Error(f.controller.snapshot().message);
    f.controller.generate({ ...input, duration: 380 });
    const saved = await until(() => f.controller.snapshot().message === "Saved to library", 30000);
    const tracks = await f.library.list(), file = tracks[0] && await f.library.file(tracks[0].id);
    report(saved && tracks.length === 1 && tracks[0].duration === 380 && file?.bytes.length === 44 + 380 * 16000 * 2 ? "PASS" : "FAIL", "380-second CLI generation + metadata + WAV", f.controller.snapshot().message);
    if (!file || !tracks[0]) throw new Error("Long tone missing");
    const large = Buffer.alloc(44 + 380 * 44100 * 4); file.bytes.copy(large, 0, 0, 44);
    large.writeUInt32LE(large.length - 8, 4); large.writeUInt16LE(2, 22); large.writeUInt32LE(44100, 24);
    large.writeUInt32LE(176400, 28); large.writeUInt16LE(4, 32); large.writeUInt32LE(large.length - 44, 40);
    await writeFile(join(f.config.outputsDir, tracks[0].id, "audio.wav"), large);
    let rejected = false;
    try { await f.library.audio(tracks[0].id); } catch (error) { rejected = String(error).includes("Use Download"); }
    report(rejected && (await f.library.list())[0].audioBytes === large.length && (await f.library.file(tracks[0].id)).bytes.length === large.length ? "PASS" : "FAIL", "full-size stereo WAV retained; legacy oversized RPC rejected safely");
    let chunks = 0;
    const assembled = await assembleAudio(tracks[0].id, ({ id }) => f.library.audioInfo(id), async ({ id, offset, version }) => {
      chunks++; const part = await f.library.audioChunk(id, offset, version);
      if (part.base64.length > AUDIO_CHUNK_BYTES / 3 * 4) throw new Error("Chunk too large");
      return part;
    }, new AbortController().signal);
    report(chunks === Math.ceil(large.length / AUDIO_CHUNK_BYTES) && Buffer.from(assembled.base64, "base64").equals(large) ? "PASS" : "FAIL", "full-size WAV chunk assembly byte-exact");
  } catch (error) { report("FAIL", "380-second CLI flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// 2. Abort a hanging CLI with a child process: the owned tree must end both.
{
  const f = await fixture("hang", [join(root, "tests", "command-fixture.mjs"), "--prompt={prompt}", "--output={output}", "--scenario=hang", "--state=STATE"]);
  const state = join(f.dir, "state.json");
  f.config.profiles![0].args = f.config.profiles![0].args.map((a) => a.replace("STATE", state));
  try {
    await ready(f, "hang");
    f.controller.generate(input);
    const started = await until(async () => { try { await readFile(state); return true; } catch { return false; } });
    const pids = started ? JSON.parse(await readFile(state, "utf8")) as { parent: number; child: number } : null;
    await f.controller.stop(true);
    const gone = pids ? await until(() => !alive(pids.parent) && !alive(pids.child), 10000) : false;
    report(gone && (await f.library.list()).length === 0 ? "PASS" : "FAIL", "abort ends CLI and its child (owned tree)", pids ? `parent ${pids.parent} ${alive(pids.parent) ? "alive" : "gone"}, child ${pids.child} ${alive(pids.child) ? "alive" : "gone"}` : "fixture never started");
    if (pids) for (const pid of [pids.parent, pids.child]) if (alive(pid)) process.kill(pid);
  } catch (error) { report("FAIL", "abort flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// 3. Probe cleanup when the CLI exits with an unreferenced worker still running.
{
  const f = await fixture("background", [join(root, "tests", "command-fixture.mjs"), "--prompt={prompt}", "--output={output}", "--scenario=background", "--state=STATE"]);
  const state = join(f.dir, "state.json");
  f.config.profiles![0].args = f.config.profiles![0].args.map((a) => a.replace("STATE", state));
  try {
    await ready(f, "background");
    f.controller.generate(input);
    const saved = await until(() => f.controller.snapshot().message === "Saved to library", 20000);
    report(saved ? "PASS" : "FAIL", "normal exit saves take", f.controller.snapshot().message);
    const pids = JSON.parse(await readFile(state, "utf8")) as { parent: number; child: number };
    await delay(1500);
    if (alive(pids.child)) { report("FAIL", "background worker survives normal CLI exit", `pid ${pids.child}; killed by smoke`); process.kill(pids.child); }
    else report("PASS", "background worker cleaned after normal exit");
  } catch (error) { report("FAIL", "background flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// 4. Batch sequencing, distinct wrapped seeds, exact direction suffixes and no overlapping jobs.
{
  const f = await fixture("batch-tone", [join(root, "examples", "tone-cli.mjs"), "--prompt={prompt}", "--output={output}", "--duration={duration}", "--seed={seed}"]);
  try {
    await ready(f, "batch-tone");
    f.controller.generateBatch({ ...input, seed: Number.MAX_SAFE_INTEGER - 1, count: 3, variations: ["bright brass", "soft piano"] });
    let rejected = false;
    try { f.controller.generate(input); } catch { rejected = true; }
    report(rejected ? "PASS" : "FAIL", "batch rejects overlapping generation");
    const completed = await until(() => f.controller.snapshot().batch?.state === "completed", 30000);
    const tracks = await f.library.list();
    report(completed && tracks.length === 3 && f.controller.snapshot().batch?.completed === 3 && f.controller.snapshot().phase === "ready" ? "PASS" : "FAIL", "batch saves three takes before Ready", f.controller.snapshot().message);
    const byIndex = [1, 2, 3].map((i) => tracks.find((t) => t.title === `${input.title} · ${i}/3`));
    report(byIndex.every((t, i) => t?.seed === [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, 0][i] && t.prompt === input.prompt + "\n" + ["bright brass", "soft piano", "bright brass"][i]) ? "PASS" : "FAIL", "batch records wrapped distinct seeds and cycling prompts");
  } catch (error) { report("FAIL", "batch tone flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// 5. A failure on take 2 stops the queue while take 1 stays saved.
{
  const f = await fixture("batch-fail", [join(root, "tests", "command-fixture.mjs"), "--prompt={prompt}", "--output={output}", "--seed={seed}", "--scenario=seed-fail", "--state=STATE"]);
  f.config.profiles![0].args = f.config.profiles![0].args.map((a) => a.replace("STATE", join(f.dir, "state.json")));
  try {
    await ready(f, "batch-fail"); f.controller.generateBatch({ ...input, count: 3, variations: [] });
    await until(() => f.controller.snapshot().phase === "error");
    const b = f.controller.snapshot().batch;
    report(b?.state === "failed" && b.current === 2 && b.completed === 1 && (await f.library.list()).length === 1 ? "PASS" : "FAIL", "failed batch stops remaining queue and keeps prior save");
  } catch (error) { report("FAIL", "batch failure flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

// 6. Abort take 2, including its worker; take 1 stays saved and take 3 never starts.
{
  const f = await fixture("batch-hang", [join(root, "tests", "command-fixture.mjs"), "--prompt={prompt}", "--output={output}", "--seed={seed}", "--scenario=seed-hang", "--state=STATE"]);
  const state = join(f.dir, "state.json");
  f.config.profiles![0].args = f.config.profiles![0].args.map((a) => a.replace("STATE", state));
  try {
    await ready(f, "batch-hang"); f.controller.generateBatch({ ...input, count: 3, variations: [] });
    const started = await until(async () => { try { return Boolean(JSON.parse(await readFile(state, "utf8")).child); } catch { return false; } });
    const pids = started ? JSON.parse(await readFile(state, "utf8")) as { parent: number; child: number } : null;
    await f.controller.stop(true);
    const b = f.controller.snapshot().batch;
    report(b?.state === "cancelled" && b.current === 2 && b.completed === 1 && (await f.library.list()).length === 1 ? "PASS" : "FAIL", "batch Abort cancels queued takes and keeps prior save");
    const gone = pids ? await until(() => !alive(pids.parent) && !alive(pids.child), 10000) : false;
    report(gone ? "PASS" : "FAIL", "batch Abort cleans current CLI and worker");
    if (pids) for (const pid of [pids.parent, pids.child]) if (alive(pid)) process.kill(pid);
  } catch (error) { report("FAIL", "batch abort flow", String(error)); }
  finally { await f.controller.stop(true).catch(() => {}); await rm(f.dir, { recursive: true, force: true }); }
}

console.log(failed ? `RESULT: FAIL (${failed})` : "RESULT: PASS");
process.exit(failed ? 1 : 0);
