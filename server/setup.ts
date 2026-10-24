import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configSchema } from "../shared/music";

// Optional legacy-layout discovery, never defaults or an automatic settings write.
export async function discoverLegacySetup(home = homedir()) {
  const binary = join(home, "code", "sa3.cpp", "build-cuda", "bin", process.platform === "win32" ? "sa3-server.exe" : "sa3-server");
  try {
    await access(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    const root = dirname(dirname(dirname(await realpath(binary))));
    const modelsDir = join(root, "models"), outputsDir = join(root, "outputs", "paseo-music");
    await access(modelsDir, constants.R_OK);
    return configSchema.parse({ binary, modelsDir, outputsDir });
  } catch { return null; }
}
