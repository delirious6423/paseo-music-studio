import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Library, downloadName, prepareTake } from "../server/library";
import { Downloads } from "../server/downloads";
import { archivePlan } from "../server/zip";
import { mp3Info } from "../server/mp3";
import { wavInfo } from "../server/wav";
import { assembleAudio } from "../client/audio";
import { AUDIO_CHUNK_BYTES, minimaxOptions, type Track } from "../shared/music";
import { wav } from "./wav-fixture";

type Format = "mp3" | "wav16" | "wav24" | "wav32";
function track(format?: Format): Track {
  return { id: randomUUID(), title: "Jazz café", prompt: "A quiet trio", duration: 1, seed: 7, steps: 2,
    model: "minimax", createdAt: new Date().toISOString(), ...(format && { minimax: minimaxOptions.parse({ format }) }) };
}
// Known MPEG-1 Layer III frames: 128 kbps / 44.1 kHz, with and without padding.
// Payload is synthetic: these fixtures test structural framing, not decoder/audio quality.
function frame(header = [0xff, 0xfb, 0x90, 0], length = 417) {
  const bytes = Buffer.alloc(length); Buffer.from(header).copy(bytes); return bytes;
}
function audio(format: Format) {
  if (format === "mp3") return Buffer.concat([frame(), frame([0xff, 0xfb, 0x92, 0], 418)]);
  const bits = format === "wav32" ? 32 : format === "wav24" ? 24 : 16, align = 2 * bits / 8;
  const bytes = wav(44 + align * 4);
  bytes.writeUInt16LE(format === "wav32" ? 3 : 1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100 * align, 28); bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(bits, 34);
  return bytes;
}
function id3(version: 2 | 3 | 4 = 4, footer = false) {
  const header = Buffer.from([0x49, 0x44, 0x33, version, 0, footer ? 0x10 : 0, 0, 0, 0, 3]);
  return Buffer.concat([header, Buffer.from("tag"), ...(footer ? [Buffer.concat([Buffer.from("3DI"), header.subarray(3)])] : [])]);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "minimax-formats-"));
  const library = new Library(root), downloads = new Downloads(() => "127.0.0.1");
  return { root, library, downloads, async close() { await downloads.close(); await rm(root, { recursive: true, force: true }); } };
}
const signal = () => new AbortController().signal;
async function fetchLink(url: string, method = "GET") {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
  try { return await fetch(url, { method, signal: abort.signal }); } finally { clearTimeout(timer); }
}

for (const format of [undefined, "wav16", "wav24", "wav32", "mp3"] as const) {
  test(`${format ?? "legacy WAV"} round-trips byte-exact through storage, inline/chunk playback and single download`, async () => {
    const f = await fixture(), take = track(format), bytes = audio(format ?? "wav16");
    const extension = format === "mp3" ? "mp3" : "wav", mimeType = format === "mp3" ? "audio/mpeg" : "audio/wav";
    try {
      await f.library.save(take, bytes);
      assert.deepEqual((await readdir(join(f.root, take.id))).sort(), ["audio." + extension, "track.json"]);
      assert.deepEqual(await readFile(join(f.root, take.id, "audio." + extension)), bytes);
      const listed = await f.library.list();
      assert.equal(listed.length, 1); assert.equal(listed[0].audioBytes, bytes.length);
      assert.equal(listed[0].minimax?.format, format);
      const seconds = format === "mp3" ? mp3Info(bytes).seconds : (() => { const w = wavInfo(bytes); return w.dataBytes / (w.sampleRate * w.channels * w.bitsPerSample / 8); })();
      assert.equal(listed[0].audioSeconds, seconds);
      assert.equal(listed[0].duration, take.duration, "Requested generation setting stays distinct from audio length");
      const file = await f.library.file(take.id);
      assert.equal(file.mimeType, mimeType); assert.equal(file.filename, `Jazz-café-${take.id.slice(0, 8)}.${extension}`);
      assert.deepEqual(file.bytes, bytes);
      assert.equal((await f.library.audioInfo(take.id)).mimeType, mimeType);
      for (const inline of [false, true]) {
        const result = await assembleAudio(take.id, ({ id }) => f.library.audioInfo(id), ({ id, offset, version }) => f.library.audioChunk(id, offset, version), signal(), undefined,
          inline ? ({ id }) => f.library.audio(id) : undefined);
        assert.equal(result.mimeType, mimeType); assert.deepEqual(Buffer.from(result.base64, "base64"), bytes);
      }
      const link = await f.downloads.create(f.library, take.id);
      const response = await fetchLink(link.url);
      assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), mimeType);
      assert.ok(response.headers.get("content-disposition")!.includes(`.${extension}"`));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await fetchLink(link.url, "HEAD");
      assert.equal(head.headers.get("content-type"), mimeType); assert.equal(head.headers.get("content-length"), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      if (format !== "mp3") assert.equal(wavInfo(bytes).bitsPerSample, format === "wav32" ? 32 : format === "wav24" ? 24 : 16);
    } finally { await f.close(); }
  });
}

