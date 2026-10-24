// A dependency-free adapter smoke test, NOT an AI music model.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
const { values } = parseArgs({ options: { prompt: { type: "string" }, output: { type: "string" }, duration: { type: "string", default: "2" }, seed: { type: "string", default: "1" } } });
const seconds = Number(values.duration), seed = Number(values.seed);
if (!values.prompt || !values.output || !Number.isInteger(seconds) || seconds < 1 || seconds > 380 || !Number.isInteger(seed)) throw new Error("Supply --prompt, --output, --duration (1–380) and --seed");
const rate = 16000, count = seconds * rate, bytes = Buffer.alloc(44 + count * 2);
bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
bytes.write("data", 36); bytes.writeUInt32LE(count * 2, 40);
const notes = [220, 261.63, 329.63, 392], offset = Math.abs(seed) % notes.length;
for (let n = 0; n < count; n++) {
  const position = n / rate, beat = position * 2, note = notes[(Math.floor(beat) + offset) % notes.length];
  const envelope = Math.min(1, (beat % 1) * 30) * Math.max(0, 1 - (beat % 1));
  bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * note * position) * envelope * 5000), 44 + n * 2);
}
writeFileSync(values.output, bytes, { flag: "wx" });
