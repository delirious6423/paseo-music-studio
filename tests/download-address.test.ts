import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { tailscaleAddress } from "../server/downloads";

test("only a named Tailscale adapter is accepted, not carrier-grade or LAN addresses", () => {
  const entry: NetworkInterfaceInfo = { family: "IPv4", address: "100.64.0.10", internal: false, netmask: "255.255.255.255", mac: "00:00:00:00:00:00", cidr: "100.64.0.10/32" };
  assert.throws(() => tailscaleAddress({ wwan0: [entry] }), /Tailscale/);
  assert.equal(tailscaleAddress({ wwan0: [{ ...entry, address: "100.64.0.1" }], tailscale0: [entry] }), entry.address);
  assert.equal(tailscaleAddress({ Tailscale: [entry] }), entry.address);
  assert.throws(() => tailscaleAddress({ tailscale0: [{ ...entry, address: "192.168.1.2" }] }), /Tailscale/);
  assert.throws(() => tailscaleAddress({}), /Tailscale/);
});
