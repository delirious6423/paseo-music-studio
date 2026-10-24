import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Library } from "../server/library";
import { removeBatchInput } from "../shared/music";
import { wav as validWav } from "./wav-fixture";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "music-trash-batch-")), library = new Library(root), ids: string[] = [];
  const wav = validWav();
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(); ids.push(id);
    await library.save({ id, title: "Take " + i, prompt: "Jazz", duration: 1, seed: i, steps: 8, model: "medium", createdAt: new Date().toISOString() }, wav.toString("base64"));
  }
  return { root, library, ids, wav, close: () => rm(root, { recursive: true, force: true }) };
}

test("batch delete moves only chosen tracks to recoverable trash without changing bytes", async () => {
  const f = await fixture();
  try {
    const selected = f.ids.slice(0, 2), metadata = await Promise.all(selected.map((id) => readFile(join(f.root, id, "track.json"))));
    const result = await f.library.removeBatch(selected);
    assert.deepEqual(result, { deleted: selected, failed: [] });
    assert.deepEqual((await f.library.list()).map((t) => t.id), [f.ids[2]]);
    const trash = await readdir(join(f.root, ".trash")); assert.equal(trash.length, 2);
    for (const [i, id] of selected.entries()) {
      const path = join(f.root, ".trash", trash.find((name) => name.startsWith(id + "-"))!);
      assert.deepEqual(await readFile(join(path, "audio.wav")), f.wav);
      assert.deepEqual(await readFile(join(path, "track.json")), metadata[i]);
    }
    assert.deepEqual(await readFile(join(f.root, f.ids[2], "audio.wav")), f.wav);
  } finally { await f.close(); }
});

test("batch delete validates the complete selection before moving any track", async () => {
  const f = await fixture();
  try {
    for (const ids of [[], [f.ids[0], "../escape"], [f.ids[0], f.ids[0]], Array.from({ length: 21 }, () => randomUUID())]) {
      assert.equal(removeBatchInput.safeParse({ ids }).success, false);
      await assert.rejects(f.library.removeBatch(ids));
      assert.equal((await f.library.list()).length, 3);
    }
  } finally { await f.close(); }
});

test("partial failures identify exactly what moved; missing/corrupt tracks do not erase others", async () => {
  const f = await fixture();
  try {
    const missing = randomUUID();
    await writeFile(join(f.root, f.ids[1], "track.json"), JSON.stringify({ id: randomUUID() }));
    const result = await f.library.removeBatch([f.ids[0], missing, f.ids[1], f.ids[2]]);
    assert.deepEqual(result.deleted, [f.ids[0], f.ids[2]]);
    assert.deepEqual(result.failed.map((e) => e.id), [missing, f.ids[1]]);
    assert.ok(result.failed.every((e) => e.error.length > 0 && e.error.length <= 500));
    assert.deepEqual(await readFile(join(f.root, f.ids[1], "audio.wav")), f.wav);
  } finally { await f.close(); }
});

test("batch delete refuses an unsafe trash directory and keeps every selected source", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "music-outside-"));
  try {
    await symlink(outside, join(f.root, ".trash"));
    const result = await f.library.removeBatch(f.ids);
    assert.deepEqual(result.deleted, []); assert.equal(result.failed.length, 3);
    assert.ok(result.failed.every((e) => /Unsafe trash/.test(e.error)));
    assert.equal((await f.library.list()).length, 3); assert.deepEqual(await readdir(outside), []);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});
