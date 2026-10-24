import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AUDIO_CHUNK_BYTES, audioChunkInput, batchDownloadIds, generateInput, MAX_AUDIO_BYTES as MAX_AUDIO, MAX_PLAYBACK_BYTES, trackSchema, type Track } from "../shared/music";
import { wavInfo } from "./wav";
import { mp3Info } from "./mp3";
export function audioVersion(stat: BigIntStats) { return createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")).digest("hex"); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Unicode letters/marks/numbers survive (ZIP names are UTF-8); everything else, including separators,
// dots and control/bidi characters, becomes "-". The ID suffix keeps names unique. asciiFilename is the
// legacy form for headers that cannot carry UTF-8.
export function downloadName(title: string, id: string, extension: "wav" | "mp3" = "wav") {
  const name = (pattern: RegExp) => [...title.normalize("NFC").replace(pattern, "-").replace(/^-+|-+$/g, "")].slice(0, 70).join("").replace(/-+$/, "") || "music";
  const suffix = "-" + id.slice(0, 8) + "." + extension;
  return { filename: name(/[^\p{L}\p{M}\p{N}_-]+/gu) + suffix, asciiFilename: name(/[^a-zA-Z0-9_-]+/g) + suffix };
}

function audioFormat(track: Track) {
  const extension = (track.mimeType ? track.mimeType === "audio/mpeg" : track.minimax?.format === "mp3") ? "mp3" as const : "wav" as const;
  const mimeType = extension === "mp3" ? "audio/mpeg" as const : "audio/wav" as const;
  return { extension, mimeType, name: "audio." + extension };
}

function replayCodes(replay: string) {
  if (Buffer.byteLength(replay) > 4 * 1024 * 1024) throw new Error("Replay JSON exceeds 4 MiB");
  const data: unknown = JSON.parse(replay);
  if (!data || typeof data !== "object" || !("audio_codes" in data) || typeof data.audio_codes !== "string" || !data.audio_codes.trim() || Buffer.byteLength(data.audio_codes) > 1024 * 1024) throw new Error("Invalid replay audio codes (expected a nonempty string up to 1 MiB)");
  return data.audio_codes;
}

// Everything that can make a completed take permanently unsaveable is checked here, before the
// controller retains it for Retry save; Library.save repeats the check before publishing.
export function prepareTake(track: Track, audio: string | Buffer, replay?: string) {
  if (replay !== undefined) replayCodes(replay);
  track = trackSchema.parse({ ...track, replayAvailable: replay === undefined ? undefined : true });
  if (track.minimax) delete track.minimax.audioCodes;
  if (typeof audio === "string" && audio.length > Math.ceil(MAX_AUDIO / 3) * 4) throw new Error("Generated audio exceeds 128 MiB");
  const bytes = typeof audio === "string" ? Buffer.from(audio, "base64") : audio;
  if (bytes.length > MAX_AUDIO) throw new Error("Generated audio exceeds 128 MiB");
  if (audioFormat(track).extension === "mp3") track.audioSeconds = mp3Info(bytes).seconds;
  else { const info = wavInfo(bytes); track.audioSeconds = info.dataBytes / (info.sampleRate * info.channels * info.bitsPerSample / 8); }
  const metadata = JSON.stringify(track, null, 2);
  if (Buffer.byteLength(metadata) > 65536) throw new Error("Track metadata too large");
  return { track, metadata, bytes };
}

export async function regular(path: string, limit: number) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error("Unsafe or oversized track file");
  const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid track file");
    return await f.readFile();
  } finally { await f.close(); }
}

