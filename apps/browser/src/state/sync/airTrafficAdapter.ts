import { assignPositions, type Adapter } from "../../platform/sync";
import { isFields, isString } from "../../lib/decode";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { currentAirTraffic, replaceAirTraffic } from "../airTraffic/store";
import { ruleOf, targetFrom, type AirTrafficConfig, type AirTrafficRule, type AirTrafficTarget, type LinkCondition, type OpenAs, type SourceApp } from "../airTraffic/rules";
import { noteAirTrafficRulesSynced } from "../telemetry/airTrafficCounts";

export const AIR_TRAFFIC = "atc:";
export const AIR_TRAFFIC_RULE = `${AIR_TRAFFIC}r:`;
export const AIR_TRAFFIC_FALLBACK = `${AIR_TRAFFIC}else`;

export type AirTrafficTargetValue = { p: string | null; o: OpenAs; g?: string };
export type AirTrafficRuleValue = AirTrafficTargetValue & { on: boolean; f: SourceApp | null; w: LinkCondition; pos: string };

export type SyncedProfiles = {
  syncIdOf: (profileId: string) => string | undefined;
  profileIdOf: (syncId: string) => string | null;
};

const ruleKey = (id: string) => `${AIR_TRAFFIC_RULE}${id}`;
const syncedPosition = (value: unknown) => (isFields(value) && isString(value.pos) && value.pos ? value.pos : undefined);
const syncedProfile = (value: unknown) => (isFields(value) && (value.p === null || isString(value.p)) ? value.p : undefined);

const targetIn = (v: unknown, profileOf: (p: string) => string): AirTrafficTarget | null =>
  isFields(v) ? targetFrom({ profileId: isString(v.p) ? profileOf(v.p) : v.p, open: v.o, groupKey: v.g }) : null;

function ruleIn(key: string, v: unknown, profileOf: (p: string) => string): AirTrafficRule | null {
  if (!isFields(v) || !syncedPosition(v)) return null;
  return ruleOf({ id: key.slice(AIR_TRAFFIC_RULE.length), enabled: v.on, from: v.f, when: v.w, profileId: isString(v.p) ? profileOf(v.p) : v.p, open: v.o, groupKey: v.g });
}

const readable = (key: string, value: unknown) =>
  key.startsWith(AIR_TRAFFIC_RULE) ? !!ruleIn(key, value, (p) => p) : key === AIR_TRAFFIC_FALLBACK && !!targetIn(value, (p) => p);

function relinked(config: AirTrafficConfig, profiles: SyncedProfiles, base: (key: string) => unknown): AirTrafficConfig {
  const here = useBrowser.getState().profiles;
  const local = <T extends AirTrafficTarget>(t: T, key: string): T => {
    if (t.profileId === null || here[t.profileId]) return t;
    const sent = syncedProfile(base(key));
    const id = profiles.profileIdOf(t.profileId) ?? (isString(sent) ? profiles.profileIdOf(sent) : null);
    return id ? { ...t, profileId: id } : t;
  };
  const rules = config.rules.map((r) => local(r, ruleKey(r.id)));
  const fallback = config.fallback && local(config.fallback, AIR_TRAFFIC_FALLBACK);
  return rules.some((r, i) => r !== config.rules[i]) || fallback !== config.fallback ? { rules, fallback } : config;
}

function ordered(rules: AirTrafficRule[], visible: Map<string, unknown>): AirTrafficRule[] {
  const placed = rules.flatMap((r) => {
    const pos = syncedPosition(visible.get(ruleKey(r.id)));
    return pos ? [{ r, pos }] : [];
  });
  placed.sort((a, z) => (a.pos < z.pos ? -1 : a.pos > z.pos ? 1 : a.r.id < z.r.id ? -1 : 1));
  const unplaced = rules.filter((r) => !syncedPosition(visible.get(ruleKey(r.id))));
  return [...placed.map((p) => p.r), ...unplaced];
}

export function airTrafficAdapter(profiles: SyncedProfiles): Adapter {
  const profileHere = (syncId: string) => profiles.profileIdOf(syncId) ?? syncId;
  return {
    prefix: AIR_TRAFFIC,
    adoptRemoteOnJoin: true,
    extract: (base) => {
      const s = useBrowser.getState();
      const before = currentAirTraffic();
      const config = relinked(before, profiles, base);
      if (config !== before && !replaceAirTraffic(config)) return null;
      const targets = [...config.rules, ...(config.fallback ? [config.fallback] : [])];
      const awaitingLink = (id: string | null) => id !== null && !!s.profiles[id] && !isIncognitoProfile(id) && !profiles.syncIdOf(id);
      if (targets.some((t) => awaitingLink(t.profileId))) return null;
      const syncIdOf = (profileId: string | null, key: string): string | null => {
        if (profileId === null) return null;
        const linked = profiles.syncIdOf(profileId);
        if (linked) return linked;
        const sent = syncedProfile(base(key));
        return isString(sent) ? sent : profileId;
      };
      const targetValue = (t: AirTrafficTarget, key: string): AirTrafficTargetValue => ({ p: syncIdOf(t.profileId, key), o: t.open, ...(t.groupKey ? { g: t.groupKey } : {}) });
      const values = new Map<string, unknown>();
      const positions = assignPositions(config.rules.map((r) => syncedPosition(base(ruleKey(r.id)))));
      config.rules.forEach((r, i) => {
        const key = ruleKey(r.id);
        values.set(key, { on: r.enabled, f: r.from, w: r.when, ...targetValue(r, key), pos: positions[i]! } satisfies AirTrafficRuleValue);
      });
      if (config.fallback) values.set(AIR_TRAFFIC_FALLBACK, targetValue(config.fallback, AIR_TRAFFIC_FALLBACK));
      return { values, ignore: (key) => !values.has(key) && !readable(key, base(key)) };
    },
    apply: (visible, changed, base) => {
      const before = currentAirTraffic();
      const rules = new Map(before.rules.map((r) => [r.id, r]));
      let fallback = before.fallback;
      let arrived = 0;
      let reorder = false;
      for (const key of changed) {
        if (key === AIR_TRAFFIC_FALLBACK) {
          fallback = targetIn(visible.get(key), profileHere);
          continue;
        }
        if (!key.startsWith(AIR_TRAFFIC_RULE)) continue;
        const rule = ruleIn(key, visible.get(key), profileHere);
        const id = key.slice(AIR_TRAFFIC_RULE.length);
        if (!rule) rules.delete(id);
        else {
          reorder ||= !rules.has(id) || syncedPosition(visible.get(key)) !== syncedPosition(base(key));
          if (!rules.has(id)) arrived++;
          rules.set(id, rule);
        }
      }
      const kept = before.rules.flatMap((r) => rules.get(r.id) ?? []);
      const next = reorder ? ordered([...rules.values()], visible) : kept;
      if (!replaceAirTraffic({ rules: next, fallback })) return false;
      if (arrived) noteAirTrafficRulesSynced(arrived);
    },
  };
}
