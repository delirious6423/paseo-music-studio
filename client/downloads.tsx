import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as api from "../shared/music";

// Original audio (5-minute link) or up to 20 selected tracks (one ZIP, 15-minute link).
export function TrackDownload({ trackId, trackIds, mimeType, theme, layout }: Pick<PluginScreenProps, "theme" | "layout"> & { trackId?: string; trackIds?: string[]; mimeType?: api.Track["mimeType"] }) {
  const zip = !!trackIds, key = trackIds ? trackIds.join(",") : trackId ?? "";
  const valid = zip ? api.batchDownloadIds.safeParse(trackIds).success : !!trackId;
  const file = zip ? "ZIP" : mimeType === "audio/mpeg" ? "MP3" : "WAV";
  // Invalidate abandoned requests even when a selection changes away and back to the same IDs.
  const currentKey = useRef(key); currentKey.current = key;
  const generation = useRef(0);
  useLayoutEffect(() => () => { generation.current++; }, [key]);
  const c = theme.colors, text = { color: c.foreground }, hint = { color: c.foregroundMuted, fontSize: 13 };
  const [showSetup, setShowSetup] = useState(false), [more, setMore] = useState(false);
  const [choice, setChoice] = useState<api.DownloadTarget | null>(null);
  const [openError, setOpenError] = useState("");
  const getOptions = useRpc(api.downloadOptions), getDownload = useRpc(api.download), getBatch = useRpc(api.downloadBatch);
  const options = useQuery({ queryKey: ["music-download-options"], queryFn: () => getOptions({}), enabled: showSetup, retry: false });
  const download = useMutation({
    mutationFn: async (target: api.DownloadTarget) => ({ ...await (zip ? getBatch({ ids: trackIds!, target, acknowledged: true }) : getDownload({ id: trackId!, target, acknowledged: true })), key, kind: target.kind }),
    onMutate: () => { setOpenError(""); return ++generation.current; },
    onSuccess: async (link, _target, request) => {
      if (request !== generation.current || link.key !== currentKey.current) return;
      setShowSetup(false);
      if (layout.platform !== "web") {
        try { await openExternalUrl(link.url); }
        catch { if (request === generation.current) setOpenError(`The browser did not open. Tap Open ${file} download below.`); }
      }
    },
    onError: (_error, _target, request) => { if (request === generation.current) { setChoice(null); setShowSetup(true); } },
  });
  function button(label: string, onPress: () => void, disabled = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
      style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, minHeight: 46, justifyContent: "center", opacity: disabled ? 0.45 : 1 }}><Text style={text}>{label}</Text></Pressable>;
  }
  const currentRequest = download.context === generation.current;
  const link = currentRequest && download.data?.key === key ? download.data : null;
  const downloadError = currentRequest ? download.error : null;
  const expiry = zip ? "15 minutes" : "five minutes";
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {button(download.isPending ? "Preparing download…" : zip ? `Download selected as ZIP (${trackIds!.length})` : `Download ${file}`, () => choice?.kind === "tailscale" ? download.mutate(choice) : setShowSetup(true), download.isPending || !valid)}
      {choice ? button("Download setup / Change connection", () => setShowSetup(true), download.isPending) : null}
    </View>
    {downloadError || openError ? <Text accessibilityRole="alert" selectable style={text}>{openError || String(downloadError)}</Text> : null}
    {showSetup ? <View style={{ gap: 12, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>Download setup · choose a connection</Text>
      <Text style={hint}>No download listener starts until you confirm a route. Nothing installs automatically. Host addresses are detected; phone reachability is not verified.</Text>
      <Text style={{ ...text, fontWeight: "600" }}>Same Wi-Fi · no extra app</Text>
      <Text style={hint}>Both devices must use the same trusted router. Unencrypted HTTP: network observers or anyone with the link and network access can read the track. Avoid public/guest Wi-Fi. Confirm your current network each time; we cannot verify its Wi-Fi name.</Text>
      {options.data?.filter((r) => r.kind === "lan").map((r) => <View key={r.address} style={{ gap: 4 }}>
        <Text style={hint}>Host interface: {r.interface} · {r.cidr ?? r.address}</Text>
        {button("I trust this network — download via " + r.address, () => { setChoice(r); download.mutate(r); }, download.isPending || options.isFetching || !valid)}
      </View>)}
      {options.data && !options.data.some((r) => r.kind === "lan") ? <Text style={hint}>No supported LAN address. Connect the host to Wi-Fi/Ethernet, then recheck. IPv6-only and virtual/VPN-only LAN interfaces are unsupported.</Text> : null}
      <Text style={{ ...text, fontWeight: "600" }}>Tailscale · optional remote access</Text>
      <Text style={hint}>For different networks: connect Tailscale on both devices to the same tailnet. Encrypted private networking from Tailscale Inc.; no music-service upload. Setup and privacy details below.</Text>
      {options.data?.filter((r) => r.kind === "tailscale").map((r) => <View key={r.address} style={{ gap: 4 }}>
        <Text style={hint}>{r.interface} · {r.address} · also connect your phone</Text>
        {button("Use Tailscale and download", () => { setChoice(r); download.mutate(r); }, download.isPending || options.isFetching || !valid)}
      </View>)}
      {options.data && !options.data.some((r) => r.kind === "tailscale") ? <Text style={hint}>Not detected on this host. Connect both devices, then recheck; or choose same Wi-Fi above.</Text> : null}
      <ExternalLink href="https://tailscale.com/download">Get Tailscale (optional)</ExternalLink>
      {options.isFetching ? <Text accessibilityLiveRegion="polite" style={hint}>Checking host connections…</Text> : null}
      {options.error ? <Text accessibilityRole="alert" style={text}>Cannot check connections: {String(options.error)}</Text> : null}
      <Text style={hint}>Links expire after {expiry} and may enter browser/iCloud history. Originals stay in your library.{zip ? " The ZIP holds the original audio files, numbered, uncompressed and not re-encoded; it is streamed, so allow time and space for large selections." : ""} Safari: Download or Share → Save to Files.</Text>
      <Text style={hint}>Keep the download running; 30 seconds without transfer can interrupt it after preparation. Larger files get additional transfer time, within a bounded deadline. On slow connections, download fewer tracks at once.</Text>
      {button(more ? "Less setup help" : "Setup help, privacy & troubleshooting", () => setMore(!more))}
      {more ? <View style={{ gap: 8 }}>
        <Text style={hint}>Paseo can play through its connection, but this version cannot save directly. A chosen route opens a temporary listener on only that interface. We do not configure public addresses or router port forwarding. Tailscale choices are remembered only in this library view; LAN downloads require confirmation every time. Interface/CIDR checks do not identify a Wi-Fi network. An unexpired LAN link may remain reachable if you switch networks with identical interface/address settings; use Tailscale when privacy matters.</Text>
        <Text style={hint}>Tailscale setup: install its app on the host and phone, sign into the same tailnet, then connect. It creates a virtual adapter and exchanges account/device connection metadata with Tailscale. Your host serves the track directly; traffic is encrypted through Tailscale. Disconnect or uninstall to undo.</Text>
        <ExternalLink href="https://tailscale.com/privacy-policy">Tailscale privacy policy</ExternalLink>
        <ExternalLink href="https://tailscale.com/docs/features/client/uninstall">Uninstall Tailscale</ExternalLink>
        <Text style={hint}>If it will not connect: check both devices' networks, guest Wi-Fi isolation, VPN routing and host firewall/tailnet rules. We do not change firewall/router rules automatically. macOS utun is unsupported for Tailscale detection; same-Wi-Fi is an option. Android/browser: use Download and your Downloads folder.</Text>
        <Text style={hint}>Away from home without Tailscale? Remote download is unavailable in this version; listening through Paseo still works. No public tunnel or cloud upload is set up.</Text>
      </View> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("Recheck connections", () => { void options.refetch(); }, options.isFetching)}
        {button("Not now", () => setShowSetup(false), download.isPending)}
      </View>
    </View> : null}
    {link ? <View style={{ gap: 6 }}>
      <ExternalLink href={link.url}>{`Open ${file} download`}</ExternalLink>
      <Text style={hint}>If nothing opened, tap the link above. {link.kind === "lan" ? "Use the same trusted router." : "Connect Tailscale on both devices."} Expires {new Date(link.expiresAt).toLocaleTimeString()}; press {zip ? "Download selected as ZIP" : `Download ${file}`} for a fresh link. Safari: Download or Share → Save to Files. Anyone with the link and network access can fetch {zip ? "these tracks" : "this track"} until expiry.</Text>
    </View> : null}
  </View>;
}
