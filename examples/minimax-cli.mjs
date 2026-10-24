// Local MiniMax Music 3 Q8_0 adapter; user-installed engine/weights, no downloads or shell.
import { parseArgs } from "node:util";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
const { values } = parseArgs({ options: Object.fromEntries([
  "engine", "models", "output", "prompt", "duration", "steps", "seed", "device", "options", "options-file",
].map((key) => [key, { type: "string" }])) });
const duration = Number(values.duration), steps = Number(values.steps), seed = Number(values.seed);
if (!["engine", "models", "output"].every((key) => values[key] && isAbsolute(values[key]))) throw new Error("Use absolute --engine, --models and --output paths");
if (!Number.isFinite(duration) || duration <= 0 || duration > 360) throw new Error("New MiniMax songs support positive durations up to the 360-second LM frame budget");
if (!Number.isInteger(steps) || steps < 2 || steps > 2147483646) throw new Error("MiniMax requires at least 2 steps, within its C++ integer representation");
if (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) throw new Error("Supply a concrete seed within JSON’s exact integer range");
const options = JSON.parse(values["options-file"] ? await readFile(values["options-file"], "utf8") : values.options ?? "{}");
if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("--options must be a JSON object");
const caption = options.caption ?? values.prompt;
if (typeof caption !== "string" || !caption.trim()) throw new Error("Supply a music description in the options file or with --prompt");
function number(key, fallback, minimum, maximum, integer = true) {
  const value = options[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < minimum || value > maximum) throw new Error(`Invalid MiniMax option: ${key}`);
  return value;
}
const format = options.format ?? "mp3", lyrics = options.lyrics ?? "[instrumental]", audioCodes = options.audioCodes ?? "";
if (!["mp3", "wav16", "wav24", "wav32"].includes(format)) throw new Error("Choose mp3, wav16, wav24 or wav32");
if (typeof lyrics !== "string" || !lyrics.trim()) throw new Error("Supply lyrics or an instrumental section tag");
if (typeof audioCodes !== "string" || (audioCodes && !/^-?\d+(?:,-?\d+)*$/.test(audioCodes))) throw new Error("audioCodes must be a comma-separated integer string");
const lmBatch = number("lmBatch", 1, 1, 2147483647), synthBatch = number("synthBatch", 1, 1, 9);
if (audioCodes && lmBatch !== 1) throw new Error("Code replay replaces song generation; set songs per native batch to 1");
const lmSeed = number("lmSeed", -1, -1, Number.MAX_SAFE_INTEGER);
if (lmSeed < 0) throw new Error("Studio must resolve the independent random LM seed before launching");
if (seed > Number.MAX_SAFE_INTEGER - synthBatch + 1 || lmSeed > Number.MAX_SAFE_INTEGER - lmBatch + 1) throw new Error("Native batch seed offsets exceed JSON’s exact integer range");
const components = {
  lm_model: "MiniMax-Music3-language_model-Q8_0.gguf", depth_model: "MiniMax-Music3-rvq_depth_decoder-Q8_0.gguf",
  cond_model: "MiniMax-Music3-condition_encoder-F32.gguf", dit_model: "MiniMax-Music3-transformer-Q8_0.gguf", vae_model: "MiniMax-Music3-vocoder-F32.gguf",
};
const requestData = { ...components, caption, lyrics, duration, steps, seed, lm_seed: lmSeed,
  lm_cfg: number("lmCfg", 1.5, -Infinity, Infinity, false), dit_cfg: number("ditCfg", 1.7, -Infinity, Infinity, false),
  lm_top_k: number("topK", 50, 1, 2147483647), peak_clip: number("peakClip", 10, 0, 999),
  lm_batch_size: lmBatch, synth_batch_size: synthBatch, output_format: format,
  mp3_bitrate: number("mp3Bitrate", 128, 1, 320), ...(audioCodes ? { audio_codes: audioCodes } : {}) };
if (![32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320].includes(requestData.mp3_bitrate)) throw new Error("Choose a supported MPEG-1 Layer III bitrate");
const extension = format === "mp3" ? "mp3" : "wav", tracks = [];
let manifestBytes = Buffer.byteLength('{"tracks":[]}');
for (let song = 0; song < lmBatch; song++) for (let variation = 0; variation < synthBatch; variation++) {
  const stem = "audio-" + String(tracks.length).padStart(4, "0");
  const track = { file: stem + "." + extension, replayFile: stem + ".json", seed: seed + variation, lmSeed: lmSeed + song };
  manifestBytes += Buffer.byteLength(JSON.stringify(track)) + (tracks.length ? 1 : 0);
  if (manifestBytes > 1024 * 1024) throw new Error("Native batch exceeds Studio’s 1 MiB import-manifest budget; use smaller batches");
  tracks.push(track);
}
await access(values.engine, process.platform === "win32" ? constants.F_OK : constants.X_OK);
for (const name of Object.values(components)) await access(join(values.models, name), constants.R_OK);
const folder = await mkdtemp(join(dirname(values.output), ".minimax-request-"));
try {
  const request = join(folder, "request.json");
  await writeFile(request, JSON.stringify(requestData), { flag: "wx", mode: 0o600 });
  const nativeBase = join(dirname(values.output), "native." + extension);
  const args = ["--models", values.models, "--request", request, "--out", nativeBase];
  if (values.device) args.push("--device", values.device);
  await new Promise((resolve, reject) => {
    const child = spawn(values.engine, args, { shell: false, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`MiniMax engine failed (${signal ?? code})`)));
  });
  for (let i = 0; i < tracks.length; i++) {
    const index = tracks.length === 1 ? "" : `${Math.floor(i / synthBatch)}${i % synthBatch}`, nativeStem = join(dirname(values.output), "native" + index);
    const { file, replayFile } = tracks[i];
    const replay = JSON.parse(await readFile(nativeStem + ".json", "utf8"));
    if (typeof replay.audio_codes !== "string" || !replay.audio_codes) throw new Error("MiniMax returned no replay codes");
    await rename(nativeStem + "." + extension, join(dirname(values.output), file));
    await rename(nativeStem + ".json", join(dirname(values.output), replayFile));
  }
  await writeFile(values.output + ".manifest.json", JSON.stringify({ tracks }), { flag: "wx", mode: 0o600 });
} finally { await rm(folder, { recursive: true, force: true }); }
