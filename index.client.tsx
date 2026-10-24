import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Studio } from "./client/studio";

function MusicItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Music" active={currentScreen?.screenId === "studio"} onPress={() => openScreen({ screenId: "studio" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "studio", title: "Paseo Music Studio", Component: (props) => <Studio {...props} playAudio={(audio) => client.playAudio(audio)} /> });
  client.addSidebarHeaderItem({ id: "music", title: "Paseo Music Studio", Component: MusicItem });
  client.addCommandCenterItem({ id: "open-music", title: "Open Paseo Music Studio", icon: "Music", context: "global", onSelect: ({ openScreen }) => openScreen({ screenId: "studio" }) });
  return () => {};
}
