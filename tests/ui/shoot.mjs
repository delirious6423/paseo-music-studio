// Guest side of tests/ui/run.sh: bundle tests/ui/harness.tsx, serve it on loopback, assert and capture.
// Usage (inside the VM, repository as cwd): node tests/ui/shoot.mjs <runtime dir> <output dir>
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const [runtime, out] = process.argv.slice(2).map((p) => resolve(p));
const repo = createRequire(join(process.cwd(), "package.json"));
const rt = createRequire(join(runtime, "package.json"));
const { build } = repo("esbuild");
const { chromium } = rt("playwright");
await mkdir(out, { recursive: true });

// One React for the plugin, react-dom and react-native-web; the SDK's client entry gets the fixture host.
const pin = {
  name: "pin",
  setup(b) {
    b.onResolve({ filter: /^react(\/.*)?$/ }, (a) => ({ path: repo.resolve(a.path) }));
    b.onResolve({ filter: /^react-dom(\/.*)?$/ }, (a) => ({ path: rt.resolve(a.path) }));
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: rt.resolve("react-native-web") }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: resolve("tests/ui/host-client.ts") }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/ui$/ }, () => ({ path: resolve("tests/ui/host-ui.tsx") }));
  },
};
for (const baseline of [false, true]) await build({
  entryPoints: ["tests/ui/harness.tsx"], outfile: join(out, baseline ? "ui-baseline.js" : "ui.js"), bundle: true, platform: "browser", format: "iife",
  jsx: "automatic", plugins: [pin, ...(baseline ? [{ name: "old-idle-intervals", setup(b) {
    b.onLoad({ filter: /\/client\/studio\.tsx$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      assert.ok(source.includes("? 1000 : 15000") && source.includes("refetchInterval: 30000, retry: false"), "polling baseline needs updating");
      return { contents: source.replace("? 1000 : 15000", "? 1000 : 1000").replace("refetchInterval: 30000, retry: false", "refetchInterval: 3000, retry: false"), loader: "tsx", resolveDir: dirname(path) };
    });
  } }] : [])], logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"', __DEV__: "false", global: "globalThis" },
});
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio component fixture</title><style>html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/ui.js"></script>';
const server = createServer(async (req, res) => {
  const js = req.url?.startsWith("/ui.js") || req.url?.startsWith("/ui-baseline.js");
  res.setHeader("Content-Type", js ? "text/javascript" : "text/html");
  res.end(js ? await readFile(join(out, req.url.startsWith("/ui-baseline.js") ? "ui-baseline.js" : "ui.js"))
    : req.url?.includes("baseline=1") ? html.replace('/ui.js', '/ui-baseline.js') : html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const shots = [
  { file: "studio-desktop.png", theme: "dark", compact: false, viewport: { width: 1280, height: 1000 }, scale: 2 },
  { file: "studio-phone.png", theme: "dark", compact: true, viewport: { width: 390, height: 844 }, scale: 3 },
];
const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const report = [];
try {
  for (const s of shots) {
    const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.scale, isMobile: s.compact, hasTouch: s.compact, locale: "en-US", timezoneId: "UTC", colorScheme: s.theme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${base}?theme=${s.theme}&compact=${s.compact ? 1 : 0}`);
    await page.getByText("Explainer groove A", { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole("radio", { name: "Explainer groove A" }).click();
    await page.getByRole("button", { name: "Download WAV" }).waitFor();
    await page.waitForTimeout(500);
    const text = await page.locator("body").innerText();
    assert.equal(await page.getByRole("alert").count(), 0, "error banner shown: " + text.slice(0, 600));
    assert.deepEqual(errors, []);
    for (const leak of ["/home/", "/mnt/", "/Users/"]) assert.ok(!text.includes(leak), "private text visible: " + leak);
    assert.ok(text.includes("Synthetic VM host"), "host label missing");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal overflow");
    const calls = await page.evaluate(() => [...new Set(globalThis.rpcCalls)].sort());
    // Selecting a take scrolls to the library; capture the top of the screen (title, engine, models).
    await page.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollTop) el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, s.file) });
    report.push({ file: s.file, viewport: s.viewport, scale: s.scale, theme: s.theme, rpcCalls: calls, registered: await page.evaluate(() => globalThis.registered) });
    await context.close();
    console.log("PASS:", s.file, JSON.stringify(s.viewport), "rpc:", calls.join(","));
  }
  for (const s of [{ file: "studio-batch-phone-light.png", theme: "light", compact: true, viewport: { width: 390, height: 844 }, scale: 3 },
    { file: "studio-batch-desktop.png", theme: "dark", compact: false, viewport: { width: 1280, height: 1000 }, scale: 2 }]) {
    const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.scale, isMobile: s.compact, hasTouch: s.compact, locale: "en-US", timezoneId: "UTC", colorScheme: s.theme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.clock.install();
    await page.goto(`${base}?theme=${s.theme}&compact=${s.compact ? 1 : 0}`);
    await page.getByText(/Engine · ready/).waitFor({ timeout: 30_000 });
    const set = (label, value) => page.getByLabel(label, { exact: true }).fill(value);
    const sent = (method) => page.evaluate((m) => globalThis.rpcInputs.filter((c) => c.method === m).map((c) => c.input), method);
    const generateButton = page.getByRole("button", { name: /^Generate (music|\d+ takes)( → \d+ tracks)?$/ });
    const generateCalls = async () => (await sent("music.generate")).length + (await sent("music.generate-batch")).length;
    const rejects = async (fields, pattern) => {
      const before = await generateCalls();
      for (const [label, value] of fields) await set(label, value);
      await generateButton.click();
      await page.getByRole("alert").filter({ hasText: pattern }).waitFor({ timeout: 5_000 });
      assert.ok(!(await page.getByRole("alert").innerText()).includes("NaN"), "invalid variation label");
      assert.equal(await generateCalls(), before, "invalid input was sent");
    };
    const V = "Prompt variations (one per line)", C = "Take count (1–20)";
    assert.equal(await page.getByLabel(V, { exact: true }).inputValue(), "", "variations start empty (placeholder only)");
    await rejects([[C, "0"]], /count: Too small/);
    await rejects([[C, "21"]], /count: Too big/);
    await rejects([[C, "2.5"]], /whole numbers/);
    await rejects([[C, "20"], [V, Array(21).fill("jazz").join("\n")]], /variations: Too big/);
    await rejects([[C, "1"], [V, "a\nb"]], /count: Use at least one take per variation line/);
    await rejects([[C, "2"], ["Music direction", "x".repeat(19995)], [V, "123456"]], /Variation line 1: Base direction plus variation must fit within 20000 characters/);
    assert.equal(await page.getByLabel(V, { exact: true }).getAttribute("maxlength"), String(20 * 20001));

    // Per-model duration caps: Medium 380 s, Small 120 s (the fixture engine reports the loaded model).
    const ready = (model) => page.evaluate((m) => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, phase: "ready", model: m, backend: ["medium", "small-music", "small-sfx"].includes(m) ? "sa3" : "command", message: "Ready · synthetic fixture engine" }; }, model);
    const accepts = async (label, seconds) => {
      await set(label, String(seconds));
      await page.getByRole("button", { name: "Generate music" }).click();
      await page.getByRole("button", { name: "Abort generation" }).waitFor();
      assert.equal((await sent("music.generate")).at(-1).duration, seconds);
    };
    await set(C, "1"); await set(V, ""); await set("Music direction", "Base groove");
    await rejects([["Seconds (1–380)", "381"]], /duration: Too big: expected number to be <=380/);
    await accepts("Seconds (1–380)", 380);
    await ready("small-music");
    await page.getByLabel("Seconds (1–120)", { exact: true }).waitFor();
    await rejects([["Seconds (1–120)", "121"]], /This model supports at most 120 seconds per take/);
    await accepts("Seconds (1–120)", 120);
    await ready("medium");
    await set("Seconds (1–380)", "30");
    assert.equal((await sent("music.generate")).length, 2);

    // Count 1 without variations keeps the original single-take RPC and label.
    await set(C, "1"); await set(V, ""); await set("Music direction", "Base groove"); await set("Track title", "Night set");
    await page.getByRole("button", { name: "Generate music" }).click();
    await page.getByRole("button", { name: "Abort generation" }).waitFor();
    assert.deepEqual((await sent("music.generate")).slice(2), [{ title: "Night set", prompt: "Base groove", duration: 30, steps: 8, seed: -1 }]);
    await ready("medium");
    await page.getByText(/Engine · ready/).waitFor();

    // Catalog profile bounds (example-cli: up to 360 s, at least 2 steps, recommends 30) are labelled and checked
    // before any RPC; there is no Studio step ceiling.
    await ready("example-cli");
    await page.getByText("Recommended steps for this model: 30.").waitFor();
    await rejects([["Seconds (1–360)", "361"]], /This model supports at most 360 seconds per take/);
    await rejects([["Seconds (1–360)", "360"], ["Steps (minimum 2)", "1"]], /This model needs at least 2 steps per take/);
    for (const steps of [2, 33, 100]) {
      await set("Steps (minimum 2)", String(steps));
      await page.getByRole("button", { name: "Generate music" }).click();
      await page.getByRole("button", { name: "Abort generation" }).waitFor();
      assert.deepEqual((await sent("music.generate")).at(-1), { title: "Night set", prompt: "Base groove", duration: 360, steps, seed: -1 });
      await ready("example-cli");
    }
    await ready("medium");
    await page.getByText(/Recommended steps for this model/).waitFor({ state: "detached" });
    await set("Steps (minimum 1)", "8"); await set("Seconds (1–380)", "30");

    // MiniMax controls appear only for controls: "minimax": engine defaults, integer-only fields, decimal seconds,
    // uint32 seeds and a native LM × noise batch, all in one generate payload.
    const engineStatus = (patch) => page.evaluate((p) => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, ...p }; }, patch);
    const shot = (name) => page.screenshot({ path: join(out, s.file.replace("batch", name)) });
    await ready("minimax-q8");
    await page.getByRole("radio", { name: /MiniMax Music 3/, checked: true }).waitFor();
    await page.getByRole("radio", { name: "Instrumental", checked: true }).waitFor();
    await page.getByText("This model accepts up to 360 seconds. That is an upper budget", { exact: false }).waitFor();
    await page.getByText("Each engine run has a 1h 0m budget from its profile.", { exact: false }).waitFor();
    await set("Steps (minimum 2)", "30"); await set("Seconds (1–360)", "12.5");
    await page.getByRole("radio", { name: "Sung lyrics" }).click();
    await set("Lyrics", "[verse]\nla la");
    await page.getByRole("button", { name: "Show advanced MiniMax controls" }).click();
    await rejects([["LM top-k", "2.5"]], /LM top-k must be a whole number/);
    // Errors render under the button that caused them, not only at the top of the page.
    const [alertBox, buttonBox] = [await page.getByRole("alert").boundingBox(), await generateButton.boundingBox()];
    assert.ok(alertBox.y > buttonBox.y, "generate error is not next to Generate");
    await page.getByRole("alert").scrollIntoViewIfNeeded(); await shot("minimax-error");
    await rejects([["LM top-k", "50"], ["Noise renders per song (1–9)", "10"]], /Noise renders per song \(1–9\): Too big/);
    await set("Noise renders per song (1–9)", "3");
    await page.getByRole("alert").waitFor({ state: "hidden" }); // Correcting the form clears its stale Generate error.
    await set("LM songs per run", "2"); await set("LM seed (−1 = random)", "4294967295");
    await page.getByRole("radio", { name: "Format wav24" }).click();
    // The native workload is visible next to Generate, with its all-or-nothing run budget.
    await page.getByText("1 run × 2 songs × 3 renders = 6 tracks. Each run writes nothing until all of its 6 outputs finish", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Generate music → 6 tracks" }).scrollIntoViewIfNeeded(); await shot("minimax-advanced");
    await page.getByRole("button", { name: "Generate music → 6 tracks" }).click();
    await page.getByRole("button", { name: "Abort generation" }).waitFor();
    assert.deepEqual((await sent("music.generate")).at(-1), { title: "Night set", prompt: "Base groove", duration: 12.5, steps: 30, seed: -1,
      minimax: { lyrics: "[verse]\nla la", lmSeed: 4294967295, lmCfg: 1.5, ditCfg: 1.7, topK: 50, peakClip: 10, format: "wav24", mp3Bitrate: 128, lmBatch: 2, synthBatch: 3 } });
    // Command progress is the engine's reported stage plus elapsed/budget, never a fabricated percentage.
    await page.getByText(/^Working · engine has not reported progress$/).waitFor();
    await engineStatus({ progress: 0, activity: "Diffusion · song 1/2 · 3/5 windows completed", elapsedSeconds: 75, timeoutSeconds: 3600 });
    const stage = page.getByText(/^Diffusion · song 1\/2 · 3\/5 windows completed · 1:15 elapsed of 1h 0m run budget$/);
    await stage.waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("0% ·"), "command run shows a percentage");
    await stage.scrollIntoViewIfNeeded(); await shot("minimax-running");
    await engineStatus({ activity: undefined, elapsedSeconds: undefined, timeoutSeconds: undefined });
    await page.getByRole("button", { name: "Hide advanced MiniMax controls" }).click();
    // "Use settings and song codes" fills every control from the saved take and never starts a job; replay mode
    // is announced next to Generate even with Advanced collapsed.
    await page.evaluate(() => { globalThis.fixtureExtra.tracks = [{ ...globalThis.fixtureTracks[0], id: "b0000000-0000-4000-8000-000000000001", title: "MiniMax take", model: "minimax-q8", backend: "command", duration: 60, audioSeconds: 57.3, steps: 40, seed: 4000000000, mimeType: "audio/mpeg", replayAvailable: true,
      minimax: { lyrics: "[instrumental]", lmSeed: 7, lmCfg: 2, ditCfg: 1.2, topK: 40, peakClip: 5, format: "mp3", mp3Bitrate: 192, lmBatch: 1, synthBatch: 1 } }]; });
    // Another active model blocks loading the recipe (no automatic stop).
    await ready("medium");
    await page.getByRole("radio", { name: /MiniMax take/ }).click();
    await page.getByText("57.3s · requested 60s", { exact: false }).first().waitFor();
    await page.getByText("requested 30s", { exact: false }).first().waitFor();
    await page.getByText("Stop medium first to load its settings; nothing is stopped automatically.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Use settings and song codes" }).getAttribute("aria-disabled"), "true");
    await ready("minimax-q8");
    const before = await generateCalls();
    await page.getByRole("button", { name: "Use settings and song codes" }).click();
    await page.getByText("Replay mode · song codes loaded (1 KB)").waitFor();
    assert.equal(await page.getByLabel("Seconds (1–360)", { exact: true }).inputValue(), "60", "replay must keep the requested seconds");
    assert.equal(await generateCalls(), before, "replay started a generation");
    await page.getByRole("button", { name: "Show advanced MiniMax controls" }).click();
    await set("LM songs per run", "2");
    const replayButton = page.getByRole("button", { name: /^Replay saved song/ });
    await replayButton.click();
    await page.getByRole("alert").filter({ hasText: "LM songs per run: Song-code replay requires exactly one LM song" }).waitFor();
    assert.equal(await generateCalls(), before, "invalid replay was sent");
    await set("LM songs per run", "1");
    await replayButton.click();
    await page.getByRole("button", { name: "Abort generation" }).waitFor();
    assert.deepEqual((await sent("music.generate")).at(-1), { title: "MiniMax take", prompt: (await page.evaluate(() => globalThis.fixtureTracks[0].prompt)), duration: 60, steps: 40, seed: 4000000000,
      minimax: { lyrics: "[instrumental]", lmSeed: 7, lmCfg: 2, ditCfg: 1.2, topK: 40, peakClip: 5, format: "mp3", mp3Bitrate: 192, lmBatch: 1, synthBatch: 1, audioCodes: "1,2,3" } });
    await ready("minimax-q8");
    await page.getByRole("button", { name: "Clear song codes (create a new song)" }).click();
    await page.getByRole("button", { name: "Generate music" }).waitFor();
    // A recipe whose model is missing is refused explicitly, never loaded onto another model.
    await page.evaluate(() => { globalThis.fixtureExtra.tracks[0] = { ...globalThis.fixtureExtra.tracks[0], model: "retired-model", modelLabel: "Retired model" }; });
    await engineStatus({ phase: "stopped", model: null, backend: null });
    // The phase change refreshes the library, so the row reflects the retired model before the press.
    await page.getByText(/Engine · stopped/).waitFor();
    await page.getByText(/Retired model/).first().waitFor();
    await page.getByRole("radio", { name: /MiniMax take/ }).click();
    await page.getByRole("button", { name: "Use settings and song codes" }).click();
    await page.getByRole("alert").filter({ hasText: "Retired model is not available on this host; settings were not loaded" }).waitFor();
    // Choosing a model (while stopped) resets steps to its suggestion or Studio's 8 and clamps seconds; the
    // checked state and the border agree.
    await page.getByRole("radio", { name: /Example music CLI/ }).click();
    assert.equal(await page.getByLabel("Steps (minimum 2)", { exact: true }).inputValue(), "30");
    await page.getByRole("radio", { name: /Stable Audio 3 Medium/ }).click();
    assert.equal(await page.getByLabel("Steps (minimum 1)", { exact: true }).inputValue(), "8");
    await page.getByRole("radio", { name: /Stable Audio 3 Medium/, checked: true }).waitFor({ timeout: 5_000 });
    await page.evaluate(() => { globalThis.fixtureExtra.tracks = []; });
    await ready("medium");
    await page.getByRole("button", { name: /advanced MiniMax/ }).waitFor({ state: "detached" });
    await set("Track title", "Night set"); await set("Music direction", "Base groove"); await set("Steps (minimum 1)", "8"); await set("Seconds (1–380)", "30");

    await set(C, "3"); await set("Seed (−1 = random)", "41"); await set(V, "  brushed drums \n\nbig-band brass\n");
    await page.getByText("2 variation lines cycle across 3 takes; each is appended to the music direction on a new line.").waitFor();
    await page.getByRole("button", { name: "Generate 3 takes" }).click();
    await page.getByText("Batch · 0/3 saved · take 1/3 · running").waitFor();
    const [input] = await sent("music.generate-batch");
    assert.deepEqual(input, { title: "Night set", prompt: "Base groove", duration: 30, steps: 8, seed: 41, count: 3, variations: ["brushed drums", "big-band brass"] });
    const takes = await page.evaluate((i) => globalThis.batchTakes(i, i.seed), input);
    assert.deepEqual(takes.map((t) => [t.title, t.prompt, t.seed]), [
      ["Night set · 1/3", "Base groove\nbrushed drums", 41], ["Night set · 2/3", "Base groove\nbig-band brass", 42], ["Night set · 3/3", "Base groove\nbrushed drums", 43]]);
    // No second submission while the batch runs.
    const generate3 = page.getByRole("button", { name: "Generate 3 takes" });
    assert.equal(await generate3.getAttribute("aria-disabled"), "true");
    await generate3.click({ force: true }); await page.waitForTimeout(300);
    assert.equal((await sent("music.generate-batch")).length, 1, "duplicate batch submission");
    await page.evaluate(() => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, progress: 40, batch: { total: 3, current: 2, completed: 1, state: "running" } }; });
    await page.getByText("Batch · 1/3 saved · take 2/3 · running").waitFor();
    await page.getByText(/^Take 2\/3 · 40% · Generating…$/).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal overflow");
    await page.getByText("Batch · 1/3 saved · take 2/3 · running").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, s.file) });
    await page.getByRole("button", { name: "Cancel batch" }).click();
    await page.getByText("Batch · 1/3 saved · take 2/3 · cancelled").waitFor();
    assert.equal(await page.getByRole("button", { name: "Abort generation" }).getAttribute("aria-disabled"), "true");
    assert.equal((await sent("music.abort")).length, 1);
    // Selected-track prompts start collapsed, below every action, and reset on a new selection.
    await page.getByRole("radio", { name: "Brass hits for the outro" }).click();
    const promptText = "Short punchy big-band brass stabs, 124 BPM, confident, no vocals.";
    const showPrompt = page.getByRole("button", { name: "Show music-generation prompt" });
    assert.equal(await page.getByText(promptText, { exact: true }).count(), 0);
    assert.equal(await showPrompt.getAttribute("aria-expanded"), "false");
    const promptTop = await showPrompt.evaluate((el) => el.getBoundingClientRect().top);
    for (const name of ["Listen to selected track", "Delete selected track", "Download WAV"]) {
      assert.ok(await page.getByRole("button", { name, exact: true }).evaluate((el) => el.getBoundingClientRect().top) < promptTop, name + " must be above the prompt");
    }
    await showPrompt.click();
    await page.getByText(promptText, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Hide music-generation prompt" }).getAttribute("aria-expanded"), "true");
    await page.getByRole("button", { name: "Hide music-generation prompt" }).click();
    assert.equal(await page.getByText(promptText, { exact: true }).count(), 0);
    await showPrompt.click();
    await page.getByRole("radio", { name: "Walking bass bed" }).click();
    assert.equal(await showPrompt.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByText("Upright walking bass and brushed drums, 110 BPM, warm, sparse piano comping.", { exact: true }).count(), 0);
    assert.equal(await page.getByText(promptText, { exact: true }).count(), 0);
    // Chunked playback: 67,032,044 B arrive as 22 × 3 MiB RPCs and reach playAudio joined unchanged.
    const listen = page.getByRole("button", { name: "Listen to selected track" });
    const chunkOffsets = async () => (await sent("music.audio-chunk")).map((c) => c.offset);
    await page.getByRole("radio", { name: "Full-length session" }).click();
    await listen.click();
    await page.waitForFunction(() => globalThis.played.length === 1, null, { timeout: 60_000 });
    const MiB3 = 3 * 1024 * 1024, total = 67_032_044;
    assert.deepEqual(await chunkOffsets(), Array.from({ length: 22 }, (_, i) => i * MiB3));
    const assembled = await page.evaluate(({ MiB3, total }) => {
      const b = globalThis.played[0].base64, bad = [];
      const check = (offset, text) => [...text].forEach((ch, j) => { if (ch.charCodeAt(0) !== globalThis.wavByte(offset + j)) bad.push(offset + j); });
      for (const k of [0, 1, 2, 10, 21]) { const at = k * MiB3; check(at - (k ? 6 : 0), atob(b.slice((at / 3) * 4 - (k ? 8 : 0), (at / 3) * 4 + 16))); }
      const tail = atob(b.slice(-16)); check(total - tail.length, tail);
      return { length: b.length, mimeType: globalThis.played[0].mimeType, bad: bad.slice(0, 5) };
    }, { MiB3, total });
    assert.deepEqual(assembled, { length: Math.ceil(total / 3) * 4, mimeType: "audio/wav", bad: [] });
    await listen.waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);

    // Cancel loading and changing selection stop further chunk requests and never reach playAudio.
    await page.evaluate(() => { globalThis.fixtureAudio.delayMs = 2000; globalThis.played.length = 0; });
    for (const stop of ["cancel", "select"]) {
      await listen.click();
      await page.getByRole("button", { name: /^Loading audio… \d+%$/ }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal overflow while loading");
      if (stop === "cancel") await page.getByRole("button", { name: "Cancel loading" }).click();
      else await page.getByRole("radio", { name: "Explainer groove A" }).click();
      // The UI resets at once, without waiting for the in-flight chunk (2 s) to return.
      await listen.waitFor({ timeout: 500 });
      const after = (await chunkOffsets()).length;
      await page.waitForTimeout(2_500);
      assert.equal((await chunkOffsets()).length, after, stop + ": chunk requests continued");
      assert.equal(await page.evaluate(() => globalThis.played.length), 0, stop + ": stale audio played");
      assert.equal(await page.getByRole("alert").count(), 0, stop + ": error shown");
      await listen.waitFor();
      await page.getByRole("radio", { name: "Full-length session" }).click();
    }
    // Entering multi-select cancels the loading track rather than hiding its Cancel control.
    await listen.click();
    await page.getByRole("button", { name: /^Loading audio… \d+%$/ }).waitFor();
    await page.getByRole("button", { name: "Select tracks" }).click();
    const afterPick = (await chunkOffsets()).length;
    await page.waitForTimeout(2_500);
    assert.equal((await chunkOffsets()).length, afterPick, "select mode: chunk requests continued");
    assert.equal(await page.evaluate(() => globalThis.played.length), 0, "select mode: hidden audio played");
    await page.getByRole("button", { name: "Done selecting" }).click();
    await page.getByRole("radio", { name: "Full-length session" }).click();
    // A file replaced mid-transfer (new version) is rejected, not stitched.
    await listen.click();
    await page.getByRole("button", { name: /^Loading audio… \d+%$/ }).waitFor();
    await page.evaluate(() => { globalThis.fixtureAudio.version = "b".repeat(64); });
    await page.getByRole("alert").filter({ hasText: "Invalid audio chunk; select the track and try again" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => globalThis.played.length), 0, "replaced file played");

    // Playback modes: quick single transfer only for ≤100 s takes whose WAV fits 17 MiB; otherwise 3 MiB chunks.
    await page.evaluate(() => { globalThis.fixtureAudio.delayMs = 0; });
    for (const [title, total, mode] of [["Edge 100 s", 100 * 176400 + 44, "quick"], ["Edge 101 s", 101 * 176400 + 44, "full"], ["Hi-res 90 s", 90 * 288000 + 44, "full"], ["Explainer groove A", 5292044, "quick"]]) {
      await page.getByRole("radio", { name: title }).click();
      await page.getByText(mode === "quick" ? /^Quick playback: up to 100 s and 17 MiB, sent in one transfer\. Both load before playback; this is not live streaming\./ : /^Full-track loading: fetches the audio in 3 MiB pieces, then plays after the last piece arrives\. Both load before playback; this is not live streaming\./).waitFor();
      const before = { inline: (await sent("music.audio")).length, chunks: (await chunkOffsets()).length, played: await page.evaluate(() => globalThis.played.length) };
      await listen.click();
      await page.waitForFunction((n) => globalThis.played.length === n + 1, before.played, { timeout: 30_000 });
      const inline = (await sent("music.audio")).length - before.inline, chunks = (await chunkOffsets()).length - before.chunks;
      // Hi-res: inline is offered (≤100 s) but audio-info reports >17 MiB, so the helper fetches chunks instead.
      assert.deepEqual({ title, inline, chunks }, { title, inline: mode === "quick" ? 1 : 0, chunks: mode === "quick" ? 0 : Math.ceil(total / (3 * 1024 * 1024)) });
      const b64 = await page.evaluate(() => globalThis.played.at(-1).base64.length);
      assert.equal(b64, Math.ceil(total / 3) * 4, title + " assembled length");
      assert.equal(await page.getByRole("alert").count(), 0, title + ": error shown");
      await listen.waitFor();
    }
    // ZIP multi-select: separate checkbox mode, consent before any link, ≤20, pruned on delete, radios untouched.
    const zipButton = (n) => page.getByRole("button", { name: `Download selected as ZIP (${n})` });
    const noOverflow = async (when) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal overflow: " + when);
    await page.getByRole("button", { name: "Select tracks" }).click();
    assert.equal(await page.getByRole("radio", { name: "Explainer groove A" }).count(), 0, "radio rows still shown in ZIP mode");
    assert.equal(await zipButton(0).getAttribute("aria-disabled"), "true");
    const ids = await page.evaluate(() => Object.fromEntries(globalThis.fixtureTracks.map((t) => [t.title, t.id])));
    await page.getByRole("checkbox", { name: "Edge 100 s" }).click();
    await page.getByRole("checkbox", { name: "Explainer groove A" }).click();
    await page.getByText("2 of 20 selected").waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Edge 100 s" }).getAttribute("aria-checked"), "true");
    await zipButton(2).click();
    await page.getByText(/Links expire after 15 minutes .* The ZIP holds the original audio files, numbered, uncompressed and not re-encoded/).waitFor();
    assert.equal((await sent("music.download-batch")).length, 0, "ZIP link created before consent");
    await noOverflow("ZIP setup");
    await page.getByRole("button", { name: "I trust this network — download via 192.0.2.10" }).click();
    await page.getByRole("link", { name: "Open ZIP download" }).waitFor();
    assert.deepEqual(await sent("music.download-batch"), [{ ids: [ids["Edge 100 s"], ids["Explainer groove A"]], target: { kind: "lan", address: "192.0.2.10", interface: "eth0", cidr: "192.0.2.0/24" }, acknowledged: true }]);
    assert.equal((await sent("music.download")).length, 0, "single download called");
    await page.getByText(/fetch these tracks until expiry/).waitFor();
    await page.getByText("2 of 20 selected").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, s.file.replace("batch", "zip")) });
    // Changing the selection while a link is prepared discards that link (never shown/opened for the old set).
    await page.evaluate(() => { globalThis.fixtureAudio.delayMs = 1000; });
    await zipButton(2).click();
    await page.getByRole("button", { name: "I trust this network — download via 192.0.2.10" }).click();
    await page.getByRole("button", { name: "Preparing download…" }).waitFor();
    await page.getByRole("checkbox", { name: "Edge 101 s" }).click();
    await page.waitForTimeout(1_500);
    assert.equal((await sent("music.download-batch")).length, 2);
    assert.equal(await page.getByRole("link", { name: "Open ZIP download" }).count(), 0, "stale ZIP link shown");
    await page.getByText("3 of 20 selected").waitFor();
    await page.evaluate(() => { globalThis.fixtureAudio.delayMs = 0; });

    // Advance the real production intervals virtually; other-client edits must arrive within the 30 s fallback.
    // More than 20 tracks: Select all takes the newest 20, the rest cannot be ticked; deleted tracks drop out.
    await page.evaluate(() => {
      const base = globalThis.fixtureTracks[0];
      globalThis.fixtureExtra.tracks = Array.from({ length: 22 }, (_, i) => ({ ...base, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Extra take ${i + 1}` }));
    });
    await page.clock.runFor(31_000);
    await page.getByText("Music library · 29").waitFor({ timeout: 5_000 });
    await page.getByRole("button", { name: "Select all (up to 20)" }).click();
    await page.getByText("20 of 20 selected").waitFor();
    assert.equal(await page.locator('[role=checkbox][aria-disabled="true"]').count(), 9, "unselected tracks beyond 20 should be disabled");
    await page.getByRole("checkbox", { name: "Extra take 22" }).click({ force: true });
    await page.getByText("20 of 20 selected").waitFor();
    assert.notEqual(await zipButton(20).getAttribute("aria-disabled"), "true");
    await page.evaluate(() => { globalThis.fixtureExtra.tracks = globalThis.fixtureExtra.tracks.slice(2); });
    await page.clock.runFor(31_000);
    await page.getByText("18 of 20 selected").waitFor({ timeout: 5_000 });
    await noOverflow("20 selected");
    await page.getByRole("button", { name: "Clear selection" }).click();
    assert.equal(await zipButton(0).getAttribute("aria-disabled"), "true");
    // Batch delete: explicit confirmation of a snapshot; Keep, selection change and partial failure.
    const del = (n) => page.getByRole("button", { name: `Delete selected (${n})` });
    assert.equal(await del(0).getAttribute("aria-disabled"), "true");
    const extraIds = await page.evaluate(() => Object.fromEntries(globalThis.fixtureExtra.tracks.map((t) => [t.title, t.id])));
    for (const n of [3, 4, 5]) await page.getByRole("checkbox", { name: `Extra take ${n}` }).click();
    await page.evaluate((id) => { globalThis.fixtureRemoval.fail = [id]; }, extraIds["Extra take 5"]);
    await del(3).click();
    await page.getByText("Move 3 tracks to the output folder's .trash? They stay recoverable there; nothing is permanently deleted. Wait for active downloads to finish; deleting revokes their links.").waitFor();
    await noOverflow("delete confirmation");
    await page.getByRole("button", { name: "Keep tracks" }).click();
    await del(3).click();
    await page.getByRole("checkbox", { name: "Extra take 6" }).click();
    assert.equal(await page.getByRole("button", { name: /^Confirm move/ }).count(), 0, "confirmation survived a selection change");
    await page.getByRole("checkbox", { name: "Extra take 6" }).click();
    assert.equal(await page.getByRole("button", { name: /^Confirm move/ }).count(), 0, "stale confirmation returned with the same selection");
    assert.equal((await sent("music.remove-batch")).length, 0, "deleted without confirmation");
    await del(3).click();
    await page.getByRole("button", { name: "Confirm move 3 to trash" }).click();
    await page.getByRole("alert").filter({ hasText: "2 moved to trash; 1 not moved and still selected: Extra take 5: Unsafe track directory" }).waitFor();
    assert.deepEqual(await sent("music.remove-batch"), [{ ids: [extraIds["Extra take 3"], extraIds["Extra take 4"], extraIds["Extra take 5"]] }]);
    await page.getByText("1 of 20 selected").waitFor();
    await page.getByText("Music library · 25").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("checkbox", { name: "Extra take 5" }).getAttribute("aria-checked"), "true");
    await page.getByRole("button", { name: "Clear selection" }).click();
    // Leaving ZIP mode restores the unchanged single-track flow.
    await page.getByRole("button", { name: "Done selecting" }).click();
    await page.getByRole("radio", { name: "Explainer groove A" }).click();
    await page.getByRole("button", { name: "Download WAV" }).waitFor();
    assert.notEqual(await listen.getAttribute("aria-disabled"), "true");
    // The intentional partial-delete error stays until the next action; nothing else may be shown.
    assert.deepEqual(await page.getByRole("alert").allInnerTexts(), ["2 moved to trash; 1 not moved and still selected: Extra take 5: Unsafe track directory"]);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "horizontal overflow");
    assert.deepEqual(errors, []);
    report.push({ file: s.file, viewport: s.viewport, theme: s.theme, batchInput: input, takes });
    await context.close();
    console.log("PASS: batch flow", s.theme, JSON.stringify(s.viewport));
  }
  // Exercise the native auto-open branch through the fixture boundary, never a real external browser.
  for (const s of [{ theme: "light", compact: true, viewport: { width: 390, height: 844 } },
    { theme: "dark", compact: false, viewport: { width: 1280, height: 1000 } }]) {
    const context = await browser.newContext({ viewport: s.viewport, locale: "en-US" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const openSelection = async () => {
      await page.goto(`${base}?theme=${s.theme}&compact=${s.compact ? 1 : 0}&platform=ios`);
      await page.getByRole("button", { name: "Select tracks" }).click();
      await page.getByRole("checkbox", { name: "Explainer groove A" }).click();
      await page.getByRole("button", { name: "Download selected as ZIP (1)" }).click();
      await page.getByText(/30 seconds without transfer can interrupt it after preparation/).waitFor();
    };
    for (const abandon of ["done", "screen", "selection-round-trip", "failed-after-done"]) {
      await openSelection();
      await page.evaluate(() => { globalThis.fixtureDownload.hold = true; });
      await page.getByRole("button", { name: "I trust this network — download via 192.0.2.10" }).click();
      await page.waitForFunction(() => globalThis.fixtureDownload.release.length === 1);
      if (abandon === "screen") {
        await page.evaluate(() => globalThis.fixtureUnmount());
        await page.waitForFunction(() => !document.getElementById("root").childElementCount);
      } else if (abandon === "selection-round-trip") {
        await page.getByRole("checkbox", { name: "Brass hits for the outro" }).click();
        await page.getByRole("checkbox", { name: "Brass hits for the outro" }).click();
      } else {
        await page.getByRole("button", { name: "Done selecting" }).click();
        await page.getByRole("button", { name: "Select tracks" }).click();
        await page.getByText("1 of 20 selected").waitFor(); // Remount with exactly the same selection key.
      }
      await page.evaluate((fail) => {
        globalThis.fixtureDownload.fail = fail;
        globalThis.fixtureDownload.release.splice(0).forEach((release) => release());
      }, abandon === "failed-after-done");
      await page.waitForFunction(() => globalThis.fixtureDownload.completed === 1);
      await page.waitForTimeout(100); // Flush the mutation's post-RPC callbacks, not merely the fixture response.
      assert.deepEqual(await page.evaluate(() => globalThis.openedUrls), [], abandon + ": stale native browser open");
      assert.equal(await page.getByRole("link", { name: "Open ZIP download" }).count(), 0, abandon + ": stale link shown");
      assert.equal(await page.getByRole("alert").count(), 0, abandon + ": stale error shown");
    }
    await openSelection();
    await page.getByRole("button", { name: "I trust this network — download via 192.0.2.10" }).click();
    await page.waitForFunction(() => globalThis.openedUrls.length === 1);
    assert.deepEqual(await page.evaluate(() => globalThis.openedUrls), ["http://192.0.2.10:8765/fixture/tracks.zip"], "live native request must still open");
    assert.deepEqual(errors, []);
    report.push({ kind: "download-lifetime", theme: s.theme, cases: ["done", "screen", "selection-round-trip", "failed-after-done", "live-native-open"] });
    await context.close();
    console.log("PASS: native-branch download lifetime", s.theme);
  }

  // Same fixed idle workload, actual RPC counts/JSON bytes; baseline changes only the old polling intervals.
  // Virtual time runs production timers without spending two real minutes waiting. This is not a latency benchmark.
  const polling = {};
  for (const baseline of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.clock.install();
    await page.goto(`${base}?workload=polling&baseline=${baseline ? 1 : 0}`);
    await page.getByText("Music library · 200").waitFor();
    await page.getByText(/Engine · ready/).waitFor();
    await page.waitForTimeout(100);
    await page.evaluate(() => { globalThis.fixtureTraffic.length = 0; });
    await page.clock.runFor(60_000);
    polling[baseline ? "baseline" : "current"] = await page.evaluate(() => Object.fromEntries(["music.status", "music.tracks"].map((method) => {
      const calls = globalThis.fixtureTraffic.filter((call) => call.method === method);
      return [method, { calls: calls.length, bytes: calls.reduce((sum, call) => sum + call.bytes, 0) }];
    })));
    if (!baseline) {
      const addTrack = (title) => page.evaluate((title) => {
        globalThis.fixtureExtra.tracks.push({ ...globalThis.fixtureTracks[0], id: `10000000-0000-4000-8000-${String(globalThis.fixtureExtra.tracks.length).padStart(12, "0")}`, title });
      }, title);
      // A different client's short job/deletion can leave engine status unchanged: the slow fallback must see both.
      await addTrack("Other-client take");
      await page.clock.runFor(31_000);
      await page.getByText("Music library · 201").waitFor({ timeout: 2_000 });
      await page.evaluate(() => { globalThis.fixtureExtra.tracks.pop(); });
      await page.clock.runFor(31_000);
      await page.getByText("Music library · 200").waitFor({ timeout: 2_000 });
      // Discover a remote active batch via the 15 s status fallback, then poll at 1 s, refreshing each saved take.
      await page.evaluate(() => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, phase: "generating", batch: { total: 2, current: 1, completed: 0, state: "running" } }; });
      await page.clock.runFor(15_100);
      await page.getByText("Batch · 0/2 saved · take 1/2 · running").waitFor();
      await page.evaluate(() => { globalThis.fixtureTraffic.length = 0; });
      await page.clock.runFor(3_100);
      assert.ok(await page.evaluate(() => globalThis.fixtureTraffic.filter((c) => c.method === "music.status").length) >= 3, "active status stopped polling at 1 s");
      await addTrack("Batch take one");
      await page.evaluate(() => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, batch: { total: 2, current: 2, completed: 1, state: "running" } }; });
      await page.clock.runFor(1_100);
      await page.getByText("Music library · 201").waitFor({ timeout: 2_000 });
      await addTrack("Batch take two");
      await page.evaluate(() => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, phase: "ready", batch: { total: 2, current: 2, completed: 2, state: "completed" } }; });
      await page.clock.runFor(1_100);
      await page.getByText("Music library · 202").waitFor({ timeout: 2_000 });
      // Retry save must invalidate immediately, rather than waiting for either idle interval.
      await page.evaluate(() => { globalThis.fixtureEngine.status = { ...globalThis.fixtureEngine.status, pendingSave: true, batch: null }; });
      await page.clock.runFor(15_100);
      await page.getByRole("button", { name: "Retry save" }).waitFor();
      await addTrack("Recovered take");
      await page.getByRole("button", { name: "Retry save" }).click();
      await page.getByText("Music library · 203").waitFor({ timeout: 2_000 });
      await page.waitForFunction(() => !document.body.innerText.includes("A completed take could not be saved"));
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.ok(polling.baseline["music.status"].calls >= 59 && polling.baseline["music.tracks"].calls >= 19, "old-interval baseline did not poll");
  assert.ok(polling.current["music.status"].calls <= 5 && polling.current["music.tracks"].calls <= 3, "idle polling still too frequent");
  report.push({ kind: "idle-polling", seconds: 60, workload: { tracks: 200, promptCharacters: 600, logCharacters: 12000 }, targetReduction: 100, ...polling });
  console.log("PASS: idle RPC counts/JSON bytes", JSON.stringify(polling), "; active/remote/recovery refresh checks passed");
} finally {
  await browser.close();
  server.close();
}
await writeFile(join(out, "report.json"), JSON.stringify({ kind: "component-fixture", browser: "chromium-headless-shell " + browserVersion, report }, null, 2));
