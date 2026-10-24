// Structural RIFF/WAVE check shared by every path that imports or publishes audio.
// Walks a bounded number of chunks, so extra metadata (LIST, fact, bext…) and non-44-byte layouts are fine.
const PCM = 1, FLOAT = 3, EXTENSIBLE = 0xfffe;
const SUBFORMAT_TAIL = "000000001000800000aa00389b71"; // KSDATAFORMAT_SUBTYPE_{PCM,IEEE_FLOAT} after the 2-byte code.
const MAX_CHUNKS = 4096;

export type WavInfo = { format: "pcm" | "float"; channels: number; sampleRate: number; bitsPerSample: number; dataBytes: number };

export function wavInfo(bytes: Buffer): WavInfo {
  const fail: (reason: string) => never = (reason) => { throw new Error("Invalid WAV: " + reason); };
  if (bytes.length < 44) fail("file is too short");
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") fail("missing RIFF/WAVE header");
  const end = 8 + bytes.readUInt32LE(4);
  if (end > bytes.length) fail("RIFF size exceeds the file (truncated)");
  let fmt: Omit<WavInfo, "dataBytes"> & { blockAlign: number } | undefined, dataBytes: number | undefined;
  let offset = 12;
  for (let chunks = 0; offset + 8 <= end; chunks++) {
    if (chunks >= MAX_CHUNKS) fail("too many chunks");
    const id = bytes.toString("latin1", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), body = offset + 8;
    if (body + size > end) fail(`chunk "${id}" exceeds the RIFF size (truncated)`);
    if (id === "fmt ") {
      if (fmt) fail("duplicate fmt chunk");
      if (size < 16) fail("fmt chunk is too short");
      let tag = bytes.readUInt16LE(body);
      const channels = bytes.readUInt16LE(body + 2), sampleRate = bytes.readUInt32LE(body + 4), byteRate = bytes.readUInt32LE(body + 8);
      const blockAlign = bytes.readUInt16LE(body + 12), bitsPerSample = bytes.readUInt16LE(body + 14);
      if (tag === EXTENSIBLE) {
        if (size < 40 || bytes.readUInt16LE(body + 16) < 22) fail("extensible fmt chunk is too short");
        const valid = bytes.readUInt16LE(body + 18);
        if (bytes.toString("hex", body + 26, body + 40) !== SUBFORMAT_TAIL) fail("unsupported extensible subformat");
        tag = bytes.readUInt16LE(body + 24);
        if (valid < 1 || valid > bitsPerSample) fail("invalid valid-bits field");
      }
      if (tag !== PCM && tag !== FLOAT) fail("only PCM and IEEE float audio are supported");
      if (tag === PCM ? ![8, 16, 24, 32].includes(bitsPerSample) : ![32, 64].includes(bitsPerSample)) fail("unsupported bits per sample");
      if (channels < 1 || channels > 64) fail("unsupported channel count");
      if (sampleRate < 1000 || sampleRate > 768000) fail("unsupported sample rate");
      if (blockAlign !== channels * bitsPerSample / 8 || byteRate !== sampleRate * blockAlign) fail("inconsistent block alignment or byte rate");
      fmt = { format: tag === PCM ? "pcm" : "float", channels, sampleRate, bitsPerSample, blockAlign };
    } else if (id === "data") {
      if (dataBytes !== undefined) fail("duplicate data chunk");
      if (!fmt) fail("data chunk precedes fmt chunk");
      if (size === 0 || size % fmt.blockAlign !== 0) fail("audio data is empty or ends mid-frame");
      dataBytes = size;
    }
    // Odd chunks carry a pad byte; writers commonly omit it after the final chunk.
    offset = body + size + (size & 1);
  }
  if (!fmt) fail("missing fmt chunk");
  if (dataBytes === undefined) fail("missing data chunk");
  const { format, channels, sampleRate, bitsPerSample } = fmt;
  return { format, channels, sampleRate, bitsPerSample, dataBytes };
}
