// The guard owns a separate POSIX process group. Owner-group death closes stdin;
// the surviving guard then kills its entire group, including leftover CLI workers.
export const guardScript = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const windows = process.platform === "win32";
const env = { ...process.env }; delete env.NODE_CHANNEL_FD; delete env.NODE_CHANNEL_SERIALIZATION_MODE;
const engine = spawn(process.argv[1], process.argv.slice(2), { env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true, shell: false });
let stopping = false, finishing = false, force;
function signal(sig) {
  try {
    if (windows && engine.pid) {
      const root = process.env.SystemRoot || process.env.SYSTEMROOT;
      if (!root) throw new Error("Windows SystemRoot is unavailable; cannot terminate command tree");
      const result = spawnSync(require("node:path").join(root, "System32", "taskkill.exe"), ["/PID", String(engine.pid), "/T", "/F"], { shell: false, windowsHide: true, timeout: 2000, stdio: "ignore" });
      if (result.error) throw result.error;
    } else if (!windows) process.kill(-process.pid, sig);
  } catch (e) { if (e.code !== "ESRCH") console.error(e.message); }
}
function finish(code) {
  if (finishing) return; finishing = true; clearTimeout(force);
  const end = () => { if (windows) process.exit(code || 0); else signal("SIGKILL"); };
  const deadline = setTimeout(end, 500);
  if (process.send && process.connected) { try { process.send({ type: "engine-exit", code }, () => { clearTimeout(deadline); end(); }); } catch { end(); } }
  else end();
}
function stop() {
  if (stopping) return;
  stopping = true; signal("SIGTERM");
  force = setTimeout(() => signal("SIGKILL"), 2000);
}
process.stdin.resume();
process.stdin.on("end", stop); process.stdin.on("error", stop);
process.on("SIGTERM", stop); process.on("SIGINT", stop);
engine.on("error", (e) => { console.error(e.message); finish(1); });
engine.on("close", (code) => finish(code));
`;
