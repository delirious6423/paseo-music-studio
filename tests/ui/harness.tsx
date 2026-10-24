// Component fixture: renders the plug-in's real registered screen (index.client.tsx → client/*) with
// react-native-web, the real SDK RPC provider and Paseo's own theme palette. RPCs answer from fixture.ts.
// This is not the Paseo app, its daemon or a GPU engine.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import contribute from "../../index.client";
import { audio, download, engine, extra, removal, responses, tracks, wavByte } from "./fixture";
import { batchTakes } from "../../shared/music";

// Paseo packages/app/src/styles/theme.ts (ab6cdb7): paseo dark and light palettes as passed by toPluginTheme.
const palettes = {
  dark: { surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", border: "#252B2A", foreground: "#fafafa", foregroundMuted: "#A1A5A4", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#6cb17b", statusWarning: "#c09664", statusDanger: "#d8847b" },
  light: { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7", foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#3e704a", statusWarning: "#7b5d39", statusDanger: "#9d433b" },
};
// No DOM lib in the repo tsconfig (it would mask DOM use in plug-in code), so reach the page through globalThis.
const { document, location } = globalThis as any;
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const compact = params.get("compact") === "1";
const calls: string[] = ((globalThis as any).rpcCalls = []);
const inputs: { method: string; input: unknown }[] = ((globalThis as any).rpcInputs = []);
const played: { base64: string; mimeType: string }[] = [];
const traffic: { method: string; bytes: number }[] = [];
if (params.get("workload") === "polling") {
  engine.status.log = "x".repeat(12000);
  tracks.forEach((track) => { track.prompt = "x".repeat(600); });
  extra.tracks = Array.from({ length: 193 }, (_, i) => ({ ...tracks[0], id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Polling take ${i}` }));
}
Object.assign(globalThis as any, { fixtureEngine: engine, fixtureAudio: audio, fixtureDownload: download, fixtureExtra: extra, fixtureRemoval: removal, fixtureTracks: tracks, fixtureTraffic: traffic, openedUrls: [], wavByte, played, batchTakes });

const contributions: Record<string, any> = {};
const client = new Proxy({ playAudio: async (source: { base64: string; mimeType: string }) => { played.push(source); } }, {
  get: (target: any, name: string) => name in target ? target[name]
    : (contribution: any) => { contributions[`${name}:${contribution.id}`] = contribution; return () => {}; },
});
contribute(client);
const screens = Object.entries(contributions).filter(([key]) => key.startsWith("addScreen:"));
if (screens.length !== 1) throw new Error("Expected one registered screen, got " + screens.map(([k]) => k).join(", "));
const Screen = screens[0][1].Component;
(globalThis as any).registered = Object.keys(contributions);

async function invoke(method: string, input: unknown) {
  calls.push(method); inputs.push({ method, input: structuredClone(input) });
  if (!(method in responses)) throw new Error("Fixture has no response for " + method);
  const response = responses[method];
  const result = typeof response === "function" ? await response(input) : response;
  if (method === "music.status" || method === "music.tracks") traffic.push({ method, bytes: new TextEncoder().encode(JSON.stringify(result)).length });
  return structuredClone(result);
}
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
document.body.style.backgroundColor = palettes[theme].surface0;
const root = createRoot(document.getElementById("root")!);
(globalThis as any).fixtureUnmount = () => root.render(null);
root.render(
  <QueryClientProvider client={queries}>
    <PluginRpcProvider invoke={invoke}>
      <Screen theme={{ colors: palettes[theme] }} layout={{ compact, platform: params.get("platform") === "ios" ? "ios" : "web" }} host={{ id: "fixture", label: "Synthetic VM host" }} params={{}} />
    </PluginRpcProvider>
  </QueryClientProvider>,
);
