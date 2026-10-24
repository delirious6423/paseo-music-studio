// Minimal stand-ins for the host UI kit ("@getpaseo/plugin/client/ui") in the fixture harness; not shipped.
import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";

export function ExternalLink({ href, children, accessibilityLabel }: { href: string; children: ReactNode; accessibilityLabel?: string }) {
  return <Text accessibilityRole="link" accessibilityLabel={accessibilityLabel} {...{ href } as object} style={{ color: "#7ccba0", textDecorationLine: "underline" }}>{children}</Text>;
}

export function SidebarRow({ label, onPress }: { label?: string; onPress: () => void }) {
  return <Pressable onPress={onPress}><Text>{label ?? "Music"}</Text></Pressable>;
}
