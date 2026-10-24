import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink, readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Downloads } from "../server/downloads";
import { Library } from "../server/library";
import { archivePlan, streamArchive } from "../server/zip";
import { createServer } from "node:http";
import { DownloadConnections } from "../server/download-routes";
import { batchDownloadIds, downloadBatchInput } from "../shared/music";
import { wav } from "./wav-fixture";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "music-zip-")), library = new Library(root), ids: string[] = [], waves: Buffer[] = [];
  const downloads = new Downloads(() => "127.0.0.1");
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(), wave = wav(45 + i * 131071, true);
    await library.save({ id, title: '../same " café\r\nX-Header:evil', prompt: "Jazz", duration: 1, seed: i, steps: 8, model: "medium", createdAt: new Date().toISOString() }, wave.toString("base64"));
    ids.push(id); waves.push(wave);
  }
  return { root, library, ids, waves, downloads, async close() { await downloads.close(); await rm(root, { recursive: true, force: true }); } };
}

test("ZIP selection requires 1–20 unique UUID tracks, explicit route and consent", () => {
  const id = randomUUID(), target = { kind: "lan", address: "192.168.50.10", interface: "wlan0", cidr: null };
  for (const ids of [[], [id, id], ["../escape"], Array.from({ length: 21 }, () => randomUUID())]) assert.equal(batchDownloadIds.safeParse(ids).success, false);
  for (const input of [{ ids: [id] }, { ids: [id], target }, { ids: [id], target, acknowledged: false }]) assert.equal(downloadBatchInput.safeParse(input).success, false);
  assert.equal(downloadBatchInput.safeParse({ ids: [id], target, acknowledged: true }).success, true);
});

test("ZIP download extracts byte-exact unique safe WAVs using independent Python and unzip", async () => {
  const f = await fixture();
  try {
    const link = await f.downloads.create(f.library, f.ids);
    assert.ok(Date.parse(link.expiresAt) - Date.now() > 14 * 60000);
    const head = await fetch(link.url, { method: "HEAD" }); assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "application/zip"); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const response = await fetch(link.url);
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="paseo-music.zip"');
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-header"), null);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get("content-length")), zip.length); assert.equal(head.headers.get("content-length"), String(zip.length));
    const path = join(f.root, "tracks.zip"); await writeFile(path, zip);
    const result = execFileSync("python3", ["-c", "import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps([dict(name=x.filename,sha256=hashlib.sha256(z.read(x)).hexdigest()) for x in z.infolist()]))", path], { encoding: "utf8", timeout: 10000 });
    const entries: { name: string; sha256: string }[] = JSON.parse(result);
    assert.equal(zip.readUInt16LE(6) & 8, 0, "STORED entry must have CRC/sizes in its local header, not a data descriptor");
    assert.equal(zip.readUInt32LE(18), f.waves[0].length); assert.equal(zip.readUInt32LE(22), f.waves[0].length);
    assert.equal(entries.length, 3); assert.equal(new Set(entries.map((e) => e.name)).size, 3);
    const { createHash } = await import("node:crypto");
    for (const [i, entry] of entries.entries()) {
      assert.match(entry.name, new RegExp("^0" + (i + 1) + "-[\\p{L}\\p{M}\\p{N}_-]+\\.wav$", "u"));
      assert.equal(entry.sha256, createHash("sha256").update(f.waves[i]).digest("hex"));
      assert.deepEqual(await readFile(join(f.root, f.ids[i], "audio.wav")), f.waves[i]);
    }
    assert.match(execFileSync("unzip", ["-t", path], { encoding: "utf8", timeout: 10000 }), /No errors detected/);
  } finally { await f.close(); }
});

test("invalid, missing or symlink ZIP entries never produce an accessible archive", async () => {
  const f = await fixture();
  try {
    for (const ids of [[], [...f.ids, randomUUID()], [f.ids[0], f.ids[0]], ["../escape"]]) await assert.rejects(f.downloads.create(f.library, ids));
    const link = await f.downloads.create(f.library, f.ids);
    await f.library.remove(f.ids[1]); assert.equal((await fetch(link.url)).status, 404);
    await rm(join(f.root, f.ids[0], "audio.wav"));
    await symlink(join(f.root, f.ids[0], "track.json"), join(f.root, f.ids[0], "audio.wav"));
    await assert.rejects(archivePlan(f.library, [f.ids[0]]), /Unsafe/);
  } finally { await f.close(); }
});

