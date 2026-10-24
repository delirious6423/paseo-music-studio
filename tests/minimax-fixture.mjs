#!/usr/bin/env node
// MiniMax CLI contract double; runs only with disposable-VM fixture directories, never GPU models.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
const { values } = parseArgs({ options: Object.fromEntries(["models", "request", "out", "device"].map((key) => [key, { type: "string" }])) });
const request = JSON.parse(readFileSync(values.request, "utf8"));
assert.ok(request.lyrics.trim()); assert.ok(request.steps >= 2); assert.ok(request.lm_seed >= 0);
appendFileSync(join(values.models, "seen.jsonl"), JSON.stringify({ ...request, requestPath: values.request, pid: process.pid }) + "\n");
if (request.caption === "fail") process.exit(9);
if (request.caption === "slow") { process.stderr.write("[AR] Frame 100/1500\n[DiT] Win"); setTimeout(() => process.stderr.write("dow 1/3: T=689, 30 steps\n"), 20); setInterval(() => {}, 1000); }
else {
  const count = request.lm_batch_size * request.synth_batch_size, extension = extname(values.out), stem = values.out.slice(0, -extension.length);
  for (let song = 0; song < request.lm_batch_size; song++) for (let variation = 0; variation < request.synth_batch_size; variation++) {
    const path = stem + (count > 1 ? `${song}${variation}` : "") + extension;
    let bytes;
    if (request.output_format === "mp3") {
      bytes = Buffer.alloc(417 * 2); bytes.set([255, 251, 144, 0], 0); bytes.set([255, 251, 144, 0], 417);
    } else {
      const bits = request.output_format === "wav24" ? 24 : request.output_format === "wav32" ? 32 : 16, data = bits / 8 * 2;
      bytes = Buffer.alloc(44 + data); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
      bytes.writeUInt16LE(bits === 32 ? 3 : 1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(16000 * bits / 8, 28);
      bytes.writeUInt16LE(bits / 8, 32); bytes.writeUInt16LE(bits, 34); bytes.write("data", 36); bytes.writeUInt32LE(data, 40);
    }
    writeFileSync(path, bytes, { flag: "wx" });
    writeFileSync(path.slice(0, -extension.length) + ".json", JSON.stringify({ ...request, seed: request.seed + variation, lm_seed: request.lm_seed + song, audio_codes: request.audio_codes || "1,2,3,4,5,6,7,8" }));
  }
  // Assert no shell interpretation of paths containing spaces.
  assert.equal(dirname(values.out), dirname(stem));
}
