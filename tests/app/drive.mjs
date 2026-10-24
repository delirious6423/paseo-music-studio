// Guest side of tests/app/run.sh: drive Paseo's packaged web client (served by the guest's packaged daemon)
// through the Studio: first-run setup → tone command profile → activate → 2 s take → select it → 3-take batch.
// Usage: node drive.mjs <runtime dir> <artifact dir> <daemon URL> <output dir> <tone-cli.mjs>
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, out, url, musicDir, toneCli] = process.argv.slice(2);
const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC", colorScheme: "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// music.audio-chunk responses as received over Paseo's client ⇄ daemon WebSocket (base64 of a 3 MiB slice + offset).
const CHUNK = 3 * 1024 * 1024;
const big = { chunks: [], maxFrame: 0 };
const links = [];
page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
  if (typeof payload === "string") for (const m of payload.matchAll(/"url":"(http:\/\/[^"]+)","expiresAt":"([^"]+)"/g)) links.push({ url: m[1], expiresAt: m[2] });
  if (typeof payload !== "string" || payload.length < 1_000_000) return;
  big.maxFrame = Math.max(big.maxFrame, payload.length);
  const b64 = payload.match(/"base64":"([A-Za-z0-9+/=]+)"/), offset = payload.match(/"offset":(\d+)/);
  if (b64 && offset) big.chunks.push({ offset: Number(offset[1]), base64: b64[1], frame: payload.length });
}));
// Listen → every chunk frame equals the file slice, all offsets in order → audio reaches playAudio ("Playing…").
async function listenChunked(file, artifact) {
  const bytes = readFileSync(file);
  big.chunks = []; big.maxFrame = 0;
  await page.getByRole("button", { name: "Listen to selected track" }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "Playing…" }).filter({ visible: true }).waitFor({ timeout: 180_000 });
  const offsets = big.chunks.map((c) => c.offset), expected = Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, i) => i * CHUNK);
  const mismatched = big.chunks.filter((c) => c.base64 !== bytes.subarray(c.offset, c.offset + CHUNK).toString("base64")).map((c) => c.offset);
  writeFileSync(join(out, artifact), JSON.stringify({ wavBytes: bytes.length, chunks: offsets.length, offsets, maxChunkFrame: Math.max(...big.chunks.map((c) => c.frame)), maxFrame: big.maxFrame, mismatched }, null, 2));
  assert.deepEqual(offsets, expected, "chunk offsets");
  assert.deepEqual(mismatched, [], "chunk bytes differ from the file");
  assert.ok(big.maxFrame < 32 * 1024 * 1024 / 4, "a frame exceeded 8 MiB: " + big.maxFrame);
  assert.equal(await page.getByRole("alert").count(), 0, "error after Listen: " + (await page.getByRole("alert").allInnerTexts()).join(" | "));
}
const step = async (name, fn) => {
  try { await fn(); console.log("PASS:", name); }
  catch (e) { await page.screenshot({ path: join(out, "failure.png") }).catch(() => {}); writeFileSync(join(out, "failure.txt"), (await page.locator("body").innerText().catch(() => "")).slice(0, 8000)); throw new Error(`${name}: ${e.message}`); }
};
const shot = (name) => page.screenshot({ path: join(out, name) });
// Paseo may restore the open Studio after a reload; reopen it from the sidebar only if it is not showing.
async function reloadStudio() {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const studio = page.getByRole("heading", { name: "Create a track" }).filter({ visible: true });
  await page.getByText("Paseo Music Studio", { exact: true }).first().waitFor({ timeout: 90_000 });
  if (!await studio.first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) await page.getByText("Paseo Music Studio", { exact: true }).first().click();
  await studio.first().waitFor({ timeout: 30_000 });
}

