import { createServer, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { Library } from "./library";
import { batchDownloadIds } from "../shared/music";
import { archivePlan, streamArchive } from "./zip";
import { readAudio, writeAudio } from "./audio-stream";

export function tailscaleAddress(interfaces = networkInterfaces()) {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!/tailscale/i.test(name)) continue;
    for (const entry of addresses ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [first, second] = entry.address.split(".").map(Number);
      if (first === 100 && second >= 64 && second <= 127) return entry.address;
    }
  }
  throw new Error("Connect this host and your phone to Tailscale before downloading music");
}

export class Downloads {
  private server?: Server;
  private starting?: Promise<void>;
  private host = "";
  private port = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing?: Promise<void>;
  private links = new Map<string, { id: string | string[]; library: Library; expires: number; plan?: Awaited<ReturnType<typeof archivePlan>> }>();
  constructor(private address = tailscaleAddress, private lifetimeMs = 300000, private now = Date.now, private available = () => true,
    private timing = { idleMs: 30000, baseMs: 30 * 60 * 1000, per25MiBMs: 60000 }) {}
  get stopped() { return this.closed; }
  private fail(response: ServerResponse, code: number) {
    if (response.headersSent || response.destroyed) { response.destroy(); return; }
    response.writeHead(code, { "Cache-Control": "no-store" }); response.end();
  }
  private async ensureStarted() {
    if (this.closed) throw new Error("Downloads are stopped");
    if (this.starting) return this.starting;
    if (this.server?.listening) return;
    if (this.server) throw new Error("Download listener expired; prepare a fresh link");
    this.starting = (async () => {
      this.host = this.address();
      let active = 0;
      const server = createServer((request, response) => {
        if (active >= 4) { this.fail(response, 503); return; }
        active++;
        const started = Date.now(), abort = new AbortController();
        let deadline = setTimeout(() => response.destroy(), this.timing.baseMs);
        deadline.unref();
        const transferBudget = (bytes: number) => {
          clearTimeout(deadline);
          const budget = this.timing.baseMs + Math.ceil(bytes / (25 * 1048576)) * this.timing.per25MiBMs;
          deadline = setTimeout(() => response.destroy(), Math.max(1, started + budget - Date.now()));
          deadline.unref();
          request.socket.setTimeout(this.timing.idleMs);
        };
        response.once("close", () => { active--; clearTimeout(deadline); abort.abort(); });
        void (async () => {
          if (!this.available()) return this.fail(response, 404);
          if (request.headers.host !== this.host + ":" + this.port) return this.fail(response, 403);
          if (request.method !== "GET" && request.method !== "HEAD") return this.fail(response, 405);
          const token = /^\/download\/([a-f0-9]{64})$/.exec(request.url ?? "")?.[1];
          const link = token && this.links.get(token);
          if (!link || link.expires <= this.now()) return this.fail(response, 404);
          try {
            // Disk preparation is bounded by the overall deadline, not network inactivity.
            request.socket.setTimeout(0);
            if (Array.isArray(link.id)) {
              const plan = await archivePlan(link.library, link.id, abort.signal, request.method !== "HEAD", link.plan);
              if (request.method !== "HEAD") link.plan = plan;
              if (response.destroyed) return;
              transferBudget(plan.length);
              response.writeHead(200, {
                "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="paseo-music.zip"',
                "Content-Length": plan.length, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
              });
              if (request.method === "HEAD") response.end();
              else await streamArchive(response, link.library, plan);
              return;
            }
            const { file, total, version, filename, asciiFilename, mimeType } = await link.library.audioFile(link.id);
            try {
              if (response.destroyed) return;
              transferBudget(total);
              const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
              response.writeHead(200, {
                "Content-Type": mimeType,
                "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encoded}`,
                "Content-Length": total, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
              });
              if (request.method !== "HEAD") await readAudio(file, total, version, abort.signal, (bytes) => writeAudio(response, bytes, abort.signal));
              response.end();
            } finally { await file.close(); }
          } catch { this.fail(response, 404); }
        })().catch(() => this.fail(response, 500));
      });
      server.setTimeout(this.timing.idleMs, (socket) => socket.destroy());
      server.maxConnections = 4;
      server.requestTimeout = 15000;
      server.keepAliveTimeout = 1000;
      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, this.host, () => {
            this.port = (server.address() as { port: number }).port;
            resolve();
          });
        });
      } catch (error) { this.server = undefined; throw error; }
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  async create(library: Library, id: string | string[]) {
    if (this.closed) throw new Error("Downloads are stopped; prepare a fresh link");
    if (Array.isArray(id)) { id = batchDownloadIds.parse(id); for (const track of id) await library.audioInfo(track); }
    else await library.audioInfo(id);
    await this.ensureStarted();
    if (this.closed) throw new Error("Downloads are stopped");
    for (const [token, link] of this.links) if (link.expires <= this.now()) this.links.delete(token);
    while (this.links.size >= 32) this.links.delete(this.links.keys().next().value!);
    const token = randomBytes(32).toString("hex"), expires = this.now() + this.lifetimeMs * (Array.isArray(id) ? 3 : 1);
    this.links.set(token, { id, library, expires });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.close(false); }, Math.max(...[...this.links.values()].map((link) => link.expires)) - this.now());
    this.timer.unref();
    return { url: "http://" + this.host + ":" + this.port + "/download/" + token, expiresAt: new Date(expires).toISOString() };
  }
  async close(force = true) {
    this.closed = true; clearTimeout(this.timer); this.links.clear();
    await this.starting?.catch(() => {});
    const server = this.server;
    if (!server) return;
    this.closing ??= new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
    if (force) server.closeAllConnections();
    await this.closing;
  }
}
