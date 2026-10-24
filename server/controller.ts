import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { MAX_AUDIO_BYTES, durationLimit, minSteps, type ModelLimits, metadataFits, METADATA_MESSAGE, minimaxOptions, configSchema, generateInput, type Config, type GenerateInput, type Track, type CommandProfile, batchInput, batchTakes, type BatchInput, type BatchStatus, modelId, variant } from "../shared/music";
import { Library, prepareTake, regular } from "./library";
import { guardScript } from "./guard";
import { MiniMaxProgress } from "./minimax-progress";

const sizes = { medium: ["1.5B", "same-l"], "small-music": ["0.5B", "same-s"], "small-sfx": ["0.5B", "same-s"] } as const;
type Model = string;
type Phase = "stopped" | "starting" | "ready" | "generating" | "stopping" | "error";
type Session = { abort: AbortController; child?: ChildProcess; exit?: Promise<void>; port?: number; task?: Promise<void>; config: Config; model: Model; profile?: CommandProfile; actualExitCode?: number | null; exitedBeforeAbort?: boolean };
const health = z.object({ loaded: z.boolean(), model: z.string(), encoding: z.string().optional() });
const seedValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER); // Native uint64 seeds within JSON's exact range.
// Written by a controls: "minimax" adapter next to {output}. Names are fixed patterns, never paths.
const manifestSchema = z.object({ tracks: z.array(z.object({ file: z.string().regex(/^audio-\d{4,}\.(?:wav|mp3)$/), seed: seedValue, lmSeed: seedValue, replayFile: z.string().regex(/^audio-\d{4,}\.json$/).optional() }).strict()).min(1) }).strict();
type NativeTake = { track: Track; file: string; replayFile?: string };
// Completed engine outputs (native names or normalized ones) are never deleted with the staging folder.
const ENGINE_OUTPUT = /^(?:native|audio-).*\.(?:wav|mp3)$/i;
const job = z.object({ status: z.string(), progress: z.number().optional(), error: z.string().optional(), audio_data: z.string().optional(), meta: z.object({ seed: z.number().int() }).optional() });

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
export async function installedModels(config: Config): Promise<Model[]> {
  if (!config.modelsDir || !config.binary) return [];
  const shared = ["t5gemma-b-b-ul2-encoder-0.3B-v1.0-F16.gguf", "t5gemma-b-b-ul2-v1.0-vocab.gguf"];
  const found: Model[] = [];
  for (const model of variant.options) {
    const [size, same] = sizes[model];
    const files = [...shared, `stable-audio-3-${model}-dit-${size}-v1.0-F16.gguf`, `stable-audio-3-${model}-${same}-v1.0-F16.gguf`, `stable-audio-3-${model}-conditioner-v1.0-F32.gguf`];
    try { await Promise.all(files.map((file) => access(join(config.modelsDir, file), constants.R_OK))); found.push(model); } catch { /* Not a complete installed F16 model. */ }
  }
  return found;
}

export async function modelCatalog(config: Config) {
  const models = (await installedModels(config)).map((id) => ({ id, label: id === "medium" ? "Stable Audio Medium · F16" : id === "small-music" ? "Stable Audio Small Music · F16" : "Stable Audio Small SFX · F16", backend: "sa3" as const }));
  const commands: ({ id: string; label: string; backend: "command" } & ModelLimits & { timeoutSeconds: number })[] = [];
  for (const { id, label, binary, maxDurationSeconds, minSteps, defaultSteps, controls, timeoutSeconds } of config.profiles ?? []) {
    try { await access(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK); commands.push({ id, label, backend: "command", timeoutSeconds, ...(maxDurationSeconds && { maxDurationSeconds }), ...(minSteps && { minSteps }), ...(defaultSteps && { defaultSteps }), ...(controls && { controls }) }); } catch { /* Only available executables appear. */ }
  }
  return [...models, ...commands];
}

