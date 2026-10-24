// MiniMax emits stage counters, not an overall percentage. A frame budget can end early.
export class MiniMaxProgress {
  private tails = { stdout: "", stderr: "" };
  private song = 1;
  private hasWindows = false;
  constructor(private songs: number, private replay = false) {}
  push(chunk: string, stream: "stdout" | "stderr" = "stderr") {
    const lines = (this.tails[stream] + chunk).split(/\r\n|\n|\r/);
    this.tails[stream] = lines.pop()!.slice(-4096);
    let activity: string | undefined;
    for (const line of lines) activity = this.line(line) ?? activity;
    return activity;
  }
  finish(stream: "stdout" | "stderr") {
    const line = this.tails[stream]; this.tails[stream] = "";
    return this.line(line);
  }
  private label() { return this.songs > 1 ? `song ${this.song}/${this.songs}` : "audio"; }
  private line(line: string): string | undefined {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\[Load\] (LM|Depth|Cond|DiT|VAE) backend:/))) return `Loading ${({ LM: "song model", Depth: "song decoder", Cond: "conditioning model", DiT: "audio renderer", VAE: "audio decoder" } as Record<string, string>)[m[1]]}…`;
    if (/^\[Store\] Load Depth:/.test(line)) return this.replay ? "Rebuilding conditioning from saved song codes…" : "Preparing song composition…";
    if (/^\[AR\] Prefill /.test(line)) return "Composing song structure…";
    if ((m = line.match(/^\[AR\] Frame (\d+)\/(\d+)$/))) return `Composing · frame ${m[1]}/${m[2]} budget (may finish early)`;
    if ((m = line.match(/^\[AR\] Song (\d+): \d+ frames \(([\d.]+)s of music\)/))) return `Song ${Number(m[1]) + 1} composed · ${m[2]} s`;
    if (/^\[AR\] Replay:/.test(line)) return "Song conditioning rebuilt from saved codes";
    if ((m = line.match(/^\[Synth\] Song (\d+)\/(\d+)/))) { this.song = Number(m[1]); this.hasWindows = false; return `Rendering ${this.label()}…`; }
    if (/^\[DiT\] Graph:/.test(line) && !this.hasWindows) return `Rendering ${this.label()}…`;
    if ((m = line.match(/^\[DiT\] Window (\d+)\/(\d+):/))) { this.hasWindows = true; return `Rendering ${this.label()} · ${m[1]}/${m[2]} windows completed`; }
    if (/^\[DiT\] CFG=/.test(line)) return `Decoding ${this.label()}…`;
    if (/^\[VAE\] Decode:/.test(line)) { const label = `Decoded ${this.label()}`; this.song++; this.hasWindows = false; return label; }
    if (/^\[Done\]/.test(line)) return "Encoding output files…";
    if (/^\[MP3\] Encoding /.test(line)) return "Encoding MP3 output…";
    if (/^\[Request\] Wrote /.test(line)) return "Writing audio and replay files…";
    return undefined;
  }
}