test("mixed MP3/WAV ZIP retains each extension, Unicode name and exact native bytes", async () => {
  const f = await fixture(), formats = ["mp3", "wav16", "wav24", "wav32"] as const;
  const takes = formats.map(track), payloads = formats.map(audio);
  try {
    for (const [i, take] of takes.entries()) await f.library.save(take, payloads[i]);
    const ids = takes.map((take) => take.id), plan = await archivePlan(f.library, ids);
    const link = await f.downloads.create(f.library, ids), response = await fetchLink(link.url);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.length, plan.length);
    let offset = 0;
    for (const [i, entry] of plan.entries.entries()) {
      const extension = formats[i] === "mp3" ? "mp3" : "wav";
      assert.equal(entry.name.toString(), `${String(i + 1).padStart(2, "0")}-Jazz-café-${ids[i].slice(0, 8)}.${extension}`);
      assert.equal(zip.readUInt32LE(offset), 0x04034b50); assert.equal(zip.readUInt16LE(offset + 8), 0);
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
      assert.equal(zip.toString("utf8", offset + 30, start), entry.name.toString());
      assert.deepEqual(zip.subarray(start, start + entry.total), payloads[i]); offset = start + entry.total;
    }
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    assert.equal(downloadName("Jazz", ids[0]).filename, `Jazz-${ids[0].slice(0, 8)}.wav`);
  } finally { await f.close(); }
});

test("MP3 validation follows MPEG-1/2/2.5 boundaries and exact ID3 tag/footer bounds", () => {
  const mp3 = audio("mp3"), tag1 = Buffer.alloc(128); tag1.write("TAG");
  for (const tag of [Buffer.alloc(0), id3(2), id3(3), id3(4), id3(4, true), Buffer.concat([id3(3), id3(4)])]) {
    assert.equal(mp3Info(Buffer.concat([tag, mp3, tag1])).frames, 2);
  }
  assert.equal(mp3Info(frame([0xff, 0xf3, 0x80, 0], 208)).frames, 1); // MPEG-2, 64 kbps / 22.05 kHz.
  assert.equal(mp3Info(frame([0xff, 0xe3, 0x80, 0], 417)).frames, 1); // MPEG-2.5, 64 kbps / 11.025 kHz.
  assert.equal(mp3Info(frame([0xff, 0xf3, 0x14, 0xc0], 24)).frames, 1); // Smallest supported frame.
  assert.equal(mp3Info(Buffer.concat([frame(), frame([0xff, 0xfb, 0xa0, 0], 522)])).frames, 2); // VBR.
  const tagInPayload = frame(); tagInPayload.write("TAG", tagInPayload.length - 128);
  assert.equal(mp3Info(tagInPayload).frames, 1); // Never mistake frame payload for a trailing tag.
  for (const invalid of [Buffer.alloc(0), Buffer.from("ID3"), id3(), tag1, mp3.subarray(0, 4), mp3.subarray(0, -1),
    Buffer.concat([mp3, Buffer.from([0])]), Buffer.concat([Buffer.from("junk"), mp3]), audio("wav16")]) {
    assert.throws(() => mp3Info(invalid), /Invalid MP3/);
  }
  for (const [index, value] of [[1, 0xeb], [1, 0xfd], [2, 0], [2, 0xf0], [2, 0x9c], [3, 2]]) {
    const invalid = Buffer.from(mp3); invalid[index] = value;
    assert.throws(() => mp3Info(invalid), /Invalid MP3/);
  }
  for (const [index, value] of [[0, 0xc9], [3, 5], [4, 255], [5, 1], [6, 128], [6, 127], [13, 0], [16, 3], [22, 4]]) {
    const invalid = Buffer.concat([id3(4, true), mp3]); invalid[index] = value;
    assert.throws(() => mp3Info(invalid), /Invalid MP3/);
  }
});

