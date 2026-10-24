import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { TrackDownload } from "./downloads";
import { assembleAudio } from "./audio";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as api from "../shared/music";

type PlayAudio = (source: { base64: string; mimeType: string }) => Promise<void>;
const defaultPrompt = "Instrumental modern jazz-funk, 118 BPM, punchy jazz drums, funky bass, rhythmic Rhodes piano, occasional brass accents. Sophisticated, playful and confident. Strong groove from the first beat, no intro, no fade-in, no singing or vocals.";

type MinimaxText = { instrumental: string; lyrics: string; lmSeed: string; lmCfg: string; ditCfg: string; topK: string; peakClip: string; format: string; mp3Bitrate: string; lmBatch: string; synthBatch: string; audioCodes: string };
const mmFields: { key: keyof MinimaxText; label: string; integer: boolean }[] = [
  { key: "lmSeed", label: "LM seed (−1 = random)", integer: true }, { key: "lmCfg", label: "LM CFG", integer: false }, { key: "ditCfg", label: "DiT CFG", integer: false },
  { key: "topK", label: "LM top-k", integer: true }, { key: "peakClip", label: "Peak clip (0–999)", integer: true },
  { key: "lmBatch", label: "LM songs per run", integer: true }, { key: "synthBatch", label: "Noise renders per song (1–9)", integer: true },
];
function minimaxText(o: api.MinimaxOptions): MinimaxText {
  const instrumental = o.lyrics === "[instrumental]";
  return { instrumental: instrumental ? "1" : "0", lyrics: instrumental ? "" : o.lyrics, lmSeed: String(o.lmSeed), lmCfg: String(o.lmCfg), ditCfg: String(o.ditCfg), topK: String(o.topK), peakClip: String(o.peakClip), format: o.format ?? "mp3", mp3Bitrate: String(o.mp3Bitrate), lmBatch: String(o.lmBatch), synthBatch: String(o.synthBatch), audioCodes: o.audioCodes ?? "" };
}
function minimaxInput(m: MinimaxText) {
  for (const f of mmFields) {
    if (f.integer ? !/^-?\d+$/.test(m[f.key].trim()) : !Number.isFinite(Number(m[f.key])) || !m[f.key].trim()) throw new Error(`${f.label} must be ${f.integer ? "a whole number" : "a number"}`);
  }
  if (m.instrumental !== "1" && !m.lyrics.trim()) throw new Error("Enter lyrics, or choose Instrumental");
  const result = api.minimaxOptions.safeParse({ lyrics: m.instrumental === "1" ? "[instrumental]" : m.lyrics, lmSeed: Number(m.lmSeed), lmCfg: Number(m.lmCfg), ditCfg: Number(m.ditCfg), topK: Number(m.topK), peakClip: Number(m.peakClip), format: m.format, mp3Bitrate: Number(m.mp3Bitrate), lmBatch: Number(m.lmBatch), synthBatch: Number(m.synthBatch), ...(m.audioCodes && { audioCodes: m.audioCodes }) });
  if (!result.success) throw new Error(result.error.issues.map((issue) => (mmFields.find((f) => f.key === issue.path[0])?.label ?? issue.path.join(".")) + ": " + issue.message).join("; "));
  return result.data;
}

