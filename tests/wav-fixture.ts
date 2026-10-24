import { randomFillSync } from "node:crypto";

// A structurally valid PCM WAV of exactly `total` bytes (canonical 44-byte header, mono 44.1 kHz).
// Even sample data is 16-bit and odd is 8-bit, so any total of at least 45 bytes is possible.
export function wav(total = 48, random = false) {
  if (!Number.isInteger(total) || total < 45) throw new Error("A WAV fixture needs at least one sample");
  const bytes = Buffer.alloc(total), data = total - 44, bits = data % 2 ? 8 : 16, align = bits / 8;
  if (random) randomFillSync(bytes, 44);
  bytes.write("RIFF"); bytes.writeUInt32LE(total - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(44100 * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(bits, 34); bytes.write("data", 36); bytes.writeUInt32LE(data, 40);
  return bytes;
}
