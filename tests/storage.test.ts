import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Library } from "../server/library";
import { wav } from "./wav-fixture";

const take = (title: string) => ({ id: randomUUID(), title, prompt: "Jazz", duration: 1, steps: 8, seed: 1, model: "medium", createdAt: new Date().toISOString() });

test("library publishes only structurally valid WAVs and leaves no staging after a rejected save", async () => {
  const root = await mkdtemp(join(tmpdir(), "music-storage-")), library = new Library(root);
  try {
    const headerOnly = wav(48).fill(0, 12);
    await assert.rejects(library.save(take("Corrupt"), headerOnly.toString("base64")), /Invalid WAV/);
    await assert.rejects(library.save(take("Corrupt"), headerOnly), /Invalid WAV/);
    assert.deepEqual(await library.list(), []);
    await library.save(take("Valid"), wav(48));
    assert.deepEqual((await library.list()).map((t) => t.audioBytes), [48]);
    assert.deepEqual((await readdir(root)).filter((p) => p.startsWith(".pending-")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed publish removes only its own staging, keeps the original error and the existing folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "music-storage-")), library = new Library(root), track = take("Collision");
  try {
    // An unknown, non-empty folder already holds this ID: rename must fail and nothing of it may be touched.
    await mkdir(join(root, track.id)); await writeFile(join(root, track.id, "keep.txt"), "user data");
    const unknown = join(root, ".pending-" + randomUUID()); await mkdir(unknown); await writeFile(join(unknown, "audio.wav"), "earlier crash");
    await assert.rejects(library.save(track, wav(48)), (error: NodeJS.ErrnoException) => ["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(error.code ?? ""));
    assert.equal(await readFile(join(root, track.id, "keep.txt"), "utf8"), "user data");
    assert.deepEqual((await readdir(root)).filter((p) => p.startsWith(".pending-")), [unknown.slice(root.length + 1)]);
    assert.equal(await readFile(join(unknown, "audio.wav"), "utf8"), "earlier crash");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("download names from the library keep non-Latin titles and provide an ASCII header fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "music-storage-")), library = new Library(root), track = take("爵士樂 · 3/20");
  try {
    await library.save(track, wav(48));
    const file = await library.file(track.id), opened = await library.audioFile(track.id);
    try {
      for (const named of [file, opened]) {
        assert.equal(named.filename, `爵士樂-3-20-${track.id.slice(0, 8)}.wav`);
        assert.equal(named.asciiFilename, `3-20-${track.id.slice(0, 8)}.wav`);
      }
    } finally { await opened.file.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