try {
  await step("web client loads from packaged daemon", async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("Paseo Music Studio", { exact: true }).first().waitFor({ timeout: 90_000 });
  });
  await step("open Studio from the sidebar", async () => {
    await page.getByText("Paseo Music Studio", { exact: true }).first().click();
    await page.getByText(/First-time setup/).waitFor({ timeout: 30_000 });
    await shot("app-first-run.png");
  });
  // Guest-only wrapper: each take sleeps 10 s before the tone CLI, so the page reload below provably lands mid-queue.
  const slowTone = join(out, "slow-tone.mjs");
  writeFileSync(slowTone, `await new Promise((r) => setTimeout(r, 10000));\nawait import(${JSON.stringify(pathToFileURL(toneCli).href)});\n`);
  const profile = [{ id: "tone-smoke", label: "Tone smoke test", backend: "command", binary: process.execPath, timeoutSeconds: 60,
    args: [slowTone, "--prompt={prompt}", "--duration", "{duration}", "--seed", "{seed}", "--output", "{output}"] }];
  await step("save output folder + trusted command profile in Settings", async () => {
    // Paseo's own sidebar also has a "Settings" button (#sidebar-settings); press the Studio's.
    await page.locator('[role=button][aria-label="Settings"]:not(#sidebar-settings)').click();
    await page.getByLabel("outputsDir", { exact: true }).fill(musicDir);
    await page.getByLabel("Custom command profiles", { exact: true }).fill(JSON.stringify(profile, null, 2));
    await page.getByRole("button", { name: "I trust these custom commands" }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText("Tone smoke test", { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.getByText(/First-time setup/).waitFor({ state: "detached", timeout: 30_000 });
  });
  await step("select and activate the command profile", async () => {
    await page.getByRole("radio", { name: /Tone smoke test/ }).first().click();
    await page.getByRole("button", { name: "Activate model" }).click();
    await page.getByText(/Engine · ready/).waitFor({ timeout: 60_000 });
  });
  await step("generate a 2 s take and see it in the library", async () => {
    await page.getByLabel("Track title", { exact: true }).fill("VM tone take");
    await page.getByLabel("Seconds (1–380)", { exact: true }).fill("2");
    await page.getByLabel("Seed (−1 = random)", { exact: true }).fill("7");
    await page.getByRole("button", { name: "Generate music" }).click();
    await page.getByRole("radio", { name: "VM tone take" }).waitFor({ timeout: 120_000 });
  });
  await step("select the saved take", async () => {
    await page.getByRole("radio", { name: "VM tone take" }).click();
    await page.getByRole("button", { name: "Download WAV" }).waitFor();
    const promptToggle = page.getByRole("button", { name: "Show music-generation prompt" }).filter({ visible: true });
    assert.equal(await promptToggle.getAttribute("aria-expanded"), "false", "saved prompt must start collapsed");
    const promptTop = await promptToggle.evaluate((el) => el.getBoundingClientRect().top);
    for (const name of ["Listen to selected track", "Delete selected track", "Download WAV"]) {
      assert.ok(await page.getByRole("button", { name, exact: true }).filter({ visible: true }).evaluate((el) => el.getBoundingClientRect().top) < promptTop, name + " must precede saved prompt");
    }
    await promptToggle.click();
    const hidePrompt = page.getByRole("button", { name: "Hide music-generation prompt" }).filter({ visible: true });
    assert.equal(await hidePrompt.getAttribute("aria-expanded"), "true");
    await hidePrompt.click();
    assert.equal(await promptToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("alert").count(), 0, "error banner shown");
    await page.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollTop) el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await shot("app-studio.png");
  });
  await step("WAV written by the tone CLI through the plug-in", async () => {
    const wavs = readdirSync(musicDir, { recursive: true }).filter((f) => String(f).endsWith(".wav"));
    assert.equal(wavs.length, 1, "wav files: " + wavs.join(","));
    const wav = readFileSync(join(musicDir, String(wavs[0])));
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.length, 44 + 2 * 16000 * 2, "2 s mono 16-bit 16 kHz");
    writeFileSync(join(out, "library.txt"), readdirSync(musicDir, { recursive: true }).join("\n"));
  });
  const variations = ["brushed drums, walking bass", "big-band brass stabs"];
  await step("generate a 3-take batch with prompt variations and seed 100", async () => {
    await page.getByLabel("Track title", { exact: true }).fill("VM batch");
    await page.getByLabel("Music direction", { exact: true }).fill("Tone base");
    await page.getByLabel("Seed (−1 = random)", { exact: true }).fill("100");
    await page.getByLabel("Take count (1–20)", { exact: true }).fill("3");
    await page.getByLabel("Prompt variations (one per line)", { exact: true }).fill(variations.join("\n"));
    const submit = page.getByRole("button", { name: "Generate 3 takes" });
    await submit.click();
    // The queue keeps the form locked until it ends; the server rejects a second start anyway.
    await page.waitForFunction(() => document.querySelector('[role=button][aria-label="Generate 3 takes"]')?.getAttribute("aria-disabled") === "true", null, { timeout: 2_000 });
    await page.getByText("Batch · 0/3 saved · take 1/3 · running").waitFor({ timeout: 5_000 });
  });
  await step("reload and reopen Studio mid-queue; the server-owned batch keeps running", async () => {
    await reloadStudio();
    // Takes are ≥10 s each, so the queue must still be running here; seeing it already finished fails the test.
    const status = page.getByText(/^Batch · \d\/3 saved · take \d\/3 · \w[\w-]*$/).filter({ visible: true });
    await status.waitFor({ timeout: 10_000 });
    const seen = await status.innerText();
    assert.match(seen, /^Batch · [0-2]\/3 saved · take [1-3]\/3 · running$/, "after reload: " + seen);
    writeFileSync(join(out, "after-reload.txt"), seen + "\n");
    // Fresh form (count 1), still locked by the server's generating phase.
    assert.equal(await page.getByRole("button", { name: "Generate music" }).filter({ visible: true }).getAttribute("aria-disabled"), "true");
    await page.getByRole("button", { name: "Cancel batch" }).filter({ visible: true }).waitFor();
    await page.getByText("Batch · 3/3 saved · take 3/3 · completed").filter({ visible: true }).waitFor({ timeout: 180_000 });
    for (let i = 1; i <= 3; i++) await page.getByRole("radio", { name: `VM batch · ${i}/3` }).filter({ visible: true }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("alert").count(), 0, "error banner shown");
    await page.getByText("Batch · 3/3 saved").filter({ visible: true }).scrollIntoViewIfNeeded();
    await shot("app-batch.png");
  });
  await step("batch takes saved with numbered titles, exact prompts and consecutive seeds", async () => {
    const tracks = readdirSync(musicDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name))
      .map((e) => ({ ...JSON.parse(readFileSync(join(musicDir, e.name, "track.json"), "utf8")), wav: readFileSync(join(musicDir, e.name, "audio.wav")).length }));
    assert.equal(tracks.length, 4, "single take + 3 batch takes");
    const batch = tracks.filter((t) => t.title.startsWith("VM batch")).sort((a, b) => a.title.localeCompare(b.title))
      .map(({ title, prompt, seed, duration, model, seedForwarded, wav }) => ({ title, prompt, seed, duration, model, seedForwarded, wav }));
    const wav = 44 + 2 * 16000 * 2;
    assert.deepEqual(batch, [
      { title: "VM batch · 1/3", prompt: "Tone base\n" + variations[0], seed: 100, duration: 2, model: "tone-smoke", seedForwarded: true, wav },
      { title: "VM batch · 2/3", prompt: "Tone base\n" + variations[1], seed: 101, duration: 2, model: "tone-smoke", seedForwarded: true, wav },
      { title: "VM batch · 3/3", prompt: "Tone base\n" + variations[0], seed: 102, duration: 2, model: "tone-smoke", seedForwarded: true, wav },
    ]);
    writeFileSync(join(out, "batch-tracks.json"), JSON.stringify(tracks, null, 2));
  });
  const longWav = 44 + 380 * 16000 * 2;
  await step("generate a 380 s tone take (Medium-length cap) through the command profile", async () => {
    await page.getByLabel("Track title", { exact: true }).fill("VM long tone");
    await page.getByLabel("Seconds (1–380)", { exact: true }).fill("380");
    await page.getByLabel("Seed (−1 = random)", { exact: true }).fill("5");
    await page.getByRole("button", { name: "Generate music" }).click();
    await page.getByRole("radio", { name: "VM long tone" }).filter({ visible: true }).waitFor({ timeout: 120_000 });
    const dir = readdirSync(musicDir).find((d) => { try { return JSON.parse(readFileSync(join(musicDir, d, "track.json"), "utf8")).title === "VM long tone"; } catch { return false; } });
    const meta = JSON.parse(readFileSync(join(musicDir, dir, "track.json"), "utf8"));
    assert.equal(meta.duration, 380);
    assert.equal(readFileSync(join(musicDir, dir, "audio.wav")).length, longWav, "380 s mono 16-bit 16 kHz");
    big.dir = dir;
  });
  await step("Listen: 12,160,044-byte 380 s tone arrives as 4 exact 3 MiB chunks and reaches playAudio", async () => {
    await page.getByRole("radio", { name: "VM long tone" }).filter({ visible: true }).click();
    await listenChunked(join(musicDir, big.dir, "audio.wav"), "audio-chunks-tone.json");
  });
  await step("Listen: 67,032,044-byte 380 s 44.1 kHz stereo WAV arrives as 22 exact chunks and reaches playAudio", async () => {
    // playAudio resolves only when playback ends; a reload stops the 380 s tone first.
    await reloadStudio();
    // Guest-only: swap in a Medium-sized WAV (random PCM) under the saved 380 s metadata.
    const bytes = Buffer.alloc(44 + 380 * 44100 * 4);
    bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28);
    bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let at = 44; at < bytes.length; at += 65536) randomFillSync(bytes, at, Math.min(65536, bytes.length - at));
    assert.equal(bytes.length, 67_032_044);
    writeFileSync(join(musicDir, big.dir, "audio.wav"), bytes);
    await page.getByRole("radio", { name: "VM long tone" }).filter({ visible: true }).click();
    await listenChunked(join(musicDir, big.dir, "audio.wav"), "audio-chunks-67mb.json");
    await shot("app-long-audio.png");
    await reloadStudio(); // stop the owned browser playback
  });
  await step("ZIP of 2 selected tracks via the consented LAN route: numbered, byte-exact WAVs (Python zipfile + unzip -t)", async () => {
    const pick = ["VM batch · 2/3", "VM tone take"];
    await page.getByRole("button", { name: "Select tracks" }).filter({ visible: true }).click();
    for (const title of pick) await page.getByRole("checkbox", { name: title }).filter({ visible: true }).click();
    await page.getByText("2 of 20 selected").filter({ visible: true }).waitFor();
    links.length = 0;
    await page.getByRole("button", { name: "Download selected as ZIP (2)" }).filter({ visible: true }).click();
    await page.getByRole("button", { name: /^I trust this network — download via / }).filter({ visible: true }).first().click({ timeout: 30_000 });
    await page.getByRole("link", { name: "Open ZIP download" }).filter({ visible: true }).waitFor({ timeout: 30_000 });
    assert.equal(links.length, 1, "download links seen: " + JSON.stringify(links));
    const { url, expiresAt } = links[0];
    const ttl = Date.parse(expiresAt) - Date.now();
    assert.ok(ttl > 13 * 60_000 && ttl <= 15 * 60_000, "ZIP link expiry " + ttl + " ms");
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get("content-length")), zip.length, "Content-Length");
    const zipPath = join(out, "selected.zip");
    writeFileSync(zipPath, zip);
    const tracks = readdirSync(musicDir).filter((d) => /^[0-9a-f-]{36}$/.test(d)).map((d) => ({ dir: d, ...JSON.parse(readFileSync(join(musicDir, d, "track.json"), "utf8")) }));
    const expected = pick.map((title) => join(musicDir, tracks.find((t) => t.title === title).dir, "audio.wav"));
    const check = execFileSync("python3", ["-I", "-c", `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
infos = z.infolist()
out = [{"name": i.filename, "method": i.compress_type, "size": i.file_size, "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in infos]
want = [hashlib.sha256(open(p, "rb").read()).hexdigest() for p in sys.argv[2:]]
print(json.dumps({"entries": out, "want": want}))
`, zipPath, ...expected], { encoding: "utf8", timeout: 60_000 });
    const result = JSON.parse(check);
    writeFileSync(join(out, "zip-check.json"), JSON.stringify({ url: new URL(url).host, expiresAt, bytes: zip.length, ...result }, null, 2));
    assert.deepEqual(result.entries.map((e) => e.sha), result.want, "ZIP entries differ from the library WAVs");
    assert.ok(result.entries.every((e, i) => e.method === 0 && new RegExp(`^0${i + 1}-[A-Za-z0-9_-]+-[0-9a-f]{8}\\.wav$`).test(e.name)), "names/method: " + JSON.stringify(result.entries));
    const unzip = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8", timeout: 60_000 });
    writeFileSync(join(out, "unzip-t.txt"), unzip);
    assert.match(unzip, /No errors detected/);
    assert.equal(await page.getByRole("alert").count(), 0, "error banner: " + (await page.getByRole("alert").allInnerTexts()).join(" | "));
    await page.getByText("2 of 20 selected").filter({ visible: true }).scrollIntoViewIfNeeded();
    await shot("app-zip.png");
  });
  await step("delete the 2 selected tracks after confirmation; both are recoverable in .trash, others untouched", async () => {
    const before = readdirSync(musicDir).filter((d) => /^[0-9a-f-]{36}$/.test(d));
    const titleOf = (dir) => JSON.parse(readFileSync(join(dir, "track.json"), "utf8")).title;
    const sha = (f) => execFileSync("sha256sum", [f], { encoding: "utf8" }).split(" ")[0];
    const pick = ["VM batch · 2/3", "VM tone take"];
    const wavSha = Object.fromEntries(before.map((d) => [titleOf(join(musicDir, d)), sha(join(musicDir, d, "audio.wav"))]));
    await page.getByRole("button", { name: "Delete selected (2)" }).filter({ visible: true }).click();
    await page.getByText(/^Move 2 tracks to the output folder's \.trash\?/).filter({ visible: true }).waitFor();
    await page.getByRole("button", { name: "Confirm move 2 to trash" }).filter({ visible: true }).click();
    await page.getByText("0 of 20 selected").filter({ visible: true }).waitFor({ timeout: 30_000 });
    for (const title of pick) await page.getByRole("checkbox", { name: title }).filter({ visible: true }).waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await page.getByRole("alert").count(), 0, "error banner: " + (await page.getByRole("alert").allInnerTexts()).join(" | "));
    const after = readdirSync(musicDir).filter((d) => /^[0-9a-f-]{36}$/.test(d)).map((d) => titleOf(join(musicDir, d))).sort();
    assert.deepEqual(after, Object.keys(wavSha).filter((t) => !pick.includes(t)).sort());
    const trash = readdirSync(join(musicDir, ".trash")).map((d) => ({ title: titleOf(join(musicDir, ".trash", d)), sha: sha(join(musicDir, ".trash", d, "audio.wav")) }));
    writeFileSync(join(out, "trash.json"), JSON.stringify({ remaining: after, trash }, null, 2));
    assert.deepEqual(trash.map((t) => t.title).sort(), [...pick].sort());
    for (const t of trash) assert.equal(t.sha, wavSha[t.title], "trashed WAV changed: " + t.title);
  });
  assert.deepEqual(errors, [], "page errors");
} finally {
  await browser.close();
}
console.log("PASS: packaged app Studio flow");