export class Library {
  constructor(readonly root: string) {}
  private async directory(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid track ID");
    const p = join(await realpath(this.root), id);
    const stat = await lstat(p);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(p) !== p) throw new Error("Unsafe track directory");
    return p;
  }
  async list(): Promise<Track[]> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const result: Track[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      try {
        const p = await this.directory(entry.name);
        const track = await this.metadata(p, entry.name);
        const audio = await lstat(join(p, audioFormat(track).name));
        if (audio.isFile() && !audio.isSymbolicLink()) result.push({ ...track, audioBytes: audio.size });
      } catch { /* Incomplete, corrupt, or non-plugin tracks are not in the library. */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async save(take: Track, audio: string | Buffer, replay?: string) {
    const { track, metadata, bytes } = prepareTake(take, audio, replay);
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    // Unique staging directories are invisible to list(); publish only a complete track.
    // A hard crash (power loss, SIGKILL) between mkdir and rename leaves this hidden .pending-<uuid>
    // folder behind. It is never auto-deleted: it is safe to remove by hand while the plug-in is idle.
    const staging = join(root, ".pending-" + randomUUID());
    await mkdir(staging);
    try {
      await writeFile(join(staging, audioFormat(track).name), bytes, { flag: "wx" });
      await writeFile(join(staging, "track.json"), metadata, { flag: "wx" });
      if (replay !== undefined) await writeFile(join(staging, "replay.json"), replay, { flag: "wx" });
      await rename(staging, join(root, track.id));
    } catch (error) {
      // The write error is the actionable one; a failed cleanup must not replace it.
      await rm(staging, { recursive: true, force: true }).catch((cleanup) => console.error("Cannot remove save staging", staging, cleanup));
      throw error;
    }
  }
  private async metadata(p: string, id: string) {
    const meta = trackSchema.parse(JSON.parse((await regular(join(p, "track.json"), 65536)).toString()));
    if (meta.id !== id) throw new Error("Track ID mismatch");
    if (meta.minimax) delete meta.minimax.audioCodes;
    return meta;
  }
  async replay(id: string) {
    const p = await this.directory(id), meta = await this.metadata(p, id);
    const audioCodes = replayCodes((await regular(join(p, "replay.json"), 4 * 1024 * 1024)).toString("utf8"));
    return generateInput.parse({ ...meta, minimax: { ...meta.minimax, audioCodes, lmBatch: 1, synthBatch: 1 } });
  }
  async file(id: string) {
    const p = await this.directory(id), meta = await this.metadata(p, id), format = audioFormat(meta);
    return { bytes: await regular(join(p, format.name), MAX_AUDIO), mimeType: format.mimeType, ...downloadName(meta.title, id, format.extension) };
  }
  async audio(id: string) {
    const { bytes, mimeType } = await this.file(id);
    if (bytes.length > MAX_PLAYBACK_BYTES) throw new Error("This audio is too large for safe in-app playback through Paseo’s relay. Use Download for the full-quality track.");
    return { base64: bytes.toString("base64"), mimeType };
  }
  async audioFile(id: string) {
    const p = await this.directory(id), meta = await this.metadata(p, id), format = audioFormat(meta);
    const path = join(p, format.name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe track file");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size < (format.extension === "mp3" ? 4n : 44n) || stat.size > BigInt(MAX_AUDIO) || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("Invalid or changed track file");
      return { file, total: Number(stat.size), version: audioVersion(stat), mimeType: format.mimeType, ...downloadName(meta.title, id, format.extension) };
    } catch (error) { await file.close(); throw error; }
  }
  async audioInfo(id: string) {
    const { file, total, version, mimeType } = await this.audioFile(id);
    try { return { total, version, mimeType }; } finally { await file.close(); }
  }
  async audioChunk(id: string, offset: number, version: string) {
    audioChunkInput.parse({ id, offset, version });
    const opened = await this.audioFile(id);
    const { file, total } = opened;
    try {
      if (version !== opened.version) throw new Error("Track changed; select it and try again");
      if (offset >= total || offset % AUDIO_CHUNK_BYTES !== 0) throw new Error("Invalid audio chunk offset");
      const bytes = Buffer.alloc(Math.min(AUDIO_CHUNK_BYTES, total - offset));
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, offset + read);
        if (!result.bytesRead) throw new Error("Track changed during transfer");
        read += result.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      const current = audioVersion(after);
      if (current !== version) throw new Error("Track changed during transfer");
      return { total, version, offset, mimeType: opened.mimeType, base64: bytes.toString("base64") };
    } finally { await file.close(); }
  }
  async removeBatch(ids: string[]) {
    ids = batchDownloadIds.parse(ids);
    const deleted: string[] = [], failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try { await this.remove(id); deleted.push(id); }
      catch (error) { failed.push({ id, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }); }
    }
    return { deleted, failed };
  }
  async remove(id: string) {
    const p = await this.directory(id);
    await this.metadata(p, id);
    const trash = join(await realpath(this.root), ".trash");
    await mkdir(trash, { recursive: true });
    const stat = await lstat(trash);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(trash) !== trash) throw new Error("Unsafe trash directory");
    await rename(p, join(trash, id + "-" + randomUUID()));
    return { deleted: true };
  }
}
