import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as api from "./shared/music";
import { MusicController, modelCatalog } from "./server/controller";
import { Library } from "./server/library";
import { discoverLegacySetup } from "./server/setup";
import { DownloadConnections } from "./server/download-routes";

export default function contribute(server: PluginServerContext) {
  const preferences = server.registerSettings(api.settings);
  const controller = new MusicController();
  const downloads = new DownloadConnections();
  async function config() {
    const document = await preferences.read();
    if (document.status !== "ready") throw new Error("Engine settings are unavailable; open Settings");
    return document.values;
  }
  server.handle(api.setup, async () => (await config()).outputsDir ? null : discoverLegacySetup());
  server.handle(api.status, () => controller.snapshot());
  server.handle(api.models, async () => modelCatalog(await config()));
  server.handle(api.start, async ({ model }) => controller.start(await config(), model));
  server.handle(api.stop, () => controller.stop());
  server.handle(api.abort, () => controller.stop(true));
  server.handle(api.generate, (input) => controller.generate(input));
  server.handle(api.generateBatch, (input) => controller.generateBatch(input));
  async function library() { const path = (controller.config ?? await config()).outputsDir; if (!path) throw new Error("Configure a music output folder in Settings"); return new Library(path); }
  server.handle(api.retrySave, async () => controller.retrySave(controller.config ?? await config()));
  server.handle(api.tracks, async () => (controller.config ?? await config()).outputsDir ? (await library()).list() : []);
  server.handle(api.audio, async ({ id }) => (await library()).audio(id));
  server.handle(api.audioInfo, async ({ id }) => (await library()).audioInfo(id));
  server.handle(api.audioChunk, async ({ id, offset, version }) => (await library()).audioChunk(id, offset, version));
  server.handle(api.removeBatch, async ({ ids }) => (await library()).removeBatch(ids));
  server.handle(api.remove, async ({ id }) => (await library()).remove(id));
  server.handle(api.replay, async ({ id }) => (await library()).replay(id));
  server.handle(api.downloadBatch, async ({ ids, target }) => downloads.create(await library(), ids, target));
  server.handle(api.downloadOptions, () => downloads.options());
  server.handle(api.download, async ({ id, target }) => downloads.create(await library(), id, target));
  return async () => { await downloads.close(); await controller.stop(true); };
}