test("full-size ZIP streams intact and cancelled downloads leave no owned WAV handles", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), wave = wav(44 + 380 * 44100 * 4, true);
    wave.write("RIFF"); wave.write("WAVE", 8);
    await f.library.save({ id, title: "Long", prompt: "Jazz", duration: 380, seed: 1, steps: 8, model: "medium", createdAt: new Date().toISOString() }, wave.toString("base64"));
    const link = await f.downloads.create(f.library, [id, f.ids[0]]);
    const response = await fetch(link.url), path = join(f.root, "large.zip");
    const zip = Buffer.from(await response.arrayBuffer()); assert.equal(zip.length, Number(response.headers.get("content-length")));
    await writeFile(path, zip);
    execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert len(z.infolist())==2; assert len(z.read(z.infolist()[0]))==67032044", path], { timeout: 15000 });
    const abort = new AbortController(), partial = await fetch(link.url, { signal: abort.signal });
    await partial.body!.getReader().read(); abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const fd of await readdir("/proc/self/fd")) {
      const target = await readlink("/proc/self/fd/" + fd).catch(() => "");
      assert.ok(!target.startsWith(f.root) || !target.endsWith("audio.wav"), "WAV handle leaked after cancellation");
    }
  } finally { await f.close(); }
});

test("new single links do not expire an existing ZIP link early", async () => {
  const f = await fixture();
  const downloads = new Downloads(() => "127.0.0.1", 200);
  try {
    const zip = await downloads.create(f.library, f.ids);
    await downloads.create(f.library, f.ids[0]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await fetch(zip.url)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(fetch(zip.url));
  } finally { await downloads.close(); await f.close(); }
});

test("link expiry drains an accepted ZIP, but route changes still terminate it", async () => {
  for (const changeRoute of [false, true]) {
    const f = await fixture();
    const target = { kind: "lan" as const, address: "127.0.0.1", interface: "test", cidr: "127.0.0.1/8" };
    let available = true;
    const manager = new DownloadConnections(() => available ? [target] : [], 5, 100);
    try {
      const id = randomUUID(), wave = wav(8 * 1024 * 1024, true);
      await f.library.save({ id, title: "Slow ZIP", prompt: "test", duration: 1, steps: 8, seed: 1, model: "medium", createdAt: new Date().toISOString() }, wave.toString("base64"));
      const link = await manager.create(f.library, [id], target), response = await fetch(link.url);
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (changeRoute) {
        available = false; await new Promise((resolve) => setTimeout(resolve, 30));
        await assert.rejects(response.arrayBuffer());
      } else {
        const zip = Buffer.from(await response.arrayBuffer());
        assert.equal(zip.length, Number(response.headers.get("content-length")));
        await assert.rejects(fetch(link.url));
      }
    } finally { await manager.close(); await f.close(); }
  }
});

test("ZIP preparation cancellation closes files before continuing the checksum pass", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 0);
    await assert.rejects(archivePlan(f.library, f.ids, abort.signal), /cancelled/);
    for (const fd of await readdir("/proc/self/fd")) {
      const target = await readlink("/proc/self/fd/" + fd).catch(() => "");
      assert.ok(!target.startsWith(f.root) || !target.endsWith("audio.wav"), "Preparation leaked a WAV handle");
    }
  } finally { await f.close(); }
});

test("ZIP download refuses stale plans instead of silently mixing changed files", async () => {
  const f = await fixture(), plan = await archivePlan(f.library, f.ids);
  await writeFile(join(f.root, f.ids[0], "audio.wav"), f.waves[0]);
  let failed = false;
  const server = createServer((_, response) => { void streamArchive(response, f.library, plan).catch(() => { failed = true; response.destroy(); }); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    await assert.rejects(fetch("http://127.0.0.1:" + address.port)); assert.equal(failed, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
});
