import { MusicController } from "../server/controller";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const controller = new MusicController(), config = JSON.parse(process.argv[2]);
controller.start(config, "example-synth");
while (controller.snapshot().phase === "starting") await delay(10);
if (controller.snapshot().phase !== "ready") throw new Error(controller.snapshot().message);
controller.generate({ title: "Fixture", prompt: "jazz", duration: 1, seed: 1, steps: 8 });
while (true) { try { await readFile(process.argv[3]); break; } catch { await delay(10); } }
console.log("ready");
setInterval(() => {}, 1000);
