import { writeFileSync, symlinkSync, truncateSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
const options = Object.fromEntries(process.argv.slice(2).map((arg) => { const i = arg.indexOf("="); return [arg.slice(2, i), arg.slice(i + 1)]; }));
if (options.scenario === "seed-fail" && options.seed === "8") process.exit(2);
if (options.scenario === "seed-hang" && options.seed === "8") options.scenario = "hang";
// Valid 48-byte PCM WAV: canonical header plus two 16-bit mono samples.
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
function state(value) { writeFileSync(options.state + ".tmp", JSON.stringify(value)); renameSync(options.state + ".tmp", options.state); }
if (options.scenario === "fail") process.exit(2);
if (options.scenario === "graceful-abort") {
  state({ parent: process.pid });
  process.on("SIGTERM", () => { writeFileSync(options.output, wav()); process.exit(0); });
  setInterval(() => {}, 1000);
} else
if (options.scenario === "hang" || options.scenario === "stopped-guard") {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
  state({ parent: process.pid, child: child.pid });
  if (options.scenario === "stopped-guard") process.kill(process.ppid, "SIGSTOP");
  process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
} else {
  if (options.scenario === "symlink") symlinkSync(options.state, options.output);
  else {
    // "header-only" passes the old RIFF/WAVE string check but has no fmt/data chunks.
    const bytes = options.scenario === "header-only" ? Buffer.concat([Buffer.from("RIFF\x28\0\0\0WAVE", "latin1"), Buffer.alloc(36)]) : wav();
    writeFileSync(options.output, options.scenario === "invalid" ? "not audio" : bytes);
    if (options.scenario === "oversized") truncateSync(options.output, 128 * 1024 * 1024 + 1);
  }
  if (options.scenario === "background") {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
    child.unref(); state({ parent: process.pid, child: child.pid });
  }
  if (options.scenario === "ok") state(options);
}
