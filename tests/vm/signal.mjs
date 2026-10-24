// Host-side VM orchestration only: reproduce timeout killing the runner and its tee together.
// The UI/app under test is never launched on the host. Requires the normal Incus VM prerequisites.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const run = promisify(execFile), root = resolve(import.meta.dirname, "../..");
const base = process.env.PASEO_MUSIC_TEST_DIR ?? join(process.env.DATA_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "paseo-music-tests");
await mkdir(base, { recursive: true });
const out = await mkdtemp(join(base, "signal-")), project = process.env.PASEO_MUSIC_INCUS_PROJECT ?? "default";
const query = (name) => run("incus", ["--force-local", "query", `/1.0/instances/${name}?project=${encodeURIComponent(project)}`], { timeout: 15000 });
const fd = openSync(join(out, "driver.log"), "a");
const child = spawn("timeout", ["180", join(root, "tests/ui/run.sh")], {
  cwd: root, detached: true, stdio: ["ignore", fd, fd],
  env: { ...process.env, PASEO_MUSIC_TEST_DIR: out, PASEO_MUSIC_INCUS_HELPER: "" },
});
closeSync(fd);
const exited = new Promise((resolve) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", (error) => resolve({ error })); });
let vm, token, folder, result;
try {
  const deadline = Date.now() + 140000;
  while (Date.now() < deadline) {
    folder = (await readdir(out)).find((p) => p.startsWith("ui-"));
    const log = folder ? await readFile(join(out, folder, "runner.log"), "utf8").catch(() => "") : "";
    vm = log.match(/Creating VM (pm-music-ui-[a-f0-9]{8}) /)?.[1];
    if (vm) {
      const info = await query(vm).then((r) => JSON.parse(r.stdout)).catch(() => null);
      token = info?.config?.["user.paseo-music.token"];
      if (info?.status === "Running" && typeof token === "string" && vm.endsWith(token.slice(0, 8))) {
        const ready = await run("incus", ["--force-local", "--project", project, "exec", vm, "-T", "--", "true"], { timeout: 10000 }).then(() => true, () => false);
        if (ready) break;
      }
    }
    if (child.exitCode !== null) throw new Error("Runner exited before the signal test; see driver.log");
    await delay(500);
  }
  assert(vm && token, "No owned VM became ready before the deadline");
  // Signal GNU timeout, which forwards to its whole child process group, including the logging tee.
  child.kill("SIGTERM");
  result = await exited;
  const cleanup = await readFile(join(out, folder, "cleanup.txt"), "utf8");
  assert.match(cleanup, /PASS: VM deleted and verified absent:/);
  await assert.rejects(query(vm), (error) => /Instance not found/.test(error.stderr ?? ""));
  console.log(`PASS: SIGTERM/tee regression; VM ${vm} deleted and independently verified absent`);
  console.log(`Runner result: ${JSON.stringify(result)}; artifacts: ${out}`);
} finally {
  if (!result) { child.kill("SIGTERM"); await exited; }
  if (vm && token) {
    const info = await query(vm).then((r) => JSON.parse(r.stdout)).catch(() => null);
    if (info?.config?.["user.paseo-music.token"] === token) {
      await run("incus", ["--force-local", "--project", project, "delete", vm, "--force"], { timeout: 120000 });
      console.error(`Recovered test-owned VM after failed cleanup assertion: ${vm}`);
    }
  }
}
