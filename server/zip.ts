import { crc32 } from "node:zlib";
import type { ServerResponse } from "node:http";
import { batchDownloadIds } from "../shared/music";
import type { Library } from "./library";
import { readAudio, writeAudio } from "./audio-stream";

// Stored ZIP32: WAVs stay byte-exact; bounded selections fit below ZIP64's 4 GiB threshold.
type Entry = { id: string; total: number; version: string; name: Buffer; crc: number | null };
export async function archivePlan(library: Library, ids: string[], signal?: AbortSignal, checksum = true, previous?: { entries: Entry[] }) {
  const check = () => { if (signal?.aborted) throw new Error("Download cancelled"); };
  check();
  ids = batchDownloadIds.parse(ids);
  const entries: Entry[] = [];
  for (const [index, id] of ids.entries()) {
    check();
    const { file, total, version, filename } = await library.audioFile(id);
    try {
      const cached = previous?.entries.find((entry) => entry.id === id && entry.total === total && entry.version === version && entry.crc !== null);
      let crc = cached?.crc ?? 0;
      if (checksum && !cached) await readAudio(file, total, version, signal, (bytes) => { crc = crc32(bytes, crc); });
      check();
      entries.push({ id, total, version, name: Buffer.from(`${String(index + 1).padStart(2, "0")}-${filename}`), crc: checksum ? crc : null });
    }
    finally { await file.close(); }
  }
  const length = 22 + entries.reduce((sum, e) => sum + 30 + e.name.length + e.total + 46 + e.name.length, 0);
  if (length >= 0xffffffff) throw new Error("Download batch exceeds ZIP32 size limit");
  return { entries, length };
}

export async function streamArchive(response: ServerResponse, library: Library, plan: Awaited<ReturnType<typeof archivePlan>>) {
  const abort = new AbortController(), stop = () => abort.abort();
  response.once("close", stop);
  const write = (bytes: Buffer) => writeAudio(response, bytes, abort.signal);
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const entry of plan.entries) {
      const { file, total, version } = await library.audioFile(entry.id);
      try {
        if (entry.crc === null) throw new Error("ZIP checksums were not prepared");
        if (total !== entry.total || version !== entry.version) throw new Error("Track changed during ZIP download; create a fresh link");
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0x21, 12); local.writeUInt32LE(entry.crc, 14);
        local.writeUInt32LE(total, 18); local.writeUInt32LE(total, 22); local.writeUInt16LE(entry.name.length, 26);
        await write(local); await write(entry.name);
        let crc = 0;
        await readAudio(file, total, version, abort.signal, async (bytes) => { crc = crc32(bytes, crc); await write(bytes); });
        if (crc !== entry.crc) throw new Error("Track content changed during ZIP download");
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16);
        record.writeUInt32LE(total, 20); record.writeUInt32LE(total, 24); record.writeUInt16LE(entry.name.length, 28);
        record.writeUInt32LE(offset, 42); central.push(record, entry.name);
        offset += 30 + entry.name.length + total;
      } finally { await file.close(); }
    }
    const start = offset;
    for (const record of central) { await write(record); offset += record.length; }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(plan.entries.length, 8); end.writeUInt16LE(plan.entries.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end); response.end();
  } finally { response.removeListener("close", stop); }
}
