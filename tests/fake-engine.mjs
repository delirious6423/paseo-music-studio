#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
writeFileSync(value("--models-dir") + "/engine.pid", String(process.pid));
let loaded = false, current = null, scenario = "";
// Payload ownership, like sa3-server: a completed job keeps its audio until a ?consume=1 poll takes it.
const jobs = { retained: 0, consumed: 0 };
const record = () => writeFileSync(value("--models-dir") + "/jobs.json", JSON.stringify(jobs));
try { scenario = readFileSync(value("--models-dir") + "/scenario", "utf8"); } catch {}
if (scenario === "exit") process.exit(7);
if (scenario === "ignore-term") process.on("SIGTERM", () => {});
const wav = Buffer.alloc(44 + (scenario === "long-audio" ? 380 * 44100 * 4 : 8820));
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
const channels = scenario === "long-audio" ? 2 : 1;
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200 * channels, 28);
wav.writeUInt16LE(2 * channels, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const send = (obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url === "/health") return send({ loaded, model: scenario === "wrong-model" ? "small-sfx" : value("--model"), encoding: "f16" });
  if (req.url === "/load") {
    if (scenario === "load-hang") return;
    loaded = true; return send({ loaded: true });
  }
  if (req.url === "/generate") {
    current = JSON.parse(body); current.at = Date.now();
    if (current.duration > Number(process.env.SA3_MAX_DURATION)) return send({ error: "duration exceeds configured server cap" }, 400);
    writeFileSync(value("--models-dir") + "/request.json", JSON.stringify({ ...current, maxDuration: process.env.SA3_MAX_DURATION }));
    return send({ session_id: "test-job", seed: current.seed < 0 ? 123 : current.seed });
  }
  if (req.url.startsWith("/poll_status/")) {
    if (!current || current.consumed) return send({ success: false, error: "unknown session" }, 404);
    if (current.prompt === "fail" || (scenario === "seed-fail" && current.seed === 8)) return send({ status: "failed", error: "synthetic generation failure" });
    if (current.prompt === "hang" || Date.now() - current.at < 150) return send({ status: "generating", progress: 42 });
    if (scenario === "exit-after-audio") setTimeout(() => process.exit(7), 20);
    const consume = new URL(req.url, "http://engine").searchParams.get("consume") === "1";
    if (!current.completed) { current.completed = true; jobs.retained++; }
    if (consume) { current.consumed = true; jobs.retained--; jobs.consumed++; }
    record();
    const audio = scenario === "invalid-audio" ? Buffer.from("not a WAV") : scenario === "header-only" ? Buffer.concat([wav.subarray(0, 12), Buffer.alloc(36)]) : wav;
    return send({ status: "completed", progress: 100, audio_data: audio.toString("base64"), meta: { seed: current.seed < 0 ? 123 : current.seed } });
  }
  send({ error: "unknown" }, 404);
});
if (scenario === "slow-start") setTimeout(() => server.listen(Number(value("--port")), "127.0.0.1"), 1000);
else server.listen(Number(value("--port")), "127.0.0.1");
