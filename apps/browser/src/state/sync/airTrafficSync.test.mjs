import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `id${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    enterPhrase: async () => ({ ok: true }),
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const air = await import("../airTraffic/store.ts");
const { parseAirTraffic, AIR_TRAFFIC_DOC, MAX_AIR_TRAFFIC_RULES } = await import("../airTraffic/rules.ts");
const { takeAirTrafficCounts } = await import("../telemetry/airTrafficCounts.ts");
const S = () => useBrowser.getState();
const config = () => air.useAirTraffic.getState().config;

class Mac {
  constructor() {
    S().hydrate({});
    useBrowser.setState({ bookmarksReady: { "": true } });
    air.resetAirTrafficForTests();
    this.browser = S();
    this.air = air.useAirTraffic.getState();
    this.docs = new Map();
  }
  async with(fn) {
    useBrowser.setState(this.browser, true);
    air.useAirTraffic.setState(this.air, true);
    shell.docs.clear();
    for (const [k, v] of this.docs) shell.docs.set(k, v);
    try {
      return await fn();
    } finally {
      this.browser = S();
      this.air = air.useAirTraffic.getState();
      this.docs = new Map(shell.docs);
    }
  }
}

const published = (prefix) =>
  [...folder.values()]
    .map((f) => JSON.parse(f.payload))
    .flatMap((f) => f.ops ?? Object.entries(f.records ?? {}).map(([k, r]) => ({ k, v: r.v })))
    .filter((op) => op.k.startsWith(prefix));

const named = (name) => S().profileOrder.find((id) => S().profiles[id].name === name);
const slack = { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };
const mail = { bundleId: "com.apple.mail", name: "Mail" };
const draft = (over = {}) => ({ enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "tab", ...over });
const shape = (c) => ({
  rules: c.rules.map((r) => ({ id: r.id, enabled: r.enabled, from: r.from?.name ?? null, when: r.when, profile: r.profileId === null ? null : (S().profiles[r.profileId]?.name ?? r.profileId), open: r.open, group: r.groupKey ?? null })),
  fallback: c.fallback && { profile: c.fallback.profileId === null ? null : (S().profiles[c.fallback.profileId]?.name ?? c.fallback.profileId), open: c.fallback.open },
});

async function turnOn(mac, engine, before = () => {}) {
  return mac.with(async () => {
    const made = await before();
    engine.startSync();
    assert.ok("ok" in (await engine.turnOnSync("/sync")));
    await engine.syncNow();
    await engine.syncNow();
    return made;
  });
}

async function join(mac, engine, before = () => {}) {
  return mac.with(async () => {
    const made = await before();
    engine.startSync();
    assert.ok("ok" in (await engine.enterRecoveryPhrase("/sync", "words")));
    await engine.syncNow();
    await engine.syncNow();
    return made;
  });
}

async function settle(pairs, rounds = 2) {
  for (let i = 0; i < rounds; i++) for (const [mac, engine] of pairs) await mac.with(() => engine.syncNow());
}

test("rules and Everything Else made on one Mac reach the other in the same profiles and order, and stop republishing", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?rulesA");
  const engineB = await import("./engine.ts?rulesB");
  await turnOn(a, engineA, () => {
    const work = S().createProfile({ name: "Work" });
    air.addAirTrafficRule(draft({ from: slack, when: { kind: "site", host: "github.com" }, profileId: work, open: "window" }));
    air.addAirTrafficRule(draft({ from: mail, profileId: "default", open: "littleArdia" }));
    air.addAirTrafficRule(draft({ enabled: false, when: { kind: "pattern", pattern: "*linear*" } }));
    air.setAirTrafficFallback({ profileId: work, open: "tab" });
  });
  await join(b, engineB, () => S().createProfile({ name: "Work" }));
  await settle([[a, engineA], [b, engineB]]);

  const onA = await a.with(() => shape(config()));
  const onB = await b.with(() => shape(config()));
  assert.deepEqual(onB, onA, "the second Mac has the same rules, in the same order, pointing at its own Work and Personal");
  assert.equal(onB.rules[0].profile, "Work");
  assert.equal(onB.rules[1].profile, "Personal");
  await b.with(() => assert.deepEqual(parseAirTraffic(shell.docs.get(AIR_TRAFFIC_DOC)), config(), "the second Mac saved them to air-traffic.json"));

  const before = published("atc:").length;
  await settle([[a, engineA], [b, engineB]], 3);
  assert.equal(published("atc:").length, before, "neither Mac republishes rules once they match");
});

test("edits, moves and deletes on either Mac reach the other", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?editsA");
  const engineB = await import("./engine.ts?editsB");
  const [first, second, third] = await turnOn(a, engineA, () => [
    air.addAirTrafficRule(draft({ from: slack })),
    air.addAirTrafficRule(draft({ from: mail })),
    air.addAirTrafficRule(draft({ when: { kind: "site", host: "example.com" } })),
  ]);
  await join(b, engineB);
  await settle([[a, engineA], [b, engineB]]);
  await b.with(() => assert.deepEqual(config().rules.map((r) => r.id), [first, second, third]));

  await b.with(() => {
    air.moveAirTrafficRule(third, -1);
    air.updateAirTrafficRule(first, { enabled: false });
  });
  await settle([[b, engineB], [a, engineA]]);
  await a.with(() => {
    assert.deepEqual(config().rules.map((r) => r.id), [first, third, second], "the move on B reached A");
    assert.equal(config().rules[0].enabled, false, "turning a rule off on B reached A");
    air.removeAirTrafficRule(third);
    air.setAirTrafficFallback({ profileId: null, open: "window" });
  });
  await settle([[a, engineA], [b, engineB]]);
  await b.with(() => {
    assert.deepEqual(config().rules.map((r) => r.id), [first, second], "the delete on A reached B");
    assert.deepEqual(config().fallback, { profileId: null, open: "window" });
    air.setAirTrafficFallback(null);
  });
  await settle([[b, engineB], [a, engineA]]);
  await a.with(() => assert.equal(config().fallback, null, "clearing Everything Else on B reached A"));
});

test("edits made on both Macs before either syncs all survive, and both Macs end with the same order", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?bothA");
  const engineB = await import("./engine.ts?bothB");
  const [first, second, third] = await turnOn(a, engineA, () => [
    air.addAirTrafficRule(draft({ from: slack })),
    air.addAirTrafficRule(draft({ from: mail })),
    air.addAirTrafficRule(draft({ when: { kind: "site", host: "example.com" } })),
  ]);
  await join(b, engineB);
  await settle([[a, engineA], [b, engineB]]);
  const onA = await a.with(() => {
    air.moveAirTrafficRule(third, -1);
    return air.addAirTrafficRule(draft({ when: { kind: "site", host: "a.example" } }));
  });
  const onB = await b.with(() => {
    air.updateAirTrafficRule(first, { enabled: false });
    return air.addAirTrafficRule(draft({ when: { kind: "site", host: "b.example" } }));
  });
  await settle([[a, engineA], [b, engineB]], 3);
  const orderA = await a.with(() => config().rules.map((r) => r.id));
  const orderB = await b.with(() => config().rules.map((r) => r.id));
  assert.deepEqual(orderB, orderA, "both Macs agree on the order");
  assert.deepEqual(orderA.slice(0, 3), [first, third, second], "A's move survives");
  assert.deepEqual(new Set(orderA.slice(3)), new Set([onA, onB]), "both new rules are there, after the others");
  await a.with(() => assert.equal(config().rules.find((r) => r.id === first).enabled, false, "B's switch survives"));
  const before = published("atc:").length;
  await settle([[a, engineA], [b, engineB]], 2);
  assert.equal(published("atc:").length, before, "and they stop republishing");
});

test("a Mac that joins keeps its own rules after the ones already synced, and sends them to the others", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?joinA");
  const engineB = await import("./engine.ts?joinB");
  const synced = await turnOn(a, engineA, () => air.addAirTrafficRule(draft({ from: slack })));
  const own = await join(b, engineB, () => air.addAirTrafficRule(draft({ from: mail })));
  await settle([[a, engineA], [b, engineB]]);
  await b.with(() => assert.deepEqual(config().rules.map((r) => r.id), [synced, own]));
  await a.with(() => assert.deepEqual(config().rules.map((r) => r.id), [synced, own]));
});

test("a rule for a profile this Mac hasn't added waits, names the profile, and works once it's added", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?laterA");
  const engineB = await import("./engine.ts?laterB");
  await turnOn(a, engineA, () => {
    const school = S().createProfile({ name: "School" });
    air.addAirTrafficRule(draft({ from: slack, profileId: school, groupKey: "pinned-group" }));
  });
  takeAirTrafficCounts();
  await join(b, engineB);
  await settle([[a, engineA], [b, engineB]]);

  const syncId = await b.with(() => {
    const remote = engineB.useSync.getState().remoteProfiles.find((p) => p.name === "School");
    assert.ok(remote, "School is offered on the second Mac");
    const rule = config().rules[0];
    assert.equal(rule.profileId, remote.syncId, "the rule keeps School's sync id until School is added");
    assert.equal(rule.groupKey, "pinned-group");
    assert.equal(S().profiles[rule.profileId], undefined, "so it doesn't route anywhere yet");
    assert.equal(takeAirTrafficCounts().air_traffic_synced_rules, 1);
    return remote.syncId;
  });
  const before = published("atc:").length;
  await settle([[a, engineA], [b, engineB]]);
  assert.equal(published("atc:").length, before, "the waiting rule isn't republished");

  await b.with(async () => {
    const school = engineB.addRemoteProfile(syncId);
    await engineB.syncNow();
    assert.equal(config().rules[0].profileId, school, "adding School points the rule at it");
  });
  await settle([[a, engineA], [b, engineB]]);
  assert.equal(published("atc:").length, before, "pointing it at the new profile changes nothing on the wire");
  await a.with(() => assert.equal(config().rules[0].profileId, named("School")));
});

test("rules merged past the limit when a Mac joins survive its restart; adding stops at the limit", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?capA");
  const engineB = await import("./engine.ts?capB");
  const each = MAX_AIR_TRAFFIC_RULES * 0.6;
  await turnOn(a, engineA, () => Array.from({ length: each }, () => air.addAirTrafficRule(draft())));
  await join(b, engineB, () => Array.from({ length: each }, () => air.addAirTrafficRule(draft())));
  await settle([[a, engineA], [b, engineB]]);
  await b.with(() => {
    assert.equal(config().rules.length, 2 * each);
    air.resetAirTrafficForTests(parseAirTraffic(shell.docs.get(AIR_TRAFFIC_DOC)));
    assert.equal(config().rules.length, 2 * each, "the saved file keeps them all across a restart");
    assert.equal(air.addAirTrafficRule(draft()), null, "a new rule is refused past the limit");
  });
  const deleted = () => published("atc:").filter((op) => op.v === null).length;
  const before = deleted();
  await settle([[b, engineB], [a, engineA]]);
  assert.equal(deleted(), before, "no Mac deletes a rule");
  await a.with(() => assert.equal(config().rules.length, 2 * each));
});

test("a rule keeps its profile on the other Macs when the profile is deleted here, and follows it when it's added back", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?readdA");
  const engineB = await import("./engine.ts?readdB");
  const work = await turnOn(a, engineA, () => {
    const id = S().createProfile({ name: "Work" });
    air.addAirTrafficRule(draft({ from: slack, profileId: id }));
    air.setAirTrafficFallback({ profileId: id, open: "window" });
    return id;
  });
  await join(b, engineB, () => S().createProfile({ name: "Work" }));
  await settle([[a, engineA], [b, engineB]]);
  const syncId = published("atc:r:").at(-1).v.p;
  await a.with(() => S().deleteProfile(work));
  await settle([[a, engineA], [b, engineB]]);
  await a.with(async () => {
    const back = engineA.addRemoteProfile(syncId);
    assert.ok(back, "Work is offered again and added back");
    await engineA.syncNow();
    assert.equal(config().rules[0].profileId, back, "the rule follows Work back");
    assert.equal(config().fallback.profileId, back, "so does Everything Else");
  });
  await settle([[a, engineA], [b, engineB]]);
  assert.ok(published("atc:").every((op) => op.v === null || op.v.p === syncId), "every Mac only ever sends Work's sync id");
  await b.with(() => {
    assert.equal(config().rules[0].profileId, named("Work"), "the other Mac still routes to its Work");
    assert.equal(config().fallback.profileId, named("Work"));
  });
});

test("a rule from a newer Ardia this version can't read is left alone, not deleted", async () => {
  folder.clear();
  const a = new Mac();
  const b = new Mac();
  const engineA = await import("./engine.ts?newerA");
  const engineB = await import("./engine.ts?newerB");
  await turnOn(a, engineA, () => air.addAirTrafficRule(draft({ from: slack })));
  await join(b, engineB);
  const scope = [...folder.values()].find((f) => JSON.parse(f.payload).ops?.some((op) => op.k.startsWith("atc:")))?.scope;
  assert.ok(scope);
  const future = { v: 1, kind: "log", device: "future", seq: 1, at: Date.now(), ops: [{ k: "atc:r:future", h: `${Date.now().toString(36).padStart(9, "0")}.0000.future`, v: { on: true, f: null, w: { kind: "moon" }, p: null, o: "tab", pos: "z" } }] };
  folder.set("future", { scope, payload: JSON.stringify(future) });
  await settle([[b, engineB], [a, engineA]], 3);
  await b.with(() => {
    assert.ok(engineB.appScopeRecords()["atc:r:future"]?.v, "the second Mac has the newer rule's record");
    assert.equal(config().rules.length, 1, "the unreadable rule isn't applied");
  });
  assert.ok(!published("atc:r:future").some((op) => op.v === null), "and no Mac deletes it");
});

test("turning off Settings sync stops sending rules", async () => {
  folder.clear();
  const a = new Mac();
  const engineA = await import("./engine.ts?offA");
  await turnOn(a, engineA, () => air.addAirTrafficRule(draft({ from: slack })));
  const before = published("atc:").length;
  assert.ok(before > 0);
  await a.with(async () => {
    engineA.setTypeSynced("settings", false);
    air.addAirTrafficRule(draft({ from: mail }));
    await engineA.syncNow();
  });
  assert.equal(published("atc:").length, before);
});