test("format selection honors recorded MIME and preserves legacy MiniMax tracks without a format", async () => {
  const f = await fixture();
  try {
    const take = track("wav16");
    await f.library.save(take, audio("wav16"));
    const legacy = JSON.parse(await readFile(join(f.root, take.id, "track.json"), "utf8"));
    delete legacy.minimax.format;
    await writeFile(join(f.root, take.id, "track.json"), JSON.stringify(legacy));
    assert.equal((await f.library.list())[0].minimax?.format, undefined);
    assert.equal((await f.library.audioInfo(take.id)).mimeType, "audio/wav");
    const tiny = track("mp3"), bytes = frame([0xff, 0xf3, 0x14, 0xc0], 24);
    await f.library.save(tiny, bytes);
    const assembled = await assembleAudio(tiny.id, ({ id }) => f.library.audioInfo(id), ({ id, offset, version }) => f.library.audioChunk(id, offset, version), signal());
    assert.equal(assembled.mimeType, "audio/mpeg"); assert.deepEqual(Buffer.from(assembled.base64, "base64"), bytes);
    assert.equal(prepareTake({ ...track(), mimeType: "audio/mpeg" }, audio("mp3")).bytes.length, 835);
    assert.equal(prepareTake({ ...track("mp3"), mimeType: "audio/wav" }, audio("wav24")).bytes.length, 68);
    assert.throws(() => prepareTake(track("mp3"), audio("wav16")), /Invalid MP3/);
    assert.throws(() => prepareTake(track("wav16"), audio("mp3")), /Invalid WAV/);
  } finally { await f.close(); }
});

test("MP3 assembly rejects changed MIME across chunks/inline metadata and preserves cancellation", async () => {
  const f = await fixture(), take = track("mp3");
  const bytes = Buffer.concat(Array.from({ length: Math.ceil((AUDIO_CHUNK_BYTES + 1) / 417) }, () => frame()));
  try {
    await f.library.save(take, bytes);
    const info = () => f.library.audioInfo(take.id);
    const chunk = ({ offset, version }: { offset: number; version: string }) => f.library.audioChunk(take.id, offset, version);
    const result = await assembleAudio(take.id, info, chunk, signal());
    assert.equal(result.mimeType, "audio/mpeg"); assert.deepEqual(Buffer.from(result.base64, "base64"), bytes);
    for (const changeAt of [0, AUDIO_CHUNK_BYTES]) await assert.rejects(assembleAudio(take.id, info, async (input) => {
      const part = await chunk(input); return { ...part, mimeType: input.offset === changeAt ? "audio/wav" : part.mimeType };
    }, signal()), /Invalid audio chunk/);
    await assert.rejects(assembleAudio(take.id, info, chunk, signal(), undefined, async () => ({ base64: bytes.toString("base64"), mimeType: "audio/wav" })), /changed or audio is incomplete/);
    let infoCalls = 0;
    await assert.rejects(assembleAudio(take.id, async () => ({ ...await info(), mimeType: ++infoCalls === 1 ? "audio/mpeg" : "audio/wav" }), chunk, signal(), undefined, () => f.library.audio(take.id)), /changed or audio is incomplete/);
    let chunkCalls = 0;
    const abort = new AbortController();
    await assert.rejects(assembleAudio(take.id, info, async (input) => { chunkCalls++; const part = await chunk(input); abort.abort(); return part; }, abort.signal), /cancelled/);
    assert.equal(chunkCalls, 1);
    const legacy = track(), wavBytes = audio("wav16"); await f.library.save(legacy, wavBytes);
    const legacyInfo = await f.library.audioInfo(legacy.id);
    const old = await assembleAudio(legacy.id, async () => ({ total: legacyInfo.total, version: legacyInfo.version }), async () => {
      const part = await f.library.audioChunk(legacy.id, 0, legacyInfo.version);
      return { total: part.total, version: part.version, offset: part.offset, base64: part.base64 };
    }, signal());
    assert.equal(old.mimeType, "audio/wav"); assert.deepEqual(Buffer.from(old.base64, "base64"), wavBytes);
    const oldInline = await assembleAudio(legacy.id, async () => ({ total: legacyInfo.total, version: legacyInfo.version }), chunk, signal(), undefined, async () => ({ base64: wavBytes.toString("base64") }));
    assert.equal(oldInline.mimeType, "audio/wav");
  } finally { await f.close(); }
});

