import { currentAirTraffic } from "../airTraffic/store";
import { useBrowser } from "../browser/store";
import { isWildcardPattern, type AirTrafficConfig } from "../airTraffic/rules";

export type AirTrafficRouted = "rule" | "fallback" | "group";

const counts: Record<AirTrafficRouted, number> = { rule: 0, fallback: 0, group: 0 };
const ROUTED: readonly AirTrafficRouted[] = ["rule", "fallback", "group"];
let syncedRules = 0;

export const noteAirTrafficLink = (by: AirTrafficRouted) => void counts[by]++;
export const noteAirTrafficRulesSynced = (rules: number) => void (syncedRules += rules);

export function takeAirTrafficCounts() {
  const taken = { ...Object.fromEntries(ROUTED.map((by) => [`air_traffic_${by}_links`, counts[by]])), air_traffic_synced_rules: syncedRules };
  for (const by of ROUTED) counts[by] = 0;
  syncedRules = 0;
  return taken;
}

const profileHere = (id: string) => !!useBrowser.getState().profiles[id];

export const airTrafficSetting = (config: AirTrafficConfig, hasProfile: (id: string) => boolean = profileHere): Record<string, string> => {
  const enabled = config.rules.filter((r) => r.enabled);
  return {
    air_traffic_rules: String(enabled.length),
    air_traffic_wildcard_rules: String(enabled.filter((r) => r.when.kind === "pattern" && isWildcardPattern(r.when.pattern)).length),
    air_traffic_fallback: config.fallback ? "true" : "false",
    air_traffic_group_rules: String(enabled.filter((r) => r.groupKey).length),
    air_traffic_profileless_rules: String(enabled.filter((r) => r.profileId !== null && !hasProfile(r.profileId)).length),
  };
};

export const airTrafficSnapshot = () => airTrafficSetting(currentAirTraffic());
