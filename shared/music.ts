import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const variant = z.enum(["medium", "small-music", "small-sfx"]);
export const MAX_AUDIO_BYTES = 128 * 1024 * 1024; // Operational import/storage guard (a 360 s 44.1 kHz wav32 take is ~121 MiB).
export const audioMime = z.enum(["audio/wav", "audio/mpeg"]);
// Studio's track.json storage guard, not a model token limit; audio codes live in a separate replay file.
export const MAX_METADATA_BYTES = 65536;
export const AUDIO_CHUNK_BYTES = 3 * 1024 * 1024; // Divisible by three: complete base64 chunks concatenate without padding.
export const MAX_PLAYBACK_BYTES = 17 * 1024 * 1024; // Audio base64, then relay encryption/base64 + envelope must fit 32 MiB.
// Representational guard, not a model limit: engines parse steps as a C++ int and compute steps + 1.
export const MAX_STEPS = 2147483646;
export const MAX_TIMEOUT_SECONDS = 2147483; // Node timers use signed 32-bit milliseconds; not a model limit.
const stepCount = z.number().int().min(1).max(MAX_STEPS);
// Optional per-profile facts from the backend; absent means the Studio defaults (380 s or 120 s for Small,
// at least 1 step, Studio default 8). 380 s is Studio's own global duration cap.
// controls: "minimax" enables the MiniMax option panel and its {minimax} placeholder (absolute path of a
// JSON file holding minimaxOptions with lmSeed resolved plus caption = the prompt, so no long text needs argv)
// for that profile only; such profiles may omit {prompt}.
export const modelLimits = { maxDurationSeconds: z.number().int().min(1).max(380).optional(), minSteps: stepCount.optional(), defaultSteps: stepCount.optional(), controls: z.literal("minimax").optional() };
export type ModelLimits = { maxDurationSeconds?: number; minSteps?: number; defaultSteps?: number; controls?: "minimax" };
export function durationLimit(model: string, limits: ModelLimits = {}) { return limits.maxDurationSeconds ?? (model === "small-music" || model === "small-sfx" ? 120 : 380); }
export function minSteps(limits: ModelLimits = {}) { return limits.minSteps ?? 1; }
const absolutePath = z.string().min(1).max(4096).refine((path) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(path), "Use an absolute path");
const unsetPath = absolutePath.or(z.literal(""));
export const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, "Use a short model ID containing letters, numbers, dots, underscores or hyphens");
export const commandProfile = z.object({
  id: modelId.refine((id) => !variant.options.includes(id as z.infer<typeof variant>), "This ID is reserved for Stable Audio"),
  label: z.string().trim().min(1).max(80),
  backend: z.literal("command"),
  binary: absolutePath.refine((p) => !/\.(?:bat|cmd)$/i.test(p), "Use an executable interpreter, not a .bat/.cmd shell script"),
  timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).default(300),
  ...modelLimits,
  args: z.array(z.string().max(8192)).min(1).max(128),
}).refine((p) => p.defaultSteps === undefined || p.defaultSteps >= (p.minSteps ?? 1), "defaultSteps must be at least minSteps")
.refine((p) => p.args.every((arg) => [...arg.matchAll(/\{([a-z_]+)\}/g)].every((m) => ["prompt", "duration", "seed", "steps", "output", ...(p.controls === "minimax" ? ["minimax"] : [])].includes(m[1]))), "Unknown argument placeholder")
.refine((p) => p.controls !== "minimax" || p.args.some((arg) => arg === "{minimax}" || /^--[a-zA-Z0-9_-]+=\{minimax\}$/.test(arg)), "MiniMax controls need {minimax} (the options file path) as its own argument or --options-file={minimax}")
.refine((p) => p.args.every((arg) => !arg.includes("{minimax}") || arg === "{minimax}" || /^--[a-zA-Z0-9_-]+=\{minimax\}$/.test(arg)), "Use {minimax} as its own argument or --options-file={minimax}")
.refine((p) => p.args.every((arg) => !arg.includes("{prompt}") || arg === "{prompt}" || /^--[a-zA-Z0-9_-]+=/.test(arg)), "Use {prompt} as its own argument or --prompt={prompt}")
.refine((p) => p.args.some((arg) => arg.includes("{output}")) && (p.controls === "minimax" || p.args.some((arg) => arg.includes("{prompt}"))), "Arguments must include {output}, and generic profiles {prompt}");
export const commandProfiles = z.array(commandProfile).max(32).refine((p) => new Set(p.map((m) => m.id)).size === p.length, "Model IDs must be unique").refine((p) => JSON.stringify(p).length <= 65536, "Command profiles must fit within 64K JSON characters");
export type CommandProfile = z.infer<typeof commandProfile>;
export const configSchema = z.object({
  binary: unsetPath.default(""),
  modelsDir: unsetPath.default(""),
  outputsDir: unsetPath.default(""),
  profiles: commandProfiles.optional(),
});
export type Config = z.infer<typeof configSchema>;
export const settings = defineSettings({ id: "engine", scope: "host", version: 2, schema: configSchema, migrate: (values, fromVersion) => { if (fromVersion !== 1) throw new Error("Unsupported settings version"); return values; } });
// Engines seed with uint64 (sa3, MiniMax mt19937_64/philox); the cap is JSON's exact-integer range, not a model limit.
// -1 means random (resolved as uint32).
export const MAX_SEED = Number.MAX_SAFE_INTEGER;
const seed = z.number().int().min(-1).max(MAX_SEED);
const nextSeed = (start: number, i: number) => Number((BigInt(start) + BigInt(i)) % BigInt(MAX_SEED + 1));
const cInt = z.number().int().min(1).max(2147483647); // C++ int guard, not a model limit.
// MPEG-1 Layer III bitrates accepted by minimaxmusic.cpp's mp3enc (mp3/mp3enc-tables.h).
export const MP3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const minimaxShape = z.object({
  lyrics: z.string().trim().min(1).max(20000).default("[instrumental]"),
  lmSeed: seed.default(-1),
  lmCfg: z.number().default(1.5),
  ditCfg: z.number().default(1.7),
  topK: cInt.default(50),
  peakClip: z.number().int().min(0).max(999).default(10),
  format: z.enum(["mp3", "wav16", "wav24", "wav32"]).default("mp3"),
  mp3Bitrate: z.number().int().refine((b) => MP3_BITRATES.includes(b), "Use a supported MP3 bitrate").default(128),
  lmBatch: cInt.default(1),
  synthBatch: z.number().int().min(1).max(9).default(1),
  audioCodes: z.string().min(1).max(1024 * 1024).optional(), // Operational request budget.
});
export const minimaxOptions = minimaxShape.refine((o) => !o.audioCodes || o.lmBatch === 1, { path: ["lmBatch"], message: "Song-code replay requires exactly one LM song; clear song codes to compose new songs" });
export type MinimaxOptions = z.infer<typeof minimaxOptions>;
export const generateInput = z.object({
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20000),
  duration: z.number().positive().max(durationLimit("medium")),
  steps: stepCount.default(8),
  seed: seed.default(-1),
  minimax: minimaxOptions.optional(),
});
export type GenerateInput = z.infer<typeof generateInput>;
// Saved metadata (title, direction, lyrics…) must fit track.json with room for system fields.
export function metadataFits(input: { title: string; prompt: string; minimax?: { lyrics?: string; audioCodes?: string } }) {
  const { audioCodes: _codes, ...minimax } = input.minimax ?? {};
  return new TextEncoder().encode(JSON.stringify({ ...input, minimax })).length <= MAX_METADATA_BYTES - 4096;
}
export const METADATA_MESSAGE = "Title, direction and lyrics must fit Studio's 64 KB track metadata (a storage guard, not a model limit)";
export const batchInput = generateInput.extend({
  count: z.number().int().min(1).max(20),
  variations: z.array(z.string().trim().min(1).max(20000)).max(20).default([]),
}).superRefine((input, ctx) => {
  if (input.variations.length > input.count) ctx.addIssue({ code: "custom", path: ["count"], message: "Use at least one take per variation line" });
  input.variations.forEach((variation, i) => {
    if ((input.prompt + "\n" + variation).length > 20000) ctx.addIssue({ code: "custom", path: ["variations", i], message: "Base direction plus variation must fit within 20000 characters" });
    else if (!metadataFits({ ...input, prompt: input.prompt + "\n" + variation })) ctx.addIssue({ code: "custom", path: ["variations", i], message: METADATA_MESSAGE });
  });
  if (!metadataFits(input)) ctx.addIssue({ code: "custom", path: ["prompt"], message: METADATA_MESSAGE });
});
export type BatchInput = z.infer<typeof batchInput>;
export function batchTakes(input: BatchInput, startingSeed: number): GenerateInput[] {
  input = batchInput.parse(input);
  const start = z.number().int().min(0).max(MAX_SEED).parse(startingSeed), lmSeed = input.minimax?.lmSeed ?? -1;
  const { count: _count, variations: _variations, ...take } = input;
  return Array.from({ length: input.count }, (_, i) => generateInput.parse({
    ...take,
    title: input.count === 1 ? input.title : `${input.title.slice(0, 60).replace(/[\uD800-\uDBFF]$/, "")} · ${i + 1}/${input.count}`,
    prompt: input.prompt + (input.variations.length ? "\n" + input.variations[i % input.variations.length] : ""),
    seed: nextSeed(start, i * (input.minimax?.synthBatch ?? 1)),
    // A fixed LM seed also counts up, so each take differs; -1 stays random per take.
    ...(input.minimax && { minimax: { ...input.minimax, lmSeed: lmSeed < 0 ? -1 : nextSeed(lmSeed, i * input.minimax.lmBatch) } }),
  }));
}
export const batchStatus = z.object({
  total: z.number().int().min(1).max(20), current: z.number().int().min(1).max(20),
  completed: z.number().int().min(0).max(20),
  state: z.enum(["running", "completed", "cancelled", "failed", "save-pending", "stopped"]),
});
export type BatchStatus = z.infer<typeof batchStatus>;
export const trackSchema = generateInput.extend({
  id: z.string().uuid(), model: modelId, createdAt: z.string().datetime(), audioBytes: z.number().int().nonnegative().optional(),
  backend: z.enum(["sa3", "command"]).optional(), seedForwarded: z.boolean().optional(), modelLabel: z.string().max(80).optional(),
  mimeType: audioMime.optional(), replayAvailable: z.boolean().optional(), audioSeconds: z.number().positive().optional(),
  // Saved tracks never gain the generation default: a missing format is not evidence of MP3.
  minimax: minimaxShape.extend({ format: minimaxOptions.shape.format.removeDefault().optional() }).optional(),
});
export type Track = z.infer<typeof trackSchema>;
export const snapshotSchema = z.object({
  phase: z.enum(["stopped", "starting", "ready", "generating", "stopping", "error"]),
  activity: z.string().max(250).optional(), elapsedSeconds: z.number().nonnegative().optional(), timeoutSeconds: z.number().positive().optional(),
  model: modelId.nullable(), backend: z.enum(["sa3", "command"]).nullable(), progress: z.number(), message: z.string(), log: z.string(), pendingSave: z.boolean(), batch: batchStatus.nullable().optional(),
});
const empty = z.object({});
export const setup = defineRpc({ name: "music.setup", input: empty, output: configSchema.nullable() });
export const status = defineRpc({ name: "music.status", input: empty, output: snapshotSchema });
export const modelInfo = z.object({ id: modelId, label: z.string(), backend: z.enum(["sa3", "command"]), timeoutSeconds: z.number().positive().optional(), ...modelLimits });
export const models = defineRpc({ name: "music.models", input: empty, output: z.array(modelInfo) });
export const start = defineRpc({ name: "music.start", input: z.object({ model: modelId }), output: snapshotSchema });
export const stop = defineRpc({ name: "music.stop", input: empty, output: snapshotSchema });
export const abort = defineRpc({ name: "music.abort", input: empty, output: snapshotSchema });
export const generate = defineRpc({ name: "music.generate", input: generateInput, output: snapshotSchema });
export const generateBatch = defineRpc({ name: "music.generate-batch", input: batchInput, output: snapshotSchema });
export const retrySave = defineRpc({ name: "music.retry-save", input: empty, output: snapshotSchema });
export const tracks = defineRpc({ name: "music.tracks", input: empty, output: z.array(trackSchema) });
const trackId = z.object({ id: z.string().uuid() });
export const audio = defineRpc({ name: "music.audio", input: trackId, output: z.object({ base64: z.string(), mimeType: audioMime }) });
// 4 bytes is the smallest possible audio file (an MP3 frame header); WAV validity is checked on import.
export const audioInfoSchema = z.object({ total: z.number().int().min(4).max(MAX_AUDIO_BYTES), version: z.string().regex(/^[a-f0-9]{64}$/), mimeType: audioMime.optional() });
export type AudioInfo = z.infer<typeof audioInfoSchema>;
export const audioChunkInput = trackId.extend({ offset: z.number().int().min(0).max(MAX_AUDIO_BYTES), version: audioInfoSchema.shape.version });
export const audioChunkSchema = audioInfoSchema.extend({ offset: z.number().int().min(0).max(MAX_AUDIO_BYTES), base64: z.string().min(4).max(AUDIO_CHUNK_BYTES / 3 * 4) });
export type AudioChunk = z.infer<typeof audioChunkSchema>;
export const audioInfo = defineRpc({ name: "music.audio-info", input: trackId, output: audioInfoSchema });
export const audioChunk = defineRpc({ name: "music.audio-chunk", input: audioChunkInput, output: audioChunkSchema });
export const downloadTarget = z.object({ kind: z.enum(["tailscale", "lan"]), address: z.string().min(7).max(15), interface: z.string().min(1).max(128), cidr: z.string().max(50).nullable() });
export type DownloadTarget = z.infer<typeof downloadTarget>;
export const downloadOptions = defineRpc({ name: "music.download-options", input: empty, output: z.array(downloadTarget) });
export const downloadInput = trackId.extend({ target: downloadTarget, acknowledged: z.literal(true) });
export const batchDownloadIds = z.array(z.string().uuid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, "Select each track only once");
export const downloadBatchInput = z.object({ ids: batchDownloadIds, target: downloadTarget, acknowledged: z.literal(true) });
export const downloadBatch = defineRpc({ name: "music.download-batch", input: downloadBatchInput, output: z.object({ url: z.string().url(), expiresAt: z.string().datetime() }) });
export const download = defineRpc({ name: "music.download", input: downloadInput, output: z.object({ url: z.string().url(), expiresAt: z.string().datetime() }) });
export const removeBatchInput = z.object({ ids: batchDownloadIds });
export const removeBatch = defineRpc({ name: "music.remove-batch", input: removeBatchInput, output: z.object({ deleted: z.array(z.string().uuid()).max(20), failed: z.array(z.object({ id: z.string().uuid(), error: z.string().max(500) })).max(20) }) });
export const remove = defineRpc({ name: "music.remove", input: trackId, output: z.object({ deleted: z.boolean() }) });
// Generation controls (incl. MiniMax song codes) of a saved track; loads the form, never starts a job.
export const replay = defineRpc({ name: "music.replay", input: trackId, output: generateInput });
