import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Downloads } from "../server/downloads";
import { request } from "node:http";
import { Library } from "../server/library";
import { wav as validWav } from "./wav-fixture";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "music-download-test-"));
  const library = new Library(root), id = randomUUID();
  const wav = validWav(48);
  await library.save({ id, title: 'Jazz " groové\r\nX-Evil: yes', prompt: "Jazz", duration: 1, seed: 1, steps: 8, model: "medium", createdAt: new Date().toISOString() }, wav.toString("base64"));
  let clock = Date.now();
  const downloads = new Downloads(() => "127.0.0.1", 300000, () => clock);
  const fetchLink = async (url: string, options = {}) => {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
    try { return await fetch(url, { ...options, signal: abort.signal }); } finally { clearTimeout(timer); }
  };
  return { id, root, library, downloads, wav, fetchLink, expire: () => { clock += 300001; }, async close() { await downloads.close(); await rm(root, { recursive: true, force: true }); } };
}

test("download returns exact WAV attachment and safe filename without changing original", async () => {
  const f = await fixture();
  try {
    const link = await f.downloads.create(f.library, f.id);
    const response = await f.fetchLink(link.url);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.match(response.headers.get("content-disposition")!, /^attachment; filename="[a-zA-Z0-9_.-]+\.wav"; filename\*=UTF-8\x27\x27[^\r\n]+$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-evil"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.wav);
    assert.deepEqual(await readFile(join(f.root, f.id, "audio.wav")), f.wav);
    assert.equal((await f.library.list()).length, 1);
    const head = await f.fetchLink(link.url, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(f.wav.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally { await f.close(); }
});

test("unissued/expired links, listing, traversal, wrong Host and unsupported methods cannot access files", async () => {
  const f = await fixture();
  try {
    const link = await f.downloads.create(f.library, f.id), base = new URL(link.url).origin;
    for (const path of ["/", "/models", "/download/" + "a".repeat(64), "/download/../track.json"]) assert.equal((await f.fetchLink(base + path)).status, 404);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(link.url, { headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
      req.on("error", reject); req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await f.fetchLink(link.url, { method: "POST" })).status, 405);
    f.expire(); assert.equal((await f.fetchLink(link.url)).status, 404);
    await assert.rejects(f.downloads.create(f.library, "../outside"));
  } finally { await f.close(); }
});

test("deleting a track revokes download access; stopping downloads closes listener", async () => {
  const f = await fixture();
  try {
    const link = await f.downloads.create(f.library, f.id);
    await f.library.remove(f.id); assert.equal((await f.fetchLink(link.url)).status, 404);
    await f.downloads.close(); await assert.rejects(f.fetchLink(link.url));
    await assert.rejects(f.downloads.create(f.library, f.id));
  } finally { await f.close(); }
});

test("concurrent links share a ready listener and tokens are independent", async () => {
  const f = await fixture();
  try {
    const links = await Promise.all(Array.from({ length: 8 }, () => f.downloads.create(f.library, f.id)));
    assert.equal(new Set(links.map((l) => l.url)).size, 8);
    assert.equal(new Set(links.map((l) => new URL(l.url).port)).size, 1);
    assert.notEqual(new URL(links[0].url).port, "0");
    for (const link of links) assert.equal((await f.fetchLink(link.url)).status, 200);
  } finally { await f.close(); }
});

test("expired download instance cannot replace its owned listener; a new instance starts fresh", async () => {
  const f = await fixture(), downloads = new Downloads(() => "127.0.0.1", 300), replacement = new Downloads(() => "127.0.0.1");
  try {
    const first = await downloads.create(f.library, f.id);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await assert.rejects(f.fetchLink(first.url));
    await assert.rejects(downloads.create(f.library, f.id), /stopped|expired|fresh/);
    const next = await replacement.create(f.library, f.id);
    assert.notEqual(next.url, first.url);
    assert.equal((await f.fetchLink(next.url)).status, 200);
  } finally { await downloads.close(); await replacement.close(); await f.close(); }
});

test("missing Tailscale is actionable; no public or loopback fallback is started", async () => {
  const f = await fixture();
  const downloads = new Downloads(() => { throw new Error("Connect this host and your phone to Tailscale"); });
  try { await assert.rejects(downloads.create(f.library, f.id), /Tailscale/); }
  finally { await downloads.close(); await f.close(); }
});
