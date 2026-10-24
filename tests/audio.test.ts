import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { wav } from "./wav-fixture";
import { Library } from "../server/library";
import { AUDIO_CHUNK_BYTES, MAX_PLAYBACK_BYTES, type AudioChunk } from "../shared/music";
import { assembleAudio } from "../client/audio";

async function fixture(length: number) {
  const root = await mkdtemp(join(tmpdir(), "music-chunks-")), id = randomUUID(), library = new Library(root);
  const bytes = wav(length, true);
  await library.save({ id, title: "Chunk test", prompt: "test", duration: 380, seed: 7, steps: 8, model: "medium", createdAt: new Date().toISOString() }, bytes.toString("base64"));
  return { id, root, library, bytes, close: () => rm(root, { recursive: true, force: true }) };
}

test("quick playback uses one bounded audio transfer and validates the file version", async () => {
  const f = await fixture(45);
  try {
    let calls = 0;
    const media = await assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async () => { throw new Error("must not request chunks"); }, new AbortController().signal, undefined, async ({ id }) => { calls++; return f.library.audio(id); });
    assert.equal(calls, 1); assert.deepEqual(Buffer.from(media.base64, "base64"), f.bytes);
    await assert.rejects(assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async () => { throw new Error("must not request chunks"); }, new AbortController().signal, undefined, async ({ id }) => {
      const audio = await f.library.audio(id);
      await writeFile(join(f.root, f.id, "audio.wav"), f.bytes);
      return audio;
    }), /changed or audio is incomplete/);
    await assert.rejects(assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async () => { throw new Error("must not request chunks"); }, new AbortController().signal, undefined, async () => ({ base64: "AAAA", mimeType: "audio/wav" })), /incomplete/);
    const abort = new AbortController();
    await assert.rejects(assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async () => { throw new Error("must not request chunks"); }, abort.signal, undefined, async ({ id }) => { const audio = await f.library.audio(id); abort.abort(); return audio; }), /cancelled/);
  } finally { await f.close(); }
});

test("quick playback falls back to chunks when the actual file exceeds the relay-safe size", async () => {
  const f = await fixture(MAX_PLAYBACK_BYTES + 1);
  try {
    let chunks = 0;
    const audio = await assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async ({ id, offset, version }) => { chunks++; return f.library.audioChunk(id, offset, version); }, new AbortController().signal, undefined, async () => { throw new Error("must not request oversized inline audio"); });
    assert.equal(chunks, Math.ceil(f.bytes.length / AUDIO_CHUNK_BYTES));
    assert.deepEqual(Buffer.from(audio.base64, "base64"), f.bytes);
  } finally { await f.close(); }
});

test("chunked assembly is byte-exact across base64 padding boundaries and full-size 380s audio", async () => {
  for (const length of [45, AUDIO_CHUNK_BYTES, AUDIO_CHUNK_BYTES + 1, AUDIO_CHUNK_BYTES + 2, 44 + 380 * 44100 * 4]) {
    const f = await fixture(length);
    try {
      let calls = 0; const progress: number[] = [];
      const media = await assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async ({ id, offset, version }) => {
        const chunk = await f.library.audioChunk(id, offset, version); calls++;
        assert.ok(chunk.base64.length <= AUDIO_CHUNK_BYTES / 3 * 4);
        const frameBytes = Buffer.byteLength(JSON.stringify(chunk)) + 65536;
        assert.ok(Math.ceil((frameBytes + 40) / 3) * 4 < 32 * 1024 * 1024);
        return chunk;
      }, new AbortController().signal, (p) => progress.push(p));
      assert.equal(calls, Math.ceil(length / AUDIO_CHUNK_BYTES));
      assert.equal(media.mimeType, "audio/wav"); assert.deepEqual(Buffer.from(media.base64, "base64"), f.bytes);
      assert.equal(progress.at(-1), 100);
    } finally { await f.close(); }
  }
});

test("range reads reject bad offsets, changed versions, replaced files and symlinks", async () => {
  const f = await fixture(AUDIO_CHUNK_BYTES + 2);
  try {
    const info = await f.library.audioInfo(f.id);
    for (const offset of [-1, 0.5, 1, info.total]) await assert.rejects(f.library.audioChunk(f.id, offset, info.version));
    await assert.rejects(f.library.audioChunk(f.id, 0, "a".repeat(64)), /changed/);
    await writeFile(join(f.root, f.id, "audio.wav"), f.bytes);
    await assert.rejects(f.library.audioChunk(f.id, 0, info.version), /changed/);
    await rm(join(f.root, f.id, "audio.wav"));
    await symlink(join(f.root, f.id, "track.json"), join(f.root, f.id, "audio.wav"));
    await assert.rejects(f.library.audioInfo(f.id), /Unsafe/);
  } finally { await f.close(); }
});

test("assembly rejects truncated, reordered, mixed-version and malformed chunks before playback", async () => {
  const f = await fixture(AUDIO_CHUNK_BYTES + 2);
  try {
    for (const mutate of [
      (c: AudioChunk) => ({ ...c, offset: c.offset + 1 }),
      (c: AudioChunk) => ({ ...c, total: c.total + 1 }),
      (c: AudioChunk) => ({ ...c, version: "a".repeat(64) }),
      (c: AudioChunk) => ({ ...c, base64: c.base64.slice(0, -4) }),
      (c: AudioChunk) => ({ ...c, base64: "!".repeat(c.base64.length) }),
      (c: AudioChunk) => ({ ...c, base64: c.base64.slice(0, -2) + "==" }),
    ]) await assert.rejects(assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async ({ id, offset, version }) => mutate(await f.library.audioChunk(id, offset, version)), new AbortController().signal));
  } finally { await f.close(); }
});

test("cancelled transfers stop between chunks and discard partial audio", async () => {
  const f = await fixture(AUDIO_CHUNK_BYTES + 2);
  try {
    let calls = 0; const abort = new AbortController();
    await assert.rejects(assembleAudio(f.id, ({ id }) => f.library.audioInfo(id), async ({ id, offset, version }) => {
      calls++; const chunk = await f.library.audioChunk(id, offset, version); abort.abort(); return chunk;
    }, abort.signal), /cancelled/);
    assert.equal(calls, 1);
    await assert.rejects(assembleAudio(f.id, async () => { throw new Error("must not request"); }, async () => { throw new Error("must not request"); }, abort.signal), /cancelled/);
  } finally { await f.close(); }
});
