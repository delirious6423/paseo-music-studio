import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { discoverLegacySetup } from "../server/setup";
import { configSchema } from "../shared/music";
import { Library } from "../server/library";
import { wav } from "./wav-fixture";

test("unsaved legacy defaults are offered for explicit adoption, not silently installed; legacy library remains readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-legacy-")), home = join(root, "home"), data = join(root, "data");
  try {
    assert.equal(await discoverLegacySetup(home), null);
    await mkdir(join(home, "code", "sa3.cpp"), { recursive: true });
    await mkdir(join(data, "build-cuda", "bin"), { recursive: true }); await mkdir(join(data, "models"));
    const binary = join(data, "build-cuda", "bin", process.platform === "win32" ? "sa3-server.exe" : "sa3-server");
    await writeFile(binary, "fixture only"); await chmod(binary, 0o755);
    await symlink(join(data, "build-cuda"), join(home, "code", "sa3.cpp", "build-cuda"));
    const library = new Library(join(data, "outputs", "paseo-music"));
    await library.save({ id: randomUUID(), title: "Legacy", prompt: "Jazz", duration: 1, steps: 8, seed: 1, model: "medium", createdAt: new Date().toISOString() }, wav().toString("base64"));
    const candidate = await discoverLegacySetup(home); assert.ok(candidate);
    assert.equal(configSchema.parse({}).outputsDir, "");
    const adopted = configSchema.parse(candidate);
    assert.equal((await new Library(adopted.outputsDir).list())[0].title, "Legacy");
  } finally { await rm(root, { recursive: true, force: true }); }
});
