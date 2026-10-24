import { AUDIO_CHUNK_BYTES, MAX_PLAYBACK_BYTES, audioInfoSchema, audioChunkSchema, type AudioChunk, type AudioInfo } from "../shared/music";

function validBase64(base64: string, length: number) {
  const padding = (3 - length % 3) % 3;
  return base64.length === Math.ceil(length / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64) &&
    (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0) === padding;
}

export async function assembleAudio(
  id: string,
  info: (input: { id: string }) => Promise<AudioInfo>,
  chunk: (input: { id: string; offset: number; version: string }) => Promise<AudioChunk>,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
  inline?: (input: { id: string }) => Promise<{ base64: string; mimeType?: "audio/wav" | "audio/mpeg" }>,
) {
  const check = () => { if (signal.aborted) throw new Error("Audio transfer cancelled"); };
  check();
  const { total, version, mimeType = "audio/wav" } = audioInfoSchema.parse(await info({ id }));
  check();
  if (inline && total <= MAX_PLAYBACK_BYTES) {
    const audio = await inline({ id });
    check();
    const after = audioInfoSchema.parse(await info({ id }));
    check();
    if (after.version !== version || after.total !== total || (after.mimeType ?? "audio/wav") !== mimeType || (audio.mimeType !== undefined && audio.mimeType !== mimeType) || !validBase64(audio.base64, total)) throw new Error("Track changed or audio is incomplete; select it and try again");
    progress(100);
    return { base64: audio.base64, mimeType };
  }
  const parts: string[] = [];
  for (let offset = 0; offset < total; offset += AUDIO_CHUNK_BYTES) {
    check();
    const part = audioChunkSchema.parse(await chunk({ id, offset, version }));
    check();
    const length = Math.min(AUDIO_CHUNK_BYTES, total - offset);
    if (part.offset !== offset || part.total !== total || part.version !== version || (part.mimeType !== undefined && part.mimeType !== mimeType) || !validBase64(part.base64, length)) {
      throw new Error("Invalid audio chunk; select the track and try again");
    }
    parts.push(part.base64);
    progress(Math.round((offset + length) * 100 / total));
  }
  check();
  return { base64: parts.join(""), mimeType };
}