const clock = (seconds: number) => { const s = Math.max(0, Math.floor(seconds)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const secs = (n: number) => `${Math.round(n * 10) / 10}s`;
// Actual audio length when measured; legacy tracks only know the requested target.
function lengthLabel(track: api.Track) {
  if (track.audioSeconds === undefined) return `requested ${secs(track.duration)}`;
  return Math.abs(track.audioSeconds - track.duration) >= 0.5 ? `${secs(track.audioSeconds)} · requested ${secs(track.duration)}` : secs(track.audioSeconds);
}
type Scope = "global" | "engine" | "settings" | "recovery" | "generate" | "library";

export function Studio({ theme, layout, host, playAudio }: PluginScreenProps & { playAudio: PlayAudio }) {
  const c = theme.colors;
  const getStatus = useRpc(api.status), getModels = useRpc(api.models), getTracks = useRpc(api.tracks);
  const start = useRpc(api.start), stop = useRpc(api.stop), abort = useRpc(api.abort), generate = useRpc(api.generate), generateBatch = useRpc(api.generateBatch);
  const getReplay = useRpc(api.replay);
  const getAudio = useRpc(api.audio), getAudioInfo = useRpc(api.audioInfo), getAudioChunk = useRpc(api.audioChunk), remove = useRpc(api.remove), removeBatch = useRpc(api.removeBatch), retrySave = useRpc(api.retrySave);
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["music-status"], queryFn: () => getStatus({}),
    refetchInterval: (query) => !query.state.data || ["starting", "generating", "stopping"].includes(query.state.data.phase) ? 1000 : 15000, retry: false });
  const catalog = useQuery({ queryKey: ["music-models"], queryFn: () => getModels({}), refetchInterval: 10000, retry: false });
  // Completion/mutations refresh immediately; the slow fallback also sees other clients' edits and short jobs.
  const library = useQuery({ queryKey: ["music-tracks"], queryFn: () => getTracks({}), refetchInterval: 30000, retry: false });
  const libraryState = JSON.stringify([state.data?.phase, state.data?.pendingSave, state.data?.batch?.completed, state.data?.batch?.state]);
  const previousLibraryState = useRef(libraryState);
  useEffect(() => {
    if (previousLibraryState.current !== libraryState) {
      previousLibraryState.current = libraryState;
      void queryClient.invalidateQueries({ queryKey: ["music-tracks"] });
    }
  }, [libraryState, queryClient]);
  const [model, setModel] = useState<string>("medium");
  const [title, setTitle] = useState("Jazz groove");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [duration, setDuration] = useState("30"), [seed, setSeed] = useState("-1"), [steps, setSteps] = useState("8");
  const [count, setCount] = useState("1"), [variationText, setVariationText] = useState("");
  // MiniMax controls as typed text; parsed by the shared schema on Generate. Defaults are the engine's.
  const [mm, setMm] = useState(() => minimaxText(api.minimaxOptions.parse({}))), [showAdvanced, setShowAdvanced] = useState(false);
  const setMmField = (key: keyof typeof mm) => (value: string) => setMm((m) => ({ ...m, [key]: value }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [picking, setPicking] = useState(false), [picked, setPicked] = useState<string[]>([]);
  const [confirmBatch, setConfirmBatch] = useState<string[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false), [showSettings, setShowSettings] = useState(false);
  // Errors render next to the action that caused them (one alert at a time), not only at the top of the page.
  const [failure, setFailure] = useState<{ scope: Scope; message: string } | null>(null);
  const setError = (message: string, scope: Scope = "global") => setFailure(message ? { scope, message } : null);
  // A corrected recipe must not keep an error about values it no longer contains.
  useEffect(() => { setFailure((f) => f?.scope === "generate" ? null : f); }, [model, title, prompt, duration, seed, steps, count, variationText, mm]);
  const [draft, setDraft] = useState<api.Config | null>(null);
  const [profileText, setProfileText] = useState("[]");
  const [trustCommands, setTrustCommands] = useState(false);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const preferences = useSettings(api.settings);
  const getSetup = useRpc(api.setup);
  const legacy = useQuery({ queryKey: ["music-legacy-setup"], queryFn: () => getSetup({}), enabled: preferences.status === "ready" && !preferences.values.outputsDir, retry: false });
  const phase = state.data?.phase;
  const stopped = phase === "stopped" || phase === "error";
  const selected = library.data?.find((t) => t.id === selectedId);
  // ZIP selection survives refreshes and new takes; deleted tracks drop out.
  const zipIds = picked.filter((id) => library.data?.some((t) => t.id === id));
  const zipMax = 20;
  // The confirmation covers exactly the snapshot taken on "Delete selected"; any later change hides it.
  const confirming = confirmBatch && confirmBatch.join() === zipIds.join() ? confirmBatch : null;
  function pick(ids: string[]) { setPicked(ids); setConfirmBatch(null); }
  function deleteBatch(ids: string[]) {
    run(async () => {
      const result = await removeBatch({ ids });
      setPicked((p) => p.filter((id) => !result.deleted.includes(id))); setConfirmBatch(null);
      if (selectedId && result.deleted.includes(selectedId)) setSelectedId(null);
      if (result.failed.length) {
        const title = (id: string) => library.data?.find((t) => t.id === id)?.title ?? id;
        throw new Error(`${result.deleted.length} moved to trash; ${result.failed.length} not moved and still selected: ` + result.failed.map((f) => `${title(f.id)}: ${f.error}`).join("; "));
      }
    }, "library");
  }
  // Audio arrives in 3 MiB pieces; a new selection, Cancel or leaving the screen stops the transfer before playback.
  const transfer = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  function stopTransfer() { transfer.current?.abort(); transfer.current = null; setLoading(null); }
  // Commit-phase cleanup: a host switch or unmount aborts before any later chunk can resolve and play.
  useLayoutEffect(() => () => transfer.current?.abort(), [host.id]);
  // Quick playback: one transfer for takes up to 100 s whose WAV fits the relay; the host re-checks the real size.
  const quickSeconds = 100;
  const playSeconds = (track: api.Track) => track.audioSeconds ?? track.duration;
  const quick = (track: api.Track) => playSeconds(track) <= quickSeconds && (track.audioBytes ?? 0) <= api.MAX_PLAYBACK_BYTES;
  function listen(track: api.Track) {
    const id = track.id;
    transfer.current?.abort();
    const controller = new AbortController();
    transfer.current = controller; setError(""); setLoading(0);
    const current = () => transfer.current === controller;
    void assembleAudio(id, getAudioInfo, getAudioChunk, controller.signal, (percent) => { if (current()) setLoading(percent); }, playSeconds(track) <= quickSeconds ? getAudio : undefined)
      .then((audio) => {
        if (controller.signal.aborted) return;
        transfer.current = null; setLoading(null); setPlaying(true);
        return playAudio(audio).finally(() => setPlaying(false));
      })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e), "library"); })
      .finally(() => { if (current()) { transfer.current = null; setLoading(null); } });
  }
  const batch = state.data?.batch;
  // Limits of the running model, else the selected one; profiles may narrow seconds and raise the step floor.
  const activeModel = state.data?.model ?? model, limits = catalog.data?.find((m) => m.id === activeModel);
  const maxSeconds = api.durationLimit(activeModel, limits), stepFloor = api.minSteps(limits), minimax = limits?.controls === "minimax";
  const variations = variationText.split("\n").map((line) => line.trim()).filter(Boolean);
  const takes = /^\d+$/.test(count.trim()) ? Number(count) : 1;
  // Native MiniMax workload: every take is one engine run producing LM songs × noise renders files.
  const whole = (v: string) => /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : 1;
  const songs = minimax ? whole(mm.lmBatch) : 1, renders = minimax ? whole(mm.synthBatch) : 1, files = takes * songs * renders;
  const replaying = minimax && !!mm.audioCodes;
  const command = state.data?.backend === "command";
  const action = useMutation({
    mutationFn: async ({ fn }: { fn: () => Promise<unknown>; scope: Scope }) => fn(),
    onMutate: () => setError(""),
    onError: (e, { scope }) => setError(e instanceof Error ? e.message : String(e), scope),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["music-status"] }); void queryClient.invalidateQueries({ queryKey: ["music-tracks"] }); },
  });
  const busy = action.isPending;
  function run(fn: () => Promise<unknown>, scope: Scope = "global") { action.mutate({ fn, scope }); }
  const text = { color: c.foreground };
  const muted = { color: c.foregroundMuted, fontSize: 13 };
  const box = { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 16, gap: 12 };
  const field = { color: c.foreground, backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 46 };
  function alert(scope: Scope) {
    return failure?.scope === scope ? <Text accessibilityRole="alert" selectable style={{ ...text, fontWeight: "600" }}>{failure.message}</Text> : null;
  }
  // Model choice: steps start at the new model's suggestion (else Studio's 8); seconds are clamped to its limit.
  function chooseModel(m: NonNullable<typeof catalog.data>[number]) {
    if (m.id === model) return;
    setModel(m.id); setSteps(String(m.defaultSteps ?? 8));
    const max = api.durationLimit(m.id, m), value = Number(duration);
    if (m.controls === "minimax" && duration === "30") setDuration(String(Math.min(60, max)));
    else if (!(value > 0)) return;
    else if (value > max) setDuration(String(max));
    else if (m.backend === "command" && m.controls !== "minimax" && !Number.isInteger(value)) setDuration(String(Math.max(1, Math.floor(value))));
  }
  function button(label: string, onPress: () => void, disabled = false, expanded?: boolean) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, expanded }} aria-expanded={expanded} disabled={disabled} onPress={onPress}
      style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 16, minHeight: 46, justifyContent: "center", opacity: disabled ? 0.45 : 1 }}>
      <Text style={text}>{label}</Text>
    </Pressable>;
  }
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: 20, maxWidth: 960, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ ...text, fontSize: 28, fontWeight: "700" }}>Paseo Music Studio</Text>
      <Text style={muted}>{host.label} · your music models · your host</Text>
      <Text style={text}>Launch → generate → select a take → listen or delete.</Text>
    </View>
    {preferences.status === "ready" && !preferences.values.outputsDir ? <View style={box}><Text style={text}>First-time setup: choose an absolute music output folder, then configure Stable Audio or add a trusted command profile in Settings. Existing music is not deleted; select your prior output folder to see it. Nothing installs or launches automatically.</Text>{legacy.data ? <><Text selectable style={muted}>Existing setup found: {legacy.data.binary} · models {legacy.data.modelsDir} · music {legacy.data.outputsDir}</Text>{button("Use my existing Stable Audio setup", () => run(async () => { if (!await preferences.save(legacy.data!, preferences.revision)) throw new Error("Setup was not saved; retry"); await queryClient.invalidateQueries({ queryKey: ["music-models"] }); await queryClient.invalidateQueries({ queryKey: ["music-tracks"] }); }), busy || preferences.saving)}</> : null}</View> : null}
    {failure?.scope === "global" || state.error || library.error || catalog.error ? <Text accessibilityRole="alert" selectable style={text}>{failure?.scope === "global" ? failure.message : String(state.error || library.error || catalog.error)}</Text> : null}
    <View style={box}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>Engine · {phase ?? "connecting"}{state.data?.model ? " · " + state.data.model : ""}</Text>
      <Text style={muted}>{state.data?.message ?? "Connecting to this host…"}</Text>
      <Text style={muted}>Available model profiles · Stable Audio or your own music CLI</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {catalog.data?.map((m) => { const checked = (stopped ? model : state.data?.model) === m.id; return <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ checked, disabled: !stopped || busy }} aria-checked={checked} disabled={!stopped || busy} onPress={() => chooseModel(m)}
          style={{ borderWidth: checked ? 2 : 1, borderColor: checked ? c.accent : c.border, padding: 12, borderRadius: 8, minHeight: 46, maxWidth: "100%", flexShrink: 1 }}>
          <Text style={text}>{m.label} · {m.backend === "command" ? "per-take CLI" : "resident engine"}</Text>
        </Pressable>; })}
      </View>
      {catalog.data?.length === 0 ? <Text style={muted}>No available model found. Configure Stable Audio paths or a command profile with an available executable. Nothing downloads automatically.</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("Activate model", () => run(() => start({ model }), "engine"), busy || !stopped || !catalog.data?.some((m) => m.id === model))}
        {button("Stop model", () => run(() => stop({}), "engine"), busy || (phase !== "ready" && phase !== "error"))}
        {button(phase === "starting" ? "Cancel launch" : phase === "generating" && batch?.state === "running" ? "Cancel batch" : "Abort generation", () => run(() => abort({}), "engine"), busy || (phase !== "generating" && phase !== "starting"))}
        {button("Settings", () => { setShowSettings(!showSettings); if (preferences.status === "ready") { setDraft({ ...preferences.values }); setProfileText(JSON.stringify(preferences.values.profiles ?? [], null, 2)); setTrustCommands(false); setDraftRevision(preferences.revision); } })}
      </View>
      <Text style={muted}>Stable Audio stays loaded until stopped. Command profiles load and exit per take. Abort ends the unfinished job and its owned process group/tree; saved tracks are kept. Detached external services are not supported.</Text>
      {alert("engine")}
      {/* Command engines report stages, not a measurable overall percentage; Stable Audio's % is measured. */}
      {phase === "generating" ? <Text accessibilityLiveRegion="polite" style={text}>{batch ? `Take ${batch.current}/${batch.total} · ` : ""}{command
        ? (state.data?.activity || "Working · engine has not reported progress") + (state.data?.elapsedSeconds !== undefined ? ` · ${clock(state.data.elapsedSeconds)} elapsed` + (state.data.timeoutSeconds ? ` of ${clock(state.data.timeoutSeconds)} run budget` : "") : "")
        : `${Math.round(state.data?.progress ?? 0)}% · ${state.data?.message}`}</Text> : null}
      {batch ? <Text accessibilityLiveRegion="polite" style={muted}>Batch · {batch.completed}/{batch.total} saved · take {batch.current}/{batch.total} · {batch.state}</Text> : null}
    </View>
    {showSettings ? <View style={box}>
      <Text accessibilityRole="header" style={text}>Host configuration</Text>
      {draft && preferences.status === "ready" ? <>
        {(["binary", "modelsDir", "outputsDir"] as const).map((key) => <View key={key} style={{ gap: 6 }}>
          <Text style={muted}>{key === "binary" ? "Stable Audio executable (optional)" : key === "modelsDir" ? "Stable Audio model folder (optional)" : "Music output folder"}</Text>
          <TextInput accessibilityLabel={key} value={draft[key]} editable={stopped && !preferences.saving} onChangeText={(value) => setDraft({ ...draft, [key]: value })} style={field} autoCapitalize="none" autoCorrect={false} />
        </View>)}
        <Text style={text}>Custom command profiles (JSON array)</Text>
        <TextInput accessibilityLabel="Custom command profiles" multiline value={profileText} onChangeText={(value) => { setProfileText(value); setTrustCommands(false); }} editable={stopped && !preferences.saving} autoCapitalize="none" autoCorrect={false} style={{ ...field, minHeight: 180, textAlignVertical: "top", fontFamily: "monospace" }} />
        <Text style={muted}>Trusted code: executables run with this host user’s permissions and can read files or contact external services. Only configure models/commands you trust; do not put secrets in profiles. See docs/BACKENDS.md for the contract and examples.</Text>
        {button(trustCommands ? "Custom command trust acknowledged" : "I trust these custom commands", () => setTrustCommands(!trustCommands), !stopped || preferences.saving)}
        {button("Save settings", () => run(async () => {
          const profiles = api.commandProfiles.parse(JSON.parse(profileText));
          if (profiles.length && !trustCommands) throw new Error("Review and acknowledge the custom command permissions first");
          if (!await preferences.save({ ...draft, profiles }, draftRevision ?? preferences.revision)) throw new Error("Settings were not saved; reload and retry");
          await queryClient.invalidateQueries({ queryKey: ["music-models"] });
          await queryClient.invalidateQueries({ queryKey: ["music-tracks"] });
          stopTransfer(); setSelectedId(null); setConfirmId(null); setShowSettings(false);
        }, "settings"), !stopped || busy || preferences.saving)}
        {alert("settings")}
      </> : <Text style={muted}>Settings {preferences.status}. {preferences.status === "invalid" || preferences.status === "error" ? String(preferences.error) : ""}</Text>}
      <Text style={muted}>Stop the engine before changing paths or models. No installation, downloads or public network listener is added.</Text>
    </View> : null}
    {state.data?.pendingSave ? <View style={box}><Text style={text}>A completed take could not be saved. It is held for recovery (in memory and/or in a kept staging folder on disk, named below). Do not reload or disable the plug-in until Retry save succeeds.</Text><Text selectable style={muted}>{state.data.message}</Text>{button("Retry save", () => run(() => retrySave({}), "recovery"), busy)}{alert("recovery")}</View> : null}
    <View style={box}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>Create a track</Text>
      <Text style={muted}>Title</Text><TextInput accessibilityLabel="Track title" value={title} onChangeText={setTitle} maxLength={100} style={field} />
      <Text style={muted}>Music direction</Text><TextInput accessibilityLabel="Music direction" multiline value={prompt} onChangeText={setPrompt} maxLength={20000} style={{ ...field, minHeight: 140, textAlignVertical: "top" }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {[{ label: `Seconds (1–${maxSeconds})`, value: duration, set: setDuration }, { label: "Seed (−1 = random)", value: seed, set: setSeed }, { label: `Steps (minimum ${stepFloor})`, value: steps, set: setSteps }, { label: "Take count (1–20)", value: count, set: setCount }].map((f) => <View key={f.label} style={{ flexGrow: 1, minWidth: 130, gap: 6 }}>
          <Text style={muted}>{f.label}</Text><TextInput accessibilityLabel={f.label} value={f.value} onChangeText={f.set} keyboardType="numbers-and-punctuation" style={field} />
        </View>)}
      </View>
      {limits?.defaultSteps ? <Text style={muted}>Recommended steps for this model: {limits.defaultSteps}. It is a starting point; you can change it.</Text> : null}
      {minimax ? <View style={{ gap: 10 }}>
        <Text style={muted}>Vocals</Text>
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {([["Instrumental", true], ["Sung lyrics", false]] as const).map(([label, instrumental]) => <Pressable key={label} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: (mm.instrumental === "1") === instrumental }} aria-checked={(mm.instrumental === "1") === instrumental} onPress={() => setMmField("instrumental")(instrumental ? "1" : "0")} style={{ ...field, minHeight: 0, borderColor: (mm.instrumental === "1") === instrumental ? c.foreground : c.border }}><Text style={text}>{label}</Text></Pressable>)}
        </View>
        {mm.instrumental === "1" ? null : <><Text style={muted}>Lyrics</Text><TextInput accessibilityLabel="Lyrics" multiline value={mm.lyrics} onChangeText={setMmField("lyrics")} maxLength={20000} placeholder={"[verse]\n…"} placeholderTextColor={c.foregroundMuted} style={{ ...field, minHeight: 120, textAlignVertical: "top" }} /></>}
        {button(showAdvanced ? "Hide advanced MiniMax controls" : "Show advanced MiniMax controls", () => setShowAdvanced(!showAdvanced), false, showAdvanced)}
        {showAdvanced ? <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {mmFields.map((f) => <View key={f.key} style={{ flexGrow: 1, minWidth: 130, gap: 6 }}>
              <Text style={muted}>{f.label}</Text><TextInput accessibilityLabel={f.label} value={mm[f.key]} onChangeText={setMmField(f.key)} keyboardType="numbers-and-punctuation" style={field} />
            </View>)}
          </View>
          <Text style={muted}>Output format</Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {api.minimaxOptions.shape.format.removeDefault().options.map((format) => <Pressable key={format} accessibilityRole="radio" accessibilityLabel={`Format ${format}`} accessibilityState={{ checked: mm.format === format }} aria-checked={mm.format === format} onPress={() => setMmField("format")(format)} style={{ ...field, minHeight: 0, borderColor: mm.format === format ? c.foreground : c.border }}><Text style={text}>{format === "mp3" ? "MP3" : format === "wav32" ? "WAV 32-bit float" : format.replace("wav", "WAV ") + "-bit"}</Text></Pressable>)}
          </View>
          {mm.format === "mp3" ? <><Text style={muted}>MP3 bitrate (kbps)</Text>
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {api.MP3_BITRATES.map((rate) => <Pressable key={rate} accessibilityRole="radio" accessibilityLabel={`${rate} kbps`} accessibilityState={{ checked: mm.mp3Bitrate === String(rate) }} aria-checked={mm.mp3Bitrate === String(rate)} onPress={() => setMmField("mp3Bitrate")(String(rate))} style={{ ...field, minHeight: 0, borderColor: mm.mp3Bitrate === String(rate) ? c.foreground : c.border }}><Text style={text}>{rate}</Text></Pressable>)}
            </View></> : null}
          <Text style={muted}>LM songs × noise renders are produced natively in one engine run; each output is saved as its own track. Engine memory and Studio’s import-envelope safeguards limit native batches. Take count still runs separate engine runs one after another.</Text>
        </View> : null}
      </View> : null}
      <Text style={muted}>{minimax ? `This model accepts up to ${maxSeconds} seconds. That is an upper budget: a song can end earlier when the model finishes it, and the saved track shows its actual length.`
        : limits?.backend === "command" ? `This profile accepts up to ${maxSeconds} whole seconds; the command decides the actual length.`
        : "Medium supports up to 380 seconds (6m 20s); Small models support 120 seconds."} Long takes need more time, memory and disk.{limits?.timeoutSeconds ? ` Each engine run has a ${clock(limits.timeoutSeconds)} budget from its profile.` : ""}</Text>
      <Text style={muted}>Prompt variations (optional, one per line)</Text><TextInput accessibilityLabel="Prompt variations (one per line)" multiline value={variationText} onChangeText={setVariationText} maxLength={20 * 20001} placeholder={"Example: brushed drums, walking bass\nExample: big-band brass stabs"} placeholderTextColor={c.foregroundMuted} style={{ ...field, minHeight: 90, textAlignVertical: "top" }} />
      <Text style={muted}>{variations.length ? `${variations.length} variation line${variations.length === 1 ? "" : "s"} cycle across ${takes} take${takes === 1 ? "" : "s"}; each is appended to the music direction on a new line.` : "Each line is appended to the music direction on a new line; lines cycle across the takes. Leave empty to repeat the same direction."}</Text>
      {replaying ? <View style={{ gap: 8 }}>
        <Text style={text}>Replay mode · song codes loaded ({Math.ceil(mm.audioCodes.length / 1024)} KB)</Text>
        <Text style={muted}>Generate re-renders the saved song structure: new song-code sampling is skipped (the language model still runs to rebuild conditioning), so the length follows the codes rather than Seconds. Direction and lyrics still shape the result. Use one LM song per run.</Text>
        {button("Clear song codes (create a new song)", () => setMmField("audioCodes")(""))}
      </View> : null}
      {minimax && songs * renders > 1 ? <Text style={muted}>{takes} run{takes === 1 ? "" : "s"} × {songs} song{songs === 1 ? "" : "s"} × {renders} render{renders === 1 ? "" : "s"} = {files} tracks. Each run writes nothing until all of its {songs * renders} outputs finish, needs more memory as songs increase{limits?.timeoutSeconds ? `, and must finish within the ${clock(limits.timeoutSeconds)} run budget or nothing from it is saved` : ""}. For long jobs prefer Take count: each run is saved as it finishes.</Text> : null}
      {button((replaying ? (takes > 1 ? `Replay saved song · ${takes} takes` : "Replay saved song") : takes > 1 ? `Generate ${takes} takes` : "Generate music") + (files > takes ? ` → ${files} tracks` : ""), () => run(async () => {
        if (![seed, steps, count].every((v) => /^-?\d+$/.test(v.trim()))) throw new Error("Seed, steps and take count must be whole numbers");
        if (!/^\d+(?:\.\d+)?$/.test(duration.trim())) throw new Error("Seconds must be a positive number");
        if (limits?.backend === "command" && !minimax && !Number.isInteger(Number(duration))) throw new Error("This model takes whole seconds");
        const result = api.batchInput.safeParse({ title, prompt, duration: Number(duration), seed: Number(seed), steps: Number(steps), count: Number(count), variations, ...(minimax && { minimax: minimaxInput(mm) }) });
        if (!result.success) throw new Error(result.error.issues.map((issue) => (issue.path[0] === "variations" && typeof issue.path[1] === "number" ? `Variation line ${Number(issue.path[1]) + 1}` : issue.path.join(".")) + ": " + issue.message).join("; "));
        if (result.data.duration > maxSeconds) throw new Error(`This model supports at most ${maxSeconds} seconds per take`);
        if (result.data.steps < stepFloor) throw new Error(`This model needs at least ${stepFloor} steps per take`);
        const { count: n, variations: lines, ...take } = result.data;
        // Show Generating at once so a second press cannot slip in before the next status poll.
        queryClient.setQueryData(["music-status"], n > 1 || lines.length ? await generateBatch(result.data) : await generate(take));
      }, "generate"), busy || phase !== "ready" || state.data?.pendingSave)}
      {alert("generate")}
      <Text style={muted}>Tempo and instruments are prompt guidance, not exact controls. Takes run one at a time on the host and continue if this screen closes; each is saved as it finishes. Seeds count up from the given seed (a random start for −1), but some command profiles ignore the seed, so repeated takes may sound alike. Cancel batch or a failed take/save stops the queue; saved takes are kept.</Text>
    </View>
    <View style={box}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>Music library · {library.data?.length ?? 0}</Text>
      {!library.data?.length ? <Text style={muted}>Your generated tracks will appear here. Existing jazz samples are not imported or changed.</Text> : null}
      {library.data?.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button(picking ? "Done selecting" : "Select tracks", () => { stopTransfer(); setPicking(!picking); setConfirmBatch(null); setShowPrompt(false); })}
        {picking ? button(`Select all (up to ${zipMax})`, () => pick(library.data!.slice(0, zipMax).map((t) => t.id)), zipIds.length >= Math.min(zipMax, library.data.length)) : null}
        {picking ? button("Clear selection", () => pick([]), !zipIds.length) : null}
      </View> : null}
      {picking ? <View style={{ gap: 8 }}>
        <Text accessibilityLiveRegion="polite" style={text}>{zipIds.length} of {zipMax} selected</Text>
        <Text style={muted}>Tap tracks to add or remove them. Select all picks the newest {zipMax}. Download them as one ZIP or move them to the trash.</Text>
        <TrackDownload trackIds={zipIds} theme={theme} layout={layout} />
        {button(`Delete selected (${zipIds.length})`, () => setConfirmBatch(zipIds), !zipIds.length || busy || playing || loading !== null || !!confirming)}
        {confirming ? <View style={{ gap: 10 }}>
          <Text style={text}>Move {confirming.length} track{confirming.length === 1 ? "" : "s"} to the output folder's .trash? They stay recoverable there; nothing is permanently deleted. Wait for active downloads to finish; deleting revokes their links.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {button(`Confirm move ${confirming.length} to trash`, () => deleteBatch(confirming), busy)}
            {button("Keep tracks", () => setConfirmBatch(null), busy)}
          </View>
        </View> : null}
      </View> : null}
      {picking ? library.data?.map((track) => {
        const checked = zipIds.includes(track.id), full = !checked && zipIds.length >= zipMax;
        return <Pressable key={track.id} accessibilityRole="checkbox" accessibilityLabel={track.title} accessibilityState={{ checked, disabled: full }} aria-checked={checked} disabled={full}
          onPress={() => pick(checked ? zipIds.filter((id) => id !== track.id) : [...zipIds, track.id])}
          style={{ padding: 12, gap: 4, borderWidth: checked ? 2 : 1, borderColor: checked ? c.accent : c.border, borderRadius: 8, opacity: full ? 0.45 : 1 }}>
          <Text style={text}>{checked ? "☑ " : "☐ "}{track.title}</Text><Text style={muted}>{lengthLabel(track)} · {track.modelLabel ?? track.model}</Text>
        </Pressable>;
      }) : library.data?.map((track) => <Pressable key={track.id} accessibilityRole="radio" accessibilityLabel={track.title} accessibilityState={{ checked: selectedId === track.id }}
        onPress={() => { stopTransfer(); setSelectedId(track.id); setConfirmId(null); setShowPrompt(false); }} style={{ padding: 12, gap: 4, borderWidth: selectedId === track.id ? 2 : 1, borderColor: selectedId === track.id ? c.accent : c.border, borderRadius: 8 }}>
        <Text style={text}>{track.title}</Text><Text style={muted}>{lengthLabel(track)} · {track.modelLabel ?? track.model} · {track.seedForwarded === false ? "seed not forwarded" : "seed " + track.seed} · {new Date(track.createdAt).toLocaleString()}</Text>
      </Pressable>)}
      {picking ? alert("library") : null}
      {selected && !picking ? <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button(loading !== null ? `Loading audio… ${loading}%` : playing ? "Playing…" : "Listen to selected track", () => listen(selected), playing || loading !== null)}
          {loading !== null ? button("Cancel loading", stopTransfer) : null}
          {button("Delete selected track", () => setConfirmId(selected.id), busy || playing || loading !== null)}
        </View>
        <Text style={muted}>{quick(selected) ? `Quick playback: up to ${quickSeconds} s and ${Math.floor(api.MAX_PLAYBACK_BYTES / 1048576)} MiB, sent in one transfer.` : "Full-track loading: fetches the audio in 3 MiB pieces, then plays after the last piece arrives."} Both load before playback; this is not live streaming. Size or format can require full-track loading below {quickSeconds} s.</Text>
        <TrackDownload trackId={selected.id} mimeType={selected.mimeType ?? (selected.minimax?.format === "mp3" ? "audio/mpeg" : "audio/wav")} theme={theme} layout={layout} />
        <Text style={muted}>Audio loads unchanged from the host, then plays on this device through Paseo. Long full-quality tracks take longer to load and need more device memory. Use Paseo's voice playback control to interrupt playback.</Text>
        {confirmId === selected.id ? <View style={{ gap: 10 }}>
          <Text style={text}>Delete “{selected.title}” from the library? It will move to the output folder's .trash, where it remains recoverable.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {button("Confirm delete", () => run(async () => { await remove({ id: selected.id }); setSelectedId(null); setConfirmId(null); }, "library"), busy)}
            {button("Keep track", () => setConfirmId(null), busy)}
          </View>
        </View> : null}
        {button(showPrompt ? "Hide music-generation prompt" : "Show music-generation prompt", () => setShowPrompt(!showPrompt), false, showPrompt)}
        {showPrompt ? <Text selectable style={muted}>{selected.prompt}</Text> : null}
        {selected.minimax ? <Text selectable style={muted}>LM seed {selected.minimax.lmSeed} · LM CFG {selected.minimax.lmCfg} · DiT CFG {selected.minimax.ditCfg} · top-k {selected.minimax.topK} · {selected.minimax.lyrics === "[instrumental]" ? "instrumental" : "sung"}</Text> : null}
        {selected.minimax ? (() => {
          // Never retarget a recipe silently: a different active model must be stopped first (never auto-stopped).
          const other = !stopped && state.data?.model !== selected.model, available = catalog.data?.some((m) => m.id === selected.model);
          return <>
            {button(selected.replayAvailable ? "Use settings and song codes" : "Use these settings", () => run(async () => {
              if (!available) throw new Error(`${selected.modelLabel ?? selected.model} is not available on this host; settings were not loaded`);
              // Loads the form only (requested seconds, not measured length); generation still needs an explicit press.
              const input = selected.replayAvailable ? await getReplay({ id: selected.id }) : api.generateInput.parse(selected);
              setTitle(input.title); setPrompt(input.prompt); setDuration(String(input.duration)); setSteps(String(input.steps)); setSeed(String(input.seed)); setCount("1"); setVariationText("");
              if (input.minimax) setMm(minimaxText(input.minimax));
              if (stopped) setModel(selected.model);
            }, "library"), busy || other)}
            {other ? <Text style={muted}>This track was made with {selected.modelLabel ?? selected.model}. Stop {state.data?.model} first to load its settings; nothing is stopped automatically.</Text> : null}
          </>;
        })() : null}
        {alert("library")}
      </View> : null}
    </View>
    {state.data?.log ? <View style={box}><Text style={muted}>Engine log (last 12 KB)</Text><Text selectable style={{ ...muted, fontFamily: "monospace" }}>{state.data.log}</Text></View> : null}
  </ScrollView>;
}
