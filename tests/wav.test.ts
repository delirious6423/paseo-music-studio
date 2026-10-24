import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { wavInfo } from "../server/wav";
import { downloadName, prepareTake } from "../server/library";
import { wav } from "./wav-fixture";

const PCM_GUID_TAIL = Buffer.from("000000001000800000aa00389b71", "hex");
function chunk(id: string, body: Buffer) { return Buffer.concat([Buffer.from(id, "latin1"), u32(body.length), body, Buffer.alloc(body.length & 1)]); }
function u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function fmt(tag: number, channels: number, rate: number, bits: number, align = channels * bits / 8, byteRate = rate * align) {
  return chunk("fmt ", Buffer.concat([u16(tag), u16(channels), u32(rate), u32(byteRate), u16(align), u16(bits)]));
}
function extensible(sub: number, channels: number, rate: number, bits: number, valid: number, tail = PCM_GUID_TAIL) {
  const align = channels * bits / 8;
  return chunk("fmt ", Buffer.concat([u16(0xfffe), u16(channels), u32(rate), u32(rate * align), u16(align), u16(bits), u16(22), u16(valid), u32(3), u16(sub), tail]));
}
function riff(...chunks: Buffer[]) { const body = Buffer.concat([Buffer.from("WAVE"), ...chunks]); return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]); }
const data = (n: number) => chunk("data", Buffer.alloc(n, 1));

test("structural WAV validator accepts valid PCM, float and extensible files with noncanonical layouts", () => {
  // An odd final chunk without its pad byte, as many writers produce.
  const unpadded = riff(fmt(1, 1, 8000, 8), data(3)).subarray(0, -1); unpadded.writeUInt32LE(unpadded.length - 8, 4);
  const cases: [Buffer, Partial<ReturnType<typeof wavInfo>>][] = [
    [wav(48), { format: "pcm", channels: 1, bitsPerSample: 16, dataBytes: 4 }],
    [wav(45), { bitsPerSample: 8, dataBytes: 1 }],
    // Metadata before fmt, an odd-sized chunk with its pad byte, and a fact chunk between fmt and data.
    [riff(chunk("LIST", Buffer.from("INFOISFT\x05\0\0\0test\0")), chunk("junk", Buffer.alloc(3)), fmt(1, 2, 48000, 24), chunk("fact", u32(2)), data(12)), { channels: 2, sampleRate: 48000, bitsPerSample: 24, dataBytes: 12 }],
    [riff(fmt(3, 2, 44100, 32), data(16)), { format: "float", bitsPerSample: 32 }],
    [riff(fmt(3, 1, 96000, 64), data(16)), { format: "float", bitsPerSample: 64 }],
    [riff(extensible(1, 2, 44100, 32, 24), data(16)), { format: "pcm", bitsPerSample: 32 }],
    [riff(extensible(3, 6, 48000, 32, 32), data(48)), { format: "float", channels: 6 }],
    [unpadded, { dataBytes: 3 }],
  ];
  for (const [bytes, expected] of cases) {
    assert.deepEqual({ ...wavInfo(bytes), ...expected }, wavInfo(bytes));
  }
});