test("native replay codes stay out of metadata/list RPC but round-trip in the atomic replay sidecar", async () => {
  const f = await fixture(), take = track("mp3"), codes = "12,34,".repeat(20000), inputCodes = "56,78,".repeat(20000);
  take.minimax = { ...take.minimax!, audioCodes: inputCodes, lmBatch: 2, synthBatch: 3 };
  const replay = JSON.stringify({ audio_codes: codes, native_note: "x".repeat(2 * 1024 * 1024) });
  try {
    const prepared = prepareTake(take, audio("mp3"), replay);
    assert.ok(Buffer.byteLength(prepared.metadata) < 65536); assert.equal(prepared.track.minimax?.audioCodes, undefined);
    assert.equal(take.minimax?.audioCodes, inputCodes); // Validation must not mutate the caller.
    await f.library.save(take, audio("mp3"), replay);
    assert.equal(await readFile(join(f.root, take.id, "replay.json"), "utf8"), replay);
    const metadata = await readFile(join(f.root, take.id, "track.json"), "utf8");
    assert.ok(!metadata.includes("audioCodes")); assert.equal(JSON.parse(metadata).replayAvailable, true);
    const listed = await f.library.list(); assert.equal(listed[0].replayAvailable, true);
    assert.ok(!JSON.stringify(listed).includes("audioCodes"));
    const restored = await f.library.replay(take.id);
    assert.deepEqual(restored.minimax, { ...take.minimax, audioCodes: codes, lmBatch: 1, synthBatch: 1 });
    assert.equal(restored.prompt, take.prompt); assert.equal(restored.seed, take.seed);
    await rm(join(f.root, take.id, "replay.json"));
    await symlink(join(f.root, take.id, "track.json"), join(f.root, take.id, "replay.json"));
    await assert.rejects(f.library.replay(take.id), /Unsafe/);
  } finally { await f.close(); }
});

test("bad replay is rejected before pending/save publication and cannot advertise missing replay", async () => {
  const f = await fixture(), take = track("wav16"), bytes = audio("wav16");
  try {
    for (const replay of ["{", "null", "[]", "{}", JSON.stringify({ audio_codes: [] }), JSON.stringify({ audio_codes: "  " }),
      JSON.stringify({ audio_codes: "1".repeat(1024 * 1024 + 1) }), JSON.stringify({ audio_codes: "1", padding: "x".repeat(4 * 1024 * 1024) })]) {
      assert.throws(() => prepareTake(take, bytes, replay));
      await assert.rejects(f.library.save(take, bytes, replay));
      assert.deepEqual(await readdir(f.root), []);
    }
    await f.library.save({ ...take, replayAvailable: true }, bytes);
    assert.equal((await f.library.list())[0].replayAvailable, undefined);
    await assert.rejects(f.library.replay(take.id), /ENOENT/);
  } finally { await f.close(); }
});
