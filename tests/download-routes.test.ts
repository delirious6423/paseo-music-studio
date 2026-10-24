import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DownloadConnections, downloadRoutes } from "../server/download-routes";
import { downloadInput } from "../shared/music";
import { Library } from "../server/library";
import { wav } from "./wav-fixture";

const ipv4 = (address: string): NetworkInterfaceInfo => ({ family: "IPv4", address, internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: address + "/24" });

test("onboarding finds private Wi-Fi/Ethernet without Tailscale and rejects public/virtual addresses", () => {
  const options = downloadRoutes({
    wlan0: [ipv4("192.168.50.10")], Ethernet: [ipv4("172.16.2.3")], en0: [ipv4("10.1.2.3")],
    tailscale0: [ipv4("100.64.0.10")], modem0: [ipv4("100.64.1.2")],
    docker0: [ipv4("172.17.0.1")], incusbr0: [ipv4("10.0.0.1")], proton0: [ipv4("10.3.0.2")],
    "vEthernet (WSL)": [ipv4("172.16.1.1")], lxdbr0: [ipv4("10.1.0.1")], vboxnet0: [ipv4("192.168.56.1")], nordlynx: [ipv4("10.5.0.2")],
    public0: [ipv4("8.8.8.8")], wildcard: [ipv4("0.0.0.0")], loopback: [{ ...ipv4("127.0.0.1"), internal: true }],
    linklocal: [ipv4("169.254.1.1")], invalid: [ipv4("192.168.999.1")],
  });
  assert.deepEqual(options.map((r) => [r.kind, r.address]), [
    ["tailscale", "100.64.0.10"], ["lan", "192.168.50.10"], ["lan", "172.16.2.3"], ["lan", "10.1.2.3"],
  ]);
  assert.equal(downloadRoutes({ en0: [ipv4("192.168.0.5")] })[0].kind, "lan");
  assert.deepEqual(downloadRoutes({}), []);
  assert.deepEqual(downloadRoutes({ ipv6: [{ family: "IPv6", address: "::1", internal: true, netmask: "", mac: "", cidr: "::1/128", scopeid: 0 }] }), []);
  assert.equal(downloadRoutes({ en0: [ipv4("192.168.0.5")], alias: [ipv4("192.168.0.5")] }).length, 1);
});

test("download RPC requires an explicit route and consent; legacy/declined requests cannot open a listener", () => {
  const id = randomUUID(), target = { kind: "lan", address: "192.168.50.10", interface: "wlan0", cidr: "192.168.50.10/24" };
  for (const input of [{ id }, { id, target }, { id, target, acknowledged: false }, { id, target: { ...target, kind: "public" }, acknowledged: true }]) assert.equal(downloadInput.safeParse(input).success, false);
  assert.equal(downloadInput.safeParse({ id, target, acknowledged: true }).success, true);
});

test("LAN download works on the native guest interface, with no listener during options discovery or automatic fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "music-onboarding-test-")), library = new Library(root);
  const id = randomUUID(), bytes = wav();
  const options = downloadRoutes().filter((r) => r.kind === "lan");
  assert.ok(options.length, "The native VM must have a private LAN interface for this acceptance test");
  let visible = options;
  const manager = new DownloadConnections(() => visible, 25);
  const listenerCount = () => process.getActiveResourcesInfo().filter((r) => /tcpserver/i.test(r)).length;
  const before = listenerCount();
  try {
    manager.options(); assert.equal(listenerCount(), before);
    await library.save({ id, title: "Phone download", prompt: "Jazz", duration: 1, steps: 8, seed: 1, model: "medium", createdAt: new Date().toISOString() }, bytes.toString("base64"));
    for (const target of [{ ...options[0], address: "0.0.0.0" }, { ...options[0], address: "8.8.8.8" }, { ...options[0], kind: "tailscale" as const }, { ...options[0], interface: "other" }, { ...options[0], cidr: "10.0.0.1/8" }]) await assert.rejects(manager.create(library, id, target), /unavailable/);
    assert.equal(listenerCount(), before);
    const links = await Promise.all(Array.from({ length: 3 }, () => manager.create(library, id, options[0])));
    assert.equal(listenerCount(), before + 1);
    assert.equal(new Set(links.map((l) => new URL(l.url).port)).size, 1);
    assert.equal(new URL(links[0].url).hostname, options[0].address);
    const response = await fetch(links[0].url);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await library.list()).length, 1);
    visible = options.map((r) => ({ ...r, cidr: r.address + (r.cidr?.endsWith("/32") ? "/24" : "/32") }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(fetch(links[0].url));
    assert.equal(listenerCount(), before);
    await assert.rejects(manager.create(library, id, options[0]), /changed/);
    visible = options;
    const fresh = await manager.create(library, id, options[0]);
    assert.equal((await fetch(fresh.url)).status, 200);
    await manager.close();
    await assert.rejects(fetch(fresh.url));
    // Node may retain a closed libuv handle until the next event-loop turn.
    for (let i = 0; i < 20 && listenerCount() !== before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(listenerCount(), before);
    await assert.rejects(manager.create(library, id, options[0]), /stopped/);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
