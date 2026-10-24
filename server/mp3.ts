import { MAX_AUDIO_BYTES } from "../shared/music";

const mpeg1Rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Rates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

// Structural validation, not decoding: follow every Layer III frame boundary without resyncing
// past junk. Work is bounded by the shared audio limit; free-format (no bitrate) is unsupported.
export function mp3Info(bytes: Buffer) {
  const invalid = (reason: string): never => { throw new Error("Invalid MP3: " + reason); };
  if (bytes.length > MAX_AUDIO_BYTES) invalid("audio exceeds 128 MiB");
  let offset = 0, frames = 0, seconds = 0;
  const end = bytes.length;
  while (bytes.toString("latin1", offset, offset + 3) === "ID3") {
    if (end - offset < 10) invalid("truncated ID3 header");
    const version = bytes[offset + 3], flags = bytes[offset + 5];
    const allowedFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : version === 4 ? 0xf0 : -1;
    if (allowedFlags < 0 || bytes[offset + 4] === 255 || (flags & ~allowedFlags)) invalid("unsupported ID3 header");
    let size = 0;
    for (let i = 6; i < 10; i++) {
      const digit = bytes[offset + i];
      if (digit & 0x80) invalid("invalid ID3 synchsafe size");
      size = size * 128 + digit;
    }
    const footer = version === 4 && (flags & 0x10) ? 10 : 0, next = offset + 10 + size;
    if (next + footer > end) invalid("truncated ID3 tag");
    if (footer && (bytes.toString("latin1", next, next + 3) !== "3DI" || !bytes.subarray(next + 3, next + 10).equals(bytes.subarray(offset + 3, offset + 10)))) invalid("invalid ID3 footer");
    offset = next + footer;
  }
  while (offset < end) {
    if (end - offset === 128 && bytes.toString("latin1", offset, offset + 3) === "TAG") break;
    if (end - offset < 4) invalid("truncated frame header");
    const header = bytes.readUInt32BE(offset), version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3, bitrateIndex = (header >>> 12) & 15, rateIndex = (header >>> 10) & 3;
    if ((header >>> 21) !== 0x7ff || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || (header & 3) === 2) invalid("invalid Layer III frame header");
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (version === 3 ? mpeg1Rates : mpeg2Rates)[bitrateIndex];
    const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((header >>> 9) & 1);
    const mono = ((header >>> 6) & 3) === 3;
    const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const crc = header & 0x10000 ? 0 : 2;
    if (length < 4 + crc + sideInfo || length > end - offset) invalid("truncated frame");
    offset += length;
    frames++; seconds += (version === 3 ? 1152 : 576) / sampleRate;
  }
  if (!frames) invalid("no audio frames");
  return { frames, seconds };
}
