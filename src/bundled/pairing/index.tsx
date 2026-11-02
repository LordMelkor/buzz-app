import type { PluginModule } from "../../plugins/api";
import { PairingSettings } from "./PairingSettings";
import { DeviceMobileIcon } from "../../shared/design-system/icons";
export const inject = ["settingsCards", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  const communities = ctx.communityReader;
  ctx.settingsCards.register({
    id: "mobile",
    title: "Pair mobile",
    icon: DeviceMobileIcon,
    // Pairing needs a community address, not a selected community.
    personal: true,
    component: ({ active }) => (
      <PairingSettings communities={communities} active={active} />
    ),
  });
};
