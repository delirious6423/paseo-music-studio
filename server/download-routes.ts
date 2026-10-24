import { networkInterfaces } from "node:os";
import type { DownloadTarget } from "../shared/music";
import { Downloads } from "./downloads";
import type { Library } from "./library";

export function downloadRoutes(interfaces = networkInterfaces()) {
  const routes: DownloadTarget[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry.address)) continue;
      const [a, b, c, d] = entry.address.split(".").map(Number);
      if ([a, b, c, d].some((n) => n > 255)) continue;
      const tailnet = /tailscale/i.test(name) && a === 100 && b >= 64 && b <= 127;
      const privateIp = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (!tailnet && (!privateIp || /^(?:lo|docker|veth|virbr|incus|lxdbr|cni|br-|vmnet|vmware|virtualbox|vboxnet|podman|cali|flannel|tun|tap|utun|wg|proton|zt|nordlynx|mullvad|ppp)/i.test(name))) continue;
      if (routes.some((r) => r.address === entry.address)) continue;
      routes.push({ kind: tailnet ? "tailscale" : "lan", address: entry.address, interface: name.slice(0, 128), cidr: entry.cidr });
    }
  }
  return routes.sort((a, b) => Number(b.kind === "tailscale") - Number(a.kind === "tailscale")).slice(0, 8);
}

const key = (target: DownloadTarget) => JSON.stringify([target.kind, target.address, target.interface, target.cidr]);

export class DownloadConnections {
  private services = new Map<string, { service: Downloads; expires: number }>();
  private retiring = new Map<Downloads, string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(readonly options = downloadRoutes, private pollMs = 1000, private lifetimeMs = 300000) {}
  private retire(id: string, force = true) {
    const entry = this.services.get(id);
    if (!entry) return;
    this.services.delete(id);
    const closing = entry.service.close(force);
    this.retiring.set(entry.service, id);
    void closing.then(() => this.retiring.delete(entry.service), (error) => { this.retiring.delete(entry.service); console.error("Download cleanup failed", error); });
  }
  private sweep() {
    let current: Set<string>;
    try { current = new Set(this.options().map(key)); }
    catch (error) { console.error("Cannot verify download connections; closing listeners", error); current = new Set(); }
    for (const [id, entry] of this.services) {
      if (!current.has(id)) this.retire(id);
      else if (entry.service.stopped || entry.expires <= Date.now()) this.retire(id, false);
    }
    for (const [service, route] of this.retiring) if (!current.has(route)) void service.close(true);
    if (!this.services.size && !this.retiring.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  async create(library: Library, id: string | string[], target: DownloadTarget) {
    if (this.closed) throw new Error("Downloads are stopped");
    this.sweep();
    const route = key(target);
    if (!this.options().some((r) => key(r) === route)) throw new Error("That connection changed or is unavailable. Reopen Download setup and recheck connections.");
    let entry = this.services.get(route);
    if (!entry) {
      if (this.services.size + this.retiring.size >= 16) throw new Error("Previous downloads are still finishing; retry shortly");
      entry = { service: new Downloads(() => target.address, this.lifetimeMs, Date.now, () => this.options().some((r) => key(r) === route)), expires: Date.now() + this.lifetimeMs };
      this.services.set(route, entry);
    }
    if (!this.timer) { this.timer = setInterval(() => this.sweep(), this.pollMs); this.timer.unref(); }
    try {
      const link = await entry.service.create(library, id);
      entry.expires = Math.max(entry.expires, Date.parse(link.expiresAt));
      return link;
    } catch (error) {
      if (entry.service.stopped && this.services.get(route) === entry) this.retire(route, false);
      throw error;
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const id of this.services.keys()) this.retire(id);
    await Promise.all([...this.retiring.keys()].map((service) => service.close(true)));
  }
}
