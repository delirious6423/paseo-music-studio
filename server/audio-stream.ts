import { once } from "node:events";
import type { FileHandle } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { audioVersion } from "./library";

export async function readAudio(file: FileHandle, total: number, version: string, signal: AbortSignal | undefined, consume: (bytes: Buffer) => void | Promise<void>) {
  let offset = 0;
  while (offset < total) {
    if (signal?.aborted) throw new Error("Download cancelled");
    const buffer = Buffer.alloc(Math.min(65536, total - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) throw new Error("Track truncated during download");
    offset += bytesRead;
    await consume(buffer.subarray(0, bytesRead));
  }
  if (signal?.aborted) throw new Error("Download cancelled");
  if (audioVersion(await file.stat({ bigint: true })) !== version) throw new Error("Track changed during download");
}

export async function writeAudio(response: ServerResponse, bytes: Buffer, signal: AbortSignal) {
  if (signal.aborted || response.destroyed) throw new Error("Download cancelled");
  if (!response.write(bytes)) await once(response, "drain", { signal });
}