test("structural WAV validator rejects header-only, truncated, malformed and unsupported files", () => {
  const headerOnly = wav(48); headerOnly.fill(0, 12); // The old RIFF/WAVE-string check accepted this.
  const truncated = wav(1000).subarray(0, 900);
  const lying = wav(48); lying.writeUInt32LE(9, 40);
  const many = riff(fmt(1, 1, 8000, 8), ...Array.from({ length: 4100 }, () => chunk("note", Buffer.alloc(0))), data(1));
  const rejected: [string, Buffer, RegExp][] = [
    ["too short", Buffer.from("RIFF\x24\0\0\0WAVEfmt "), /too short/],
    ["not RIFF", Buffer.concat([Buffer.from("RIFX"), wav(48).subarray(4)]), /RIFF\/WAVE/],
    ["header only", headerOnly, /missing fmt|exceeds/],
    ["truncated file", truncated, /truncated/],
    ["data larger than RIFF", lying, /truncated/],
    ["data before fmt", riff(data(2), fmt(1, 1, 8000, 16)), /precedes fmt/],
    ["missing data", riff(fmt(1, 1, 8000, 16), chunk("LIST", Buffer.alloc(30))), /missing data/],
    ["empty data", riff(fmt(1, 1, 8000, 16), data(0)), /empty/],
    ["partial frame", riff(fmt(1, 2, 8000, 16), data(6)), /mid-frame/],
    ["duplicate fmt", riff(fmt(1, 1, 8000, 16), fmt(1, 1, 8000, 16), data(2)), /duplicate fmt/],
    ["duplicate data", riff(fmt(1, 1, 8000, 16), data(2), data(2)), /duplicate data/],
    ["ADPCM", riff(fmt(2, 1, 8000, 4, 1, 4000), data(2)), /only PCM/],
    ["12-bit PCM", riff(fmt(1, 1, 8000, 12, 2, 16000), data(2)), /bits per sample/],
    ["16-bit float", riff(fmt(3, 1, 8000, 16), data(2)), /bits per sample/],
    ["zero channels", riff(fmt(1, 0, 8000, 16, 2, 16000), data(2)), /channel/],
    ["absurd rate", riff(fmt(1, 1, 5, 16), data(2)), /sample rate/],
    ["block align", riff(fmt(1, 2, 8000, 16, 2), data(4)), /block alignment/],
    ["byte rate", riff(fmt(1, 1, 8000, 16, 2, 1), data(2)), /byte rate/],
    ["unknown extensible subformat", riff(extensible(1, 1, 8000, 16, 16, Buffer.alloc(14)), data(2)), /subformat/],
    ["valid bits above container", riff(extensible(1, 1, 8000, 16, 24), data(2)), /valid-bits/],
    ["chunk flood", many, /too many chunks/],
  ];
  for (const [name, bytes, error] of rejected) assert.throws(() => wavInfo(bytes), error, name);
});

test("unsaveable completed audio and metadata are rejected before any retained recovery state", () => {
  const track = { id: randomUUID(), title: "Take", prompt: "Jazz", duration: 1, steps: 8, seed: 1, model: "medium", createdAt: new Date().toISOString() };
  assert.equal(prepareTake(track, wav(48).toString("base64")).bytes.length, 48);
  assert.equal(prepareTake(track, wav(46)).bytes.length, 46);
  for (const audio of [Buffer.from("not a WAV").toString("base64"), "", wav(48).fill(0, 12)]) assert.throws(() => prepareTake(track, audio), /Invalid WAV/);
  assert.throws(() => prepareTake({ ...track, id: "../escape" }, wav(48)));
  assert.throws(() => prepareTake(track, "A".repeat(Math.ceil(128 * 1024 * 1024 / 3) * 4 + 4)), /128 MiB/);
});

test("download names keep Unicode letters and numbers, stay unique and never carry separators or controls", () => {
  const id = "0123abcd-0000-4000-8000-000000000000";
  assert.deepEqual(downloadName("爵士樂 · 3/20", id), { filename: "爵士樂-3-20-0123abcd.wav", asciiFilename: "3-20-0123abcd.wav" });
  assert.equal(downloadName("Jazz groove · 1/4", id).filename, "Jazz-groove-1-4-0123abcd.wav"); // ASCII titles keep their previous name.
  assert.equal(downloadName("Cafe\u0301 mañana", id).filename, "Café-mañana-0123abcd.wav");
  assert.equal(downloadName("हिन्दी जैज़", id).filename, "हिन्दी-जैज़-0123abcd.wav".normalize("NFC"));
  for (const title of ['../../etc/passwd', 'a\r\nX-Evil: yes', 'evil\u202Egnp.exe', 'C:\\Windows\\x', 'con.', '  ', '🎷🎺', '.']) {
    const { filename, asciiFilename } = downloadName(title, id);
    for (const name of [filename, asciiFilename]) {
      assert.match(name, /^[\p{L}\p{M}\p{N}_-]+-0123abcd\.wav$/u, title);
      assert.doesNotMatch(name, /[\/\\:\r\n\u202E]|\.\./, title);
    }
    assert.match(asciiFilename, /^[A-Za-z0-9_-]+\.wav$/);
  }
  assert.equal(downloadName("🎷🎺", id).filename, "music-0123abcd.wav");
  const long = downloadName("長".repeat(100) + "x", id).filename;
  assert.equal([...long].length, 70 + "-0123abcd.wav".length);
  assert.ok(!long.includes("\uFFFD"));
});
