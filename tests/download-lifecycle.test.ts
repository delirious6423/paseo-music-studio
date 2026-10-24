import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Downloads } from "../server/downloads";
import { DownloadConnections } from "../server/download-routes";
import { Library } from "../server/library";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "music-download-lifetime-")), library = new Library(root), id = randomUUID();
  const wave = Buffer.alloc(48);
  wave.write("RIFF"); wave.writeUInt32LE(40, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(4, 40);
  await library.save({ id, title: "爵士樂 café", prompt: "Jazz", duration: 1, steps: 8, seed: 1, model: "medium", createdAt: new Date().toISOString() }, wave.toString("base64"));
  return { library, id, wave, close: () => rm(root, { recursive: true, force: true }) };
}

test("link creation and WAV/ZIP HEAD never read payloads; Unicode attachment names round-trip", async () => {
  const f = await fixture(), downloads = new Downloads(() => "127.0.0.1");
  const open = f.library.audioFile.bind(f.library);
  let denyReads = true, payloadReads = 0;
  f.library.file = async () => { throw new Error("Buffered WAV path must not be used"); };
  f.library.audioFile = async (id) => {
    const opened = await open(id);
    if (denyReads) opened.file.read = async () => { payloadReads++; throw new Error("HEAD/auth must not read WAV bytes"); };
    return opened;
  };
  try {
    const wav = await downloads.create(f.library, f.id), zip = await downloads.create(f.library, [f.id]);
    const head = await fetch(wav.url, { method: "HEAD" }), zipHead = await fetch(zip.url, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(zipHead.status, 200); assert.equal(payloadReads, 0);
    assert.equal(head.headers.get("content-length"), String(f.wave.length));
    const disposition = head.headers.get("content-disposition")!;
    assert.match(disposition, /^attachment; filename="[a-zA-Z0-9_.-]+"; filename\*=UTF-8''/);
    assert.ok(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]).startsWith("爵士樂-café-"));
    denyReads = false;
    const body = await fetch(wav.url), zipBody = await fetch(zip.url);
    assert.deepEqual(Buffer.from(await body.arrayBuffer()), f.wave);
    assert.equal((await zipBody.arrayBuffer()).byteLength, Number(zipHead.headers.get("content-length")));
  } finally { await downloads.close(); await f.close(); }
});

test("ZIP preparation outlasts network idle timeout while the overall deadline remains bounded", async () => {
  const f = await fixture();
  const downloads = new Downloads(() => "127.0.0.1", 300000, Date.now, () => true, { idleMs: 75, baseMs: 3000, per25MiBMs: 100 });
  try {
    const link = await downloads.create(f.library, [f.id]), open = f.library.audioFile.bind(f.library);
    let delayed = false;
    f.library.audioFile = async (id) => { if (!delayed) { delayed = true; await new Promise((r) => setTimeout(r, 225)); } return open(id); };
    const response = await fetch(link.url);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, Number(response.headers.get("content-length")));
  } finally { await downloads.close(); await f.close(); }
});

test("expiry during gated link validation cannot overwrite a draining server; shutdown and route revocation own it", async () => {
  for (const revokeRoute of [false, true]) {
    const f = await fixture(), target = { kind: "lan" as const, address: "127.0.0.1", interface: "test", cidr: null };
    let available = true;
    const manager = new DownloadConnections(() => available ? [target] : [], 1000, 100);
    let releaseTransfer!: () => void, releaseValidation!: () => void;
    const transferGate = new Promise<void>((resolve) => { releaseTransfer = resolve; });
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    try {
      const info = await f.library.audioInfo(f.id), link = await manager.create(f.library, [f.id], target);
      let entered!: () => void;
      const accepted = new Promise<void>((resolve) => { entered = resolve; });
      f.library.audioFile = async () => { entered(); await transferGate; throw new Error("Test preparation released after revocation"); };
      const pendingResponse = fetch(link.url).then(() => false, () => true);
      await accepted;
      let validating!: () => void;
      const validationStarted = new Promise<void>((resolve) => { validating = resolve; });
      f.library.audioInfo = async () => { validating(); await validationGate; return info; };
      const fresh = manager.create(f.library, [f.id], target);
      const rejected = assert.rejects(fresh, /stopped|expired|fresh/);
      await validationStarted;
      await new Promise((resolve) => setTimeout(resolve, 350));
      releaseValidation(); await rejected;
      if (revokeRoute) {
        available = false;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      } else await manager.close();
      assert.equal(await pendingResponse, true, "Accepted old response survived forced cleanup");
      await assert.rejects(fetch(link.url));
    } finally { releaseTransfer(); releaseValidation(); await manager.close(); await f.close(); }
  }
});

test("ZIP CRC plans are reused only for unchanged audio versions", async () => {
  const f = await fixture(), downloads = new Downloads(() => "127.0.0.1");
  const open = f.library.audioFile.bind(f.library);
  let opens = 0;
  f.library.audioFile = async (id) => {
    opens++;
    const opened = await open(id);
    // A cached GET's first open is metadata only; rejecting a payload read exposes any repeated checksum pass.
    if (opens === 1) opened.file.read = async () => { throw new Error("Repeated ZIP checksum pass"); };
    return opened;
  };
  try {
    // First GET populates the per-link plan; restore ordinary reads while doing so.
    opens = -10;
    const link = await downloads.create(f.library, [f.id]), first = await fetch(link.url);
    assert.equal(first.status, 200); const original = Buffer.from(await first.arrayBuffer());
    opens = 0;
    const second = await fetch(link.url);
    assert.equal(second.status, 200); assert.deepEqual(Buffer.from(await second.arrayBuffer()), original);
    assert.equal(opens, 2, "Cached GET should open metadata and then stream, with no preparation payload read");
  } finally { await downloads.close(); await f.close(); }
});