export class MusicController {
  constructor(private readAudio = regular) {}
  private session?: Session;
  private phase: Phase = "stopped";
  private progress = 0;
  private activity?: string;
  private takeStarted?: number;
  private takeFinished?: number;
  private nativeSongs = 1;
  private nativeReplay = false;
  private message = "Engine stopped";
  private log = "";
  private generation?: Promise<void>;
  private pending?: { track: Track; audio: Buffer; replay?: string; batch?: BatchStatus; queued?: boolean };
  // Native outputs of one take not yet saved; they stay in the retained staging folder until saved.
  private queue?: { folder: string; takes: NativeTake[]; batch?: BatchStatus; skipped: string[] };
  private filesSaved = 0;
  private notice?: string; // A partial import outlives the generic "saved" messages.
  private batch?: BatchStatus;
  private saving?: Promise<void>;
  get config() { return this.session?.config; }
  // Only a retained take whose save failed is recoverable; an in-flight save is not an alarm.
  private get saveFailed() { return (!!this.pending || !!this.queue) && !this.saving; }
  snapshot() { return { ...(this.phase === "generating" && this.activity && { activity: this.activity }), ...(this.phase === "generating" && this.session?.profile && this.takeStarted !== undefined && { elapsedSeconds: Math.max(0, Math.floor(((this.takeFinished ?? Date.now()) - this.takeStarted) / 1000)), timeoutSeconds: this.session.profile.timeoutSeconds }), phase: this.phase, model: this.session?.model ?? null, backend: this.session ? (this.session.profile ? "command" as const : "sa3" as const) : null, progress: this.progress, message: this.message, log: this.log, pendingSave: this.saveFailed, batch: this.batch ?? null }; }
  private record(chunk: unknown) { this.log = (this.log + String(chunk)).slice(-12000); }
  private async request(s: Session, path: string, body?: unknown, timeout = 10000) {
    if (this.session !== s || s.abort.signal.aborted || !s.child || s.child.exitCode !== null || s.child.signalCode !== null) throw new Error("Engine stopped");
    const requestAbort = new AbortController();
    const cancel = () => requestAbort.abort();
    s.abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, timeout);
    try {
      const response = await fetch(`http://127.0.0.1:${s.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestAbort.signal,
      });
      const text = await response.text();
      if (text.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 1024 * 1024) throw new Error("Engine response too large");
      if (!response.ok) throw new Error(`Engine HTTP ${response.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text) as unknown;
    } finally { clearTimeout(timer); s.abort.signal.removeEventListener("abort", cancel); }
  }
  start(config: Config, model: Model) {
    config = configSchema.parse(config); model = modelId.parse(model);
    if (this.session || this.phase === "stopping") throw new Error("Stop the current engine before changing models");
    const profile = config.profiles?.find((p) => p.id === model);
    if (!profile && !variant.safeParse(model).success) throw new Error("Configure this model in Settings before launching it");
    if (!isAbsolute(config.outputsDir)) throw new Error("Configure an absolute music output folder in Settings first");
    if (!profile && (!isAbsolute(config.binary) || !isAbsolute(config.modelsDir))) throw new Error("Configure the Stable Audio executable and model folder, or add a custom command profile");
    const s: Session = { config, model, profile, abort: new AbortController() };
    this.session = s; this.phase = "starting"; this.progress = 0; this.log = ""; this.message = profile ? "Starting command backend…" : "Starting and validating F16 model…";
    s.task = this.boot(s).catch(async (error: unknown) => {
      if (s.abort.signal.aborted) return;
      this.message = error instanceof Error ? error.message : String(error);
      this.record(this.message); this.phase = "stopping";
      try { await this.terminate(s); if (this.session === s) this.session = undefined; }
      catch (error) { this.record(String(error)); }
      this.phase = "error";
    });
    return this.snapshot();
  }
  private async boot(s: Session) {
    await access(s.profile?.binary ?? s.config.binary, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    if (!s.profile && !(await installedModels(s.config)).includes(s.model)) throw new Error("Selected model's complete F16 files were not found");
    await mkdir(s.config.outputsDir, { recursive: true });
    if (s.abort.signal.aborted) throw new Error("Engine stopped");
    if (s.profile) { this.phase = "ready"; this.message = "Ready · command runs per take; model loads during generation"; return; }
    s.port = await freePort();
    if (s.abort.signal.aborted) throw new Error("Engine stopped");
    const args = ["--host", "127.0.0.1", "--port", String(s.port), "--model", s.model, "--encoding", "f16", "--ae-encoding", "f16", "--t5-encoding", "f16", "--threads", "6", "--models-dir", s.config.modelsDir];
    const child = this.spawnOwned(s, s.config.binary, args, s.config.outputsDir);
    await this.waitForEngine(s, child);
  }
  private spawnOwned(s: Session, binary: string, args: string[], cwd: string) {
    if (s.abort.signal.aborted) throw new Error("Engine stopped");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|SystemRoot|TEMP|TMP|TMPDIR|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|CUDA_VISIBLE_DEVICES|CUDA_DEVICE_ORDER)$/i.test(key)));
    // Electron's executable also runs Node when ELECTRON_RUN_AS_NODE is set.
    s.actualExitCode = undefined; s.exitedBeforeAbort = undefined;
    const child = spawn(process.execPath, ["-e", guardScript, binary, ...args], { cwd, detached: process.platform !== "win32", shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...env, ELECTRON_RUN_AS_NODE: "1", SA3_ENV_FILE: process.platform === "win32" ? "NUL" : "/dev/null", SA3_MAX_DURATION: String(durationLimit(s.model, s.profile)) } });
    s.child = child;
    child.on("message", (message) => {
      const result = z.object({ type: z.literal("engine-exit"), code: z.number().int().nullable() }).safeParse(message);
      if (result.success && s.child === child) { s.actualExitCode = result.data.code; s.exitedBeforeAbort = !s.abort.signal.aborted; }
    });
    child.stdin?.on("error", () => {}); // A closed watchdog pipe is handled by its exit event.
    s.exit = new Promise<void>((resolve) => {
      child.once("error", (error) => { this.record(error.message); resolve(); });
      child.once("close", (code, signal) => {
        if (!s.profile && this.session === s && !s.abort.signal.aborted && this.phase !== "error" && this.phase !== "stopping") {
          this.phase = "error"; this.message = `Engine exited (${s.actualExitCode ?? code ?? signal})`; s.abort.abort(); this.session = undefined;
        }
        resolve();
      });
    });
    const stages = s.profile?.controls === "minimax" ? new MiniMaxProgress(this.nativeSongs, this.nativeReplay) : undefined;
    for (const stream of ["stdout", "stderr"] as const) {
      const update = (activity?: string) => { if (activity && this.session === s && s.child === child && this.phase === "generating" && !s.abort.signal.aborted) this.activity = activity; };
      child[stream]?.on("data", (data) => { this.record(data); update(stages?.push(String(data), stream)); });
      child[stream]?.once("end", () => update(stages?.finish(stream)));
    }
    return child;
  }
  private async waitForEngine(s: Session, child: ChildProcess) {
    const deadline = Date.now() + 60000;
    let responsive = false;
    while (Date.now() < deadline) {
      if (s.abort.signal.aborted) throw new Error("Engine stopped");
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) throw new Error("Engine failed to start; check its log");
      let response: unknown;
      try { response = await this.request(s, "/health", undefined, 1000); }
      catch { await delay(150, undefined, { signal: s.abort.signal }); continue; }
      const h = health.parse(response);
      if (h.model !== s.model || (!s.profile && h.encoding?.toLowerCase() !== "f16")) throw new Error("Unexpected model or precision");
      responsive = true; break;
    }
    if (!responsive) throw new Error("Engine startup timed out after 60 seconds");
    await this.request(s, "/load", {}, 60000);
    const ready = health.parse(await this.request(s, "/health"));
    if (!ready.loaded) throw new Error("Engine did not initialize the model");
    if (s.abort.signal.aborted) throw new Error("Engine stopped");
    this.phase = "ready"; this.message = "Ready · F16 · local engine";
  }
  generate(input: GenerateInput) {
    return this.begin([generateInput.parse(input)]);
  }
  generateBatch(input: BatchInput) {
    input = batchInput.parse(input);
    const takes = batchTakes(input, input.seed < 0 ? randomInt(4294967296) : input.seed);
    return this.begin(takes, { total: takes.length, current: 1, completed: 0, state: "running" });
  }
  private begin(inputs: GenerateInput[], batch?: BatchStatus) {
    const s = this.session;
    if (!s || this.phase !== "ready") throw new Error("Launch the model and wait until Ready before generating");
    if (this.pending || this.queue) throw new Error("Save the recovered take before generating another");
    // Every RPC path (single or batch) is bounded by the active profile, not only by the UI.
    const limit = durationLimit(s.model, s.profile), floor = minSteps(s.profile), minimax = s.profile?.controls === "minimax";
    if (inputs.some((input) => input.duration > limit)) throw new Error(`${s.model} supports at most ${limit} seconds per take`);
    if (inputs.some((input) => input.steps < floor)) throw new Error(`${s.model} needs at least ${floor} steps per take`);
    if (s.profile && !minimax && inputs.some((input) => !Number.isInteger(input.duration))) throw new Error(`${s.model} takes whole seconds`);
    if (!minimax && inputs.some((input) => input.minimax)) throw new Error(`${s.model} does not accept MiniMax options`);
    if (minimax) inputs = inputs.map((input) => ({ ...input, minimax: minimaxOptions.parse(input.minimax ?? {}) }));
    // The engine derives per-song/per-render seeds as base + index; each must stay an exact JSON integer.
    if (inputs.some((input) => input.minimax && (input.seed > Number.MAX_SAFE_INTEGER - (input.minimax.synthBatch - 1) || input.minimax.lmSeed > Number.MAX_SAFE_INTEGER - (input.minimax.lmBatch - 1)))) throw new Error(`Seed plus native batch size must stay within ${Number.MAX_SAFE_INTEGER}`);
    if (!inputs.every(metadataFits)) throw new Error(METADATA_MESSAGE);
    this.batch = batch; this.filesSaved = 0; this.notice = undefined; this.activity = undefined; this.takeStarted = undefined;
    this.phase = "generating"; this.progress = 0; this.message = "Generating…";
    this.generation = (async () => {
      for (let i = 0; i < inputs.length; i++) {
        if (s.abort.signal.aborted) break;
        if (batch) batch.current = i + 1;
        this.progress = 0;
        await this.run(s, inputs[i]);
        if (this.pending || this.queue || (batch && batch.state !== "running")) break;
      }
      if (batch?.state === "running") batch.state = s.abort.signal.aborted ? (this.phase === "error" ? "failed" : "cancelled") : "completed";
      if (!s.abort.signal.aborted) {
        this.phase = "ready"; this.progress = 100;
        const files = this.filesSaved > (batch?.completed ?? 1) ? ` (${this.filesSaved} files)` : "";
        if (!this.pending && !this.queue) this.message = this.notice ?? (batch ? `${batch.completed}/${batch.total} takes saved to library` : "Saved to library") + files;
      }
    })().catch(async (error: unknown) => {
      if (batch?.state === "running") batch.state = "failed";
      if (s.abort.signal.aborted) return;
      this.message = (batch ? `Take ${batch.current}/${batch.total}: ` : "") + (error instanceof Error ? error.message : String(error)); this.record(this.message);
      // Unknown/failed HTTP state might still be consuming GPU; never advertise Ready.
      this.phase = "stopping"; s.abort.abort();
      try { await this.terminate(s); if (this.session === s) this.session = undefined; }
      catch (error) { this.record(String(error)); }
      this.phase = "error";
    });
    return this.snapshot();
  }
  private async saveTake(s: Session, input: GenerateInput, seed: number, audio: string | Buffer) {
    const track = this.track(s, input, seed);
    // Unsaveable output fails the take here; only valid audio is retained for Retry save.
    let prepared;
    try { prepared = prepareTake(track, audio); }
    catch (error) { throw new Error(`${s.profile ? "Command" : "Engine"} returned unusable audio; nothing was saved (${error instanceof Error ? error.message : String(error)})`); }
    // A backend-declared successful take survives Abort racing its import/save.
    this.pending = { track: prepared.track, audio: prepared.bytes, batch: this.batch };
    try { await this.retrySave(s.config); }
    catch (error) {
      if (this.batch?.state === "running") this.batch.state = "save-pending";
      this.message = `Take retained in memory; queue stopped. Fix output path/free disk and Retry save: ${String(error)}`; this.record(this.message);
    }
  }
  private async runCommand(s: Session, input: GenerateInput) {
    const profile = s.profile!;
    this.takeStarted = Date.now(); this.takeFinished = undefined; this.activity = profile.controls === "minimax" ? "Preparing MiniMax generation…" : undefined;
    this.nativeSongs = input.minimax?.lmBatch ?? 1; this.nativeReplay = !!input.minimax?.audioCodes;
    const seed = input.seed < 0 ? randomInt(4294967296) : input.seed;
    const options = input.minimax && { ...input.minimax, lmSeed: input.minimax.lmSeed < 0 ? randomInt(4294967296) : input.minimax.lmSeed };
    if (input.prompt.trimStart().startsWith("-") && profile.args.includes("{prompt}")) throw new Error("A standalone prompt cannot begin with '-'; configure --prompt={prompt} instead");
    const folder = await mkdtemp(join(s.config.outputsDir, ".command-"));
    let timer: ReturnType<typeof setTimeout> | undefined, retain = false;
    try {
      const output = join(folder, "audio.wav");
      // Options (up to 1 MiB of song codes) go in an owned file: argv is limited to 128 KiB per string on Linux, 32K on Windows.
      const optionsFile = join(folder, "minimax-options.json");
      if (options) await writeFile(optionsFile, JSON.stringify({ ...options, caption: input.prompt }), { flag: "wx", mode: 0o600 });
      const values = { prompt: input.prompt, duration: input.duration, steps: input.steps, seed, output, minimax: optionsFile };
      const args = profile.args.map((arg) => arg.replace(/\{(prompt|duration|seed|steps|output|minimax)\}/g, (_, key: keyof typeof values) => String(values[key])));
      const child = this.spawnOwned(s, profile.binary, args, folder);
      await Promise.race([s.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Command generation timed out")), profile.timeoutSeconds * 1000); })]);
      this.takeFinished = Date.now();
      clearTimeout(timer);
      if (s.abort.signal.aborted && !s.exitedBeforeAbort) throw new Error("Engine stopped");
      if (s.actualExitCode !== 0) throw new Error(`Command exited (${s.actualExitCode ?? child.exitCode ?? child.signalCode}); check its log`);
      if (!options) { await this.saveTake(s, input, seed, await this.readAudio(output, MAX_AUDIO_BYTES)); return; }
      this.activity = "Checking generated audio and replay files…";
      // Validate the whole manifest and every file before the first save, then import sequentially.
      let manifest;
      try { manifest = manifestSchema.parse(JSON.parse((await regular(output + ".manifest.json", 1024 * 1024)).toString("utf8"))); }
      catch (error) { throw new Error(`Command returned an invalid manifest; nothing was saved (${error instanceof Error ? error.message : String(error)})`); }
      const files = manifest.tracks.map((t) => t.file);
      if (new Set(files).size !== files.length) throw new Error("Command manifest lists a file twice; nothing was saved");
      if (manifest.tracks.length > options.lmBatch * options.synthBatch) throw new Error("Command manifest lists more outputs than requested; nothing was saved");
      if (manifest.tracks.some((t) => t.replayFile && t.replayFile.replace(/\.json$/, "") !== t.file.replace(/\.\w+$/, ""))) throw new Error("Command manifest replay names do not match their audio; nothing was saved");
      // Several native outputs get distinct "· file i/n" titles within the 100-character limit.
      const label = (i: number) => { const n = manifest.tracks.length, suffix = ` · file ${i + 1}/${n}`; return n === 1 ? input.title : input.title.slice(0, 100 - suffix.length).replace(/[\uD800-\uDBFF]$/, "") + suffix; };
      const takes = manifest.tracks.map((t, i): NativeTake => ({ file: t.file, replayFile: t.replayFile, track: this.track(s, { ...input, title: label(i), minimax: { ...options, lmSeed: t.lmSeed } }, t.seed, t.file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav") }));
      for (const take of takes) {
        try { await this.loadNative(folder, take); }
        catch (error) { throw new Error(`Command returned unusable output ${take.file}; nothing was saved (${error instanceof Error ? error.message : String(error)})`); }
      }
      // From here the queue owns the folder: it is removed only after its last file is saved.
      this.queue = { folder, takes, batch: this.batch, skipped: [] }; retain = true;
      try { await this.retrySave(s.config); }
      catch (error) {
        if (this.batch?.state === "running") this.batch.state = "save-pending";
        this.message = `Save failed; queue stopped. ${this.queue?.takes.length ?? 0} unsaved output(s) kept in ${folder}. Fix output path/free disk and Retry save: ${String(error)}`; this.record(this.message);
      }
    } finally {
      clearTimeout(timer);
      // Owned staging goes even if termination failed; that error (a still-live worker) still propagates.
      // A hard crash of the daemon here leaves a hidden .command-* folder that is never auto-deleted.
      try { await this.terminate(s); }
      finally {
        if (!retain) retain = (await readdir(folder).catch(() => [])).some((name) => ENGINE_OUTPUT.test(name)) && this.keep(folder);
        if (!retain) await rm(folder, { recursive: true, force: true }).catch((error) => this.record(`Cannot remove command staging ${folder}: ${String(error)}`));
      }
    }
  }
  private keep(folder: string) { this.record(`Engine outputs were not imported; kept in ${folder}`); return true; }
  private track(s: Session, input: GenerateInput, seed: number, mimeType?: Track["mimeType"]): Track {
    return { ...input, seed, id: randomUUID(), model: s.model, backend: s.profile ? "command" : "sa3", seedForwarded: s.profile ? s.profile.args.some((a) => a.includes("{seed}")) : true, modelLabel: s.profile?.label ?? s.model, createdAt: new Date().toISOString(), ...(mimeType && { mimeType }) };
  }
  // Re-reads and re-validates one native output (regular file, no symlinks) right before use.
  private async loadNative(folder: string, take: NativeTake) {
    const audio = await this.readAudio(join(folder, take.file), MAX_AUDIO_BYTES);
    const replay = take.replayFile && (await regular(join(folder, take.replayFile), 4 * 1024 * 1024)).toString("utf8");
    const prepared = prepareTake(take.track, audio, replay);
    return { track: prepared.track, audio: prepared.bytes, replay };
  }
  private async run(s: Session, input: GenerateInput) {
    if (s.profile) return this.runCommand(s, input);
    const response = z.object({ session_id: z.string(), seed: z.number().int().optional() }).parse(await this.request(s, "/generate", { ...input, keep_models: true }));
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      if (s.abort.signal.aborted) throw new Error("Engine stopped");
      // consume=1 lets the engine drop its copy once completed audio is delivered; engines without it ignore the query.
      const result = job.parse(await this.request(s, `/poll_status/${encodeURIComponent(response.session_id)}?consume=1`));
      this.progress = Math.max(0, Math.min(100, result.progress ?? 0)); this.message = result.status;
      if (result.status === "failed") throw new Error(result.error ?? "Generation failed");
      if (result.status === "completed") {
        if (!result.audio_data) throw new Error("Completed generation had no audio");
        const seed = result.meta?.seed ?? response.seed ?? input.seed;
        if (seed < 0) throw new Error("Engine did not return the generation seed");
        await this.saveTake(s, input, seed, result.audio_data);
        return;
      }
      await delay(300, undefined, { signal: s.abort.signal });
    }
    throw new Error("Generation timed out after thirty minutes");
  }
  async retrySave(config: Config) {
    if (this.saving) { await this.saving; return this.snapshot(); }
    if (!this.pending && !this.queue) return this.snapshot();
    this.saving = (async () => {
      const library = new Library(config.outputsDir);
      for (;;) {
        // A queued native take is loaded (and revalidated) only when its turn comes.
        const queue = this.queue;
        if (!this.pending && queue) {
          // A kept file that went missing or corrupt is skipped (and left on disk), never a permanent lock.
          try { this.pending = { ...await this.loadNative(queue.folder, queue.takes[0]), batch: queue.batch, queued: true }; }
          catch (error) { this.record(`Cannot import ${join(queue.folder, queue.takes[0].file)}: ${String(error)}`); queue.skipped.push(queue.takes.shift()!.file); }
        }
        const pending = this.pending;
        if (pending) {
          if (this.phase === "generating") this.activity = "Saving audio to library…";
        await library.save(pending.track, pending.audio, pending.replay);
          this.pending = undefined; this.filesSaved++;
        }
        if (!pending || (pending.queued && queue)) {
          if (pending) queue!.takes.shift();
          if (queue!.takes.length) continue;
          this.queue = undefined;
          if (queue!.skipped.length) {
            // Partial import: keep the folder and do not count the take as completed.
            this.notice = `Partial import: ${queue!.skipped.length} output(s) unreadable (${queue!.skipped.join(", ")}); kept in ${queue!.folder}`; this.record(this.notice);
            if (queue!.batch && (queue!.batch.state === "running" || queue!.batch.state === "save-pending")) queue!.batch.state = "failed";
            break;
          }
          await rm(queue!.folder, { recursive: true, force: true }).catch((error) => this.record(`Cannot remove command staging ${queue!.folder}: ${String(error)}`));
        }
        // Batch progress counts outer takes: a native take is complete after its last output.
        if (pending?.batch) {
          pending.batch.completed++;
          if (pending.batch.state === "save-pending") pending.batch.state = "stopped";
        }
        break;
      }
      if (this.phase !== "generating") this.message = this.notice ?? "Saved to library";
    })();
    try { await this.saving; } finally { this.saving = undefined; }
    return this.snapshot();
  }
  private async terminate(s: Session) {
    const child = s.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // EOF reaches the watchdog on every OS; Windows kill() would bypass its handler.
    // Only this owned pipe/process, never process-name matching or unrelated servers.
    child.stdin?.end();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { if (process.platform === "win32") child.kill("SIGKILL"); else if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* The owned group may already have exited. */ } } }, 4000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([s.exit, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Engine did not exit; GPU driver may be stuck. Retry Stop.")), 7000); })]);
    } finally { clearTimeout(timer); clearTimeout(deadline); }
  }
  async stop(abort = false) {
    if (this.phase === "stopping") throw new Error("Engine is already stopping");
    if (this.phase === "generating" && !abort) throw new Error("Generation is running; use Abort generation to discard the unfinished take");
    if (this.batch?.state === "running") this.batch.state = "cancelled";
    const s = this.session;
    if (!s) { this.phase = "stopped"; this.message = "Engine stopped"; return this.snapshot(); }
    this.phase = "stopping"; s.abort.abort();
    try { await this.terminate(s); }
    catch (error) { this.phase = "error"; this.message = String(error); throw error; }
    await s.task;
    await this.generation;
    await this.saving?.catch(() => {});
    if (this.session === s) this.session = undefined;
    this.generation = undefined; this.phase = "stopped"; this.progress = 0;
    this.message = abort ? "Aborted · engine stopped · finished tracks kept" : "Engine stopped · GPU resources released";
    return this.snapshot();
  }
}
