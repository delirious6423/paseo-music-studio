import { MusicController } from "../server/controller";
const controller = new MusicController();
controller.start(JSON.parse(process.argv[2]), "medium");
const interval = setInterval(() => {
  if (controller.snapshot().phase === "ready") { process.stdout.write("ready\n"); clearInterval(interval); }
}, 20);
