import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  ACHIEVEMENT_DEFINITION_VERSION,
  ACHIEVEMENT_IDS,
  ACHIEVEMENT_POINTS,
  ACHIEVEMENT_REGISTRY,
  ACHIEVEMENT_REGISTRY_BY_ID,
  LEGACY_ACHIEVEMENT_IDS,
  evaluateAchievement,
  evaluateAchievements,
  getAchievementChain,
  getAchievementPoints,
  getAchievementRegistryErrors,
  getNextAchievementInChain,
  getPreviousAchievementInChain,
  isAchievementId,
} from "../Lib/achievementRegistry.ts";
import {
  getUnknownAchievementIds,
  normalizeAchievementGrantRecords,
  planAchievementReconciliation,
} from "../Lib/achievementPersistence.ts";
import {
  advanceNotificationQueue,
  createNotificationQueueItems,
  enqueueUniqueNotifications,
  selectAchievementNotificationBatch,
  shouldReconcileAchievementMutation,
} from "../Lib/achievementNotificationQueue.ts";
import {
  createEmptyAchievementSnapshot,
  normalizeAchievementSnapshot,
} from "../Lib/achievementSnapshot.ts";

const require = createRequire(import.meta.url);
const { parse: parseIcuMessage } = require("@formatjs/icu-messageformat-parser");

function createSnapshot(overrides = {}) {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    ascents: {
      records: 0,
      uniqueMountainIds: 0,
      summitElevationTotalM: 0,
      maximumSummitElevationM: 0,
      distinctCountryCodes: 0,
      altitudeZones: [],
      ascentsByYear: {},
      distinctActiveMonths: 0,
      distinctActiveYears: 0,
      calendarMonthsRepresented: 0,
      photoCount: 0,
      gpsLinkedCount: 0,
      ...overrides.ascents,
    },
    gps: {
      readyTrackCount: 0,
      totalDistanceM: 0,
      totalElevationGainM: 0,
      maximumElevationM: null,
      confirmedMountainCount: 0,
      ...overrides.gps,
    },
    planning: {
      favoriteCount: 0,
      ...overrides.planning,
    },
    ...(overrides.compatibility
      ? { compatibility: overrides.compatibility }
      : {}),
  };
}

function evaluationFor(id, snapshot) {
  const definition = ACHIEVEMENT_REGISTRY_BY_ID.get(id);
  assert.ok(definition, `Missing definition for ${id}`);
  return evaluateAchievement(definition, snapshot);
}

function testRegistryIntegrity() {
  assert.equal(ACHIEVEMENT_REGISTRY.length, 111);
  assert.equal(ACHIEVEMENT_IDS.length, 111);
  assert.deepEqual(getAchievementRegistryErrors(), []);
  assert.equal(new Set(ACHIEVEMENT_IDS).size, 111);
  assert.equal(new Set(ACHIEVEMENT_REGISTRY.map(({ id }) => id)).size, 111);
  assert.equal(
    new Set(ACHIEVEMENT_REGISTRY.map(({ translationKey }) => translationKey)).size,
    111,
  );

  for (const id of LEGACY_ACHIEVEMENT_IDS) {
    assert.ok(ACHIEVEMENT_REGISTRY_BY_ID.has(id), `Missing legacy ID ${id}`);
  }

  for (const definition of ACHIEVEMENT_REGISTRY) {
    assert.equal(definition.points, ACHIEVEMENT_POINTS[definition.rarity]);
    assert.equal(getAchievementPoints(definition.id), definition.points);
    assert.ok(Number.isFinite(definition.target) && definition.target > 0);
  }

  const summitChain = getAchievementChain("summit-explorer");
  assert.equal(summitChain.length, 10);
  assert.deepEqual(summitChain.map(({ tier }) => tier), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(getNextAchievementInChain("five-ascents")?.id, "ten-ascents");
  assert.equal(getPreviousAchievementInChain("five-ascents")?.id, "first-ascent");
  assert.equal(getPreviousAchievementInChain("first-ascent"), null);
  assert.equal(getNextAchievementInChain("summits-1000"), null);
}

function testEvaluator() {
  assert.equal(evaluationFor("first-ascent", createSnapshot()).unlocked, false);
  assert.equal(
    evaluationFor("first-ascent", createSnapshot({ ascents: { uniqueMountainIds: 1 } })).unlocked,
    true,
  );

  const belowFive = evaluationFor(
    "five-ascents",
    createSnapshot({ ascents: { uniqueMountainIds: 4 } }),
  );
  assert.equal(belowFive.unlocked, false);
  assert.equal(belowFive.progress, 0.8);
  assert.equal(
    evaluationFor("five-ascents", createSnapshot({ ascents: { uniqueMountainIds: 5 } })).unlocked,
    true,
  );
  const aboveFive = evaluationFor(
    "five-ascents",
    createSnapshot({ ascents: { uniqueMountainIds: 8 } }),
  );
  assert.equal(aboveFive.unlocked, true);
  assert.equal(aboveFive.progress, 1);

  assert.equal(
    evaluationFor("summits-100", createSnapshot({ ascents: { uniqueMountainIds: 100 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("summit-height-3000", createSnapshot({ ascents: { maximumSummitElevationM: 3000 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("countries-5", createSnapshot({ ascents: { distinctCountryCodes: 5 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("gps-distance-km-100", createSnapshot({ gps: { totalDistanceM: 100_000 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("gps-elevation-gain-50000", createSnapshot({ gps: { totalElevationGainM: 50_000 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("active-months-12", createSnapshot({ ascents: { distinctActiveMonths: 12 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("ascent-photos-10", createSnapshot({ ascents: { photoCount: 10 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("favorites-5", createSnapshot({ planning: { favoriteCount: 5 } })).unlocked,
    true,
  );
  assert.equal(
    evaluationFor(
      "summits-in-year-25",
      createSnapshot({ ascents: { ascentsByYear: { "2024": 17, "2025": 25 } } }),
    ).unlocked,
    true,
  );
  assert.equal(
    evaluationFor(
      "altitude-zone-2000-2499",
      createSnapshot({ ascents: { altitudeZones: ["2000-2499"] } }),
    ).unlocked,
    true,
  );
  assert.equal(
    evaluationFor("zugspitze", createSnapshot()).unlocked,
    false,
  );
  assert.equal(
    evaluationFor(
      "zugspitze",
      createSnapshot({ compatibility: { hasZugspitze: true } }),
    ).unlocked,
    true,
  );

  const nonFinite = evaluationFor(
    "first-ascent",
    createSnapshot({ ascents: { uniqueMountainIds: Number.NaN } }),
  );
  assert.equal(nonFinite.current, 0);
  assert.equal(nonFinite.progress, 0);

  const result = evaluateAchievements(
    createSnapshot({ ascents: { uniqueMountainIds: 1000 } }),
  );
  assert.equal(result.evaluations.length, 111);
  assert.ok(result.unlockedIds.includes("summits-1000"));
  assert.ok(Number.isFinite(result.unlockedPoints));
}

function testSnapshotNormalization() {
  const fallbackGeneratedAt = "2026-08-10T12:00:00.000Z";
  const empty = createEmptyAchievementSnapshot(fallbackGeneratedAt);

  assert.deepEqual(
    normalizeAchievementSnapshot(null, fallbackGeneratedAt),
    empty,
  );
  assert.deepEqual(
    normalizeAchievementSnapshot({}, fallbackGeneratedAt),
    empty,
  );
  assert.deepEqual(
    normalizeAchievementSnapshot(
      {
        generatedAt: "invalid",
        ascents: { records: 0 },
        gps: null,
      },
      fallbackGeneratedAt,
    ),
    empty,
  );

  const populated = normalizeAchievementSnapshot(
    {
      generatedAt: "2026-08-09T10:30:00+00:00",
      ascents: {
        records: 8,
        uniqueMountainIds: 7,
        summitElevationTotalM: 12345.5,
        maximumSummitElevationM: 2962,
        distinctCountryCodes: 3,
        altitudeZones: ["2500-2999", "invalid", "below-1000", "below-1000"],
        ascentsByYear: { "2024": 3, "2025": 5, invalid: 9, "2026": -1 },
        distinctActiveMonths: 6,
        distinctActiveYears: 2,
        calendarMonthsRepresented: 14,
        photoCount: 4,
        gpsLinkedCount: 3,
      },
      gps: {
        readyTrackCount: 5,
        totalDistanceM: 125000.25,
        totalElevationGainM: 8200,
        maximumElevationM: 3010,
        confirmedMountainCount: 3,
      },
      planning: { favoriteCount: 9 },
    },
    fallbackGeneratedAt,
  );

  assert.equal(populated.generatedAt, "2026-08-09T10:30:00+00:00");
  assert.equal(populated.ascents.records, 8);
  assert.deepEqual(populated.ascents.altitudeZones, ["below-1000", "2500-2999"]);
  assert.deepEqual(populated.ascents.ascentsByYear, { "2024": 3, "2025": 5 });
  assert.equal(populated.ascents.calendarMonthsRepresented, 12);
  assert.equal(populated.gps.totalDistanceM, 125000.25);
  assert.equal(populated.gps.maximumElevationM, 3010);

  const guarded = normalizeAchievementSnapshot(
    {
      gps: {
        readyTrackCount: -2,
        totalDistanceM: -50,
        totalElevationGainM: Number.NaN,
        maximumElevationM: -10,
      },
    },
    fallbackGeneratedAt,
  );

  assert.equal(guarded.gps.readyTrackCount, 0);
  assert.equal(guarded.gps.totalDistanceM, 0);
  assert.equal(guarded.gps.totalElevationGainM, 0);
  assert.equal(guarded.gps.maximumElevationM, 0);
  assert.ok(Number.isFinite(Date.parse(guarded.generatedAt)));

  console.log("Achievement snapshot normalization: passed");
}

async function testAchievementPersistence() {
  assert.equal(isAchievementId("first-ascent"), true);
  assert.equal(isAchievementId("not-an-achievement"), false);
  assert.deepEqual(
    getUnknownAchievementIds(
      ["first-ascent", "not-an-achievement"],
      isAchievementId,
    ),
    ["not-an-achievement"],
  );

  assert.deepEqual(planAchievementReconciliation([], []), []);
  assert.deepEqual(
    planAchievementReconciliation(["first-ascent"], []),
    ["first-ascent"],
  );
  assert.deepEqual(
    planAchievementReconciliation(
      ["first-ascent", "five-ascents", "five-ascents"],
      ["first-ascent"],
    ),
    ["five-ascents"],
  );
  assert.deepEqual(
    planAchievementReconciliation(
      ["first-ascent", "five-ascents"],
      ["first-ascent", "five-ascents"],
    ),
    [],
  );

  const firstPass = planAchievementReconciliation(
    ["first-ascent", "five-ascents"],
    [],
  );
  const secondPass = planAchievementReconciliation(
    ["first-ascent", "five-ascents"],
    firstPass,
  );
  assert.deepEqual(secondPass, []);

  const timestamp = "2026-08-10T15:00:00.000Z";
  const records = normalizeAchievementGrantRecords(
    [
      {
        achievement_id: "first-ascent",
        unlocked_at: timestamp,
        grant_source: "reconciliation",
        definition_version: ACHIEVEMENT_DEFINITION_VERSION,
        notified_at: null,
      },
      {
        achievement_id: "first-ascent",
        unlocked_at: timestamp,
        grant_source: "reconciliation",
        definition_version: ACHIEVEMENT_DEFINITION_VERSION,
        notified_at: timestamp,
      },
      {
        achievement_id: "unknown",
        unlocked_at: timestamp,
        grant_source: "reconciliation",
        definition_version: ACHIEVEMENT_DEFINITION_VERSION,
        notified_at: null,
      },
      {
        achievement_id: "five-ascents",
        unlocked_at: "invalid",
        grant_source: "invalid",
        definition_version: 0,
        notified_at: "invalid",
      },
    ],
    isAchievementId,
  );

  assert.deepEqual(records, [
    {
      achievementId: "first-ascent",
      unlockedAt: timestamp,
      grantSource: "reconciliation",
      definitionVersion: 2,
      notifiedAt: null,
    },
  ]);

  for (const legacyId of LEGACY_ACHIEVEMENT_IDS) {
    assert.equal(isAchievementId(legacyId), true);
  }

  const sql = await readFile(
    new URL("../database/reconcile_user_achievements.sql", import.meta.url),
    "utf8",
  );
  const allowlist = sql
    .slice(sql.indexOf("select candidate = any"), sql.indexOf("]::text[]"))
    .match(/'([^']+)'/g)
    ?.map((value) => value.slice(1, -1)) ?? [];

  assert.deepEqual([...allowlist].sort(), [...ACHIEVEMENT_IDS].sort());
  assert.equal(new Set(allowlist).size, 111);

  console.log("Achievement persistence and reconciliation: passed");
}

function testAchievementNotifications() {
  const candidate = (id, chainId, tier) => {
    const definition = ACHIEVEMENT_REGISTRY_BY_ID.get(id);
    assert.ok(definition);
    return {
      id,
      icon: definition.icon,
      translationKey: definition.translationKey,
      target: definition.target,
      chainId,
      tier,
      durable: true,
    };
  };

  const first = candidate("first-ascent", "summit-explorer", 1);
  const fifth = candidate("five-ascents", "summit-explorer", 2);
  const tenth = candidate("ten-ascents", "summit-explorer", 3);
  const country = candidate("countries-2", "countries", 1);
  const gps = candidate("gps-tracks-1", "gps-tracks", 1);

  const batch = selectAchievementNotificationBatch([
    first,
    fifth,
    tenth,
    country,
    gps,
  ]);
  assert.equal(batch.details.length, 2);
  assert.ok(batch.details.some(({ id }) => id === "ten-ascents"));
  assert.ok(!batch.details.some(({ id }) => id === "first-ascent"));
  assert.equal(batch.summaryCount, 3);

  const incoming = createNotificationQueueItems([first, country, gps], "1");
  assert.deepEqual(incoming.map(({ kind }) => kind), ["achievement", "achievement", "summary"]);
  let queue = enqueueUniqueNotifications([], incoming);
  queue = enqueueUniqueNotifications(queue, [incoming[0]]);
  assert.equal(queue.length, 3);
  assert.equal(queue[0].kind, "achievement");
  queue = advanceNotificationQueue(queue);
  assert.equal(queue.length, 2);
  const afterTimeout = advanceNotificationQueue(queue);
  assert.equal(afterTimeout.length, 1);

  const notified = new Set();
  const pendingId = first.id;
  assert.equal(notified.has(pendingId), false);
  notified.add(pendingId);
  assert.equal(notified.has(pendingId), true);
  assert.deepEqual([pendingId].filter((id) => !notified.has(id)), []);

  assert.equal(shouldReconcileAchievementMutation({ event: "ascent-created", succeeded: true }), true);
  assert.equal(shouldReconcileAchievementMutation({ event: "ascent-created", succeeded: false }), false);
  assert.equal(shouldReconcileAchievementMutation({ event: "photo-changed", succeeded: true }), true);
  assert.equal(shouldReconcileAchievementMutation({ event: "favorite-changed", succeeded: true }), true);
  assert.equal(shouldReconcileAchievementMutation({ event: "gps-ready", succeeded: true, gpsStatus: "pending" }), false);
  assert.equal(shouldReconcileAchievementMutation({ event: "gps-ready", succeeded: true, gpsStatus: "ready" }), true);

  const persisted = new Set(["first-ascent"]);
  const lowerProgressSnapshot = createSnapshot();
  assert.equal(evaluationFor("first-ascent", lowerProgressSnapshot).unlocked, false);
  assert.equal(persisted.has("first-ascent"), true);

  console.log("Achievement notification queue and trigger planning: passed");
}

function getShape(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, getShape(value[key])]),
    );
  }

  return typeof value;
}

function visitStrings(value, label) {
  if (typeof value === "string") {
    assert.ok(value.trim(), `Empty translation at ${label}`);
    parseIcuMessage(value);
    return;
  }

  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const [key, child] of Object.entries(value)) {
    visitStrings(child, `${label}.${key}`);
  }
}

async function testTranslationCoverage() {
  const locales = ["de", "en", "ru"];
  const catalogs = await Promise.all(
    locales.map(async (locale) =>
      JSON.parse(
        await readFile(
          new URL(`../messages/${locale}/achievements.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  );

  const expectedShape = getShape(catalogs[0]);
  for (let index = 0; index < catalogs.length; index += 1) {
    assert.deepEqual(getShape(catalogs[index]), expectedShape, `${locales[index]} structure differs`);
    visitStrings(catalogs[index], locales[index]);

    const definitions = catalogs[index].Achievements.Definitions;
    const expectedKeys = ACHIEVEMENT_REGISTRY.map(({ translationKey }) => translationKey).sort();
    assert.deepEqual(Object.keys(definitions).sort(), expectedKeys);

    for (const translationKey of expectedKeys) {
      assert.equal(typeof definitions[translationKey].title, "string");
      assert.equal(typeof definitions[translationKey].description, "string");
      assert.equal(typeof definitions[translationKey].unlockedDescription, "string");
    }
  }
}

testRegistryIntegrity();
testEvaluator();
testSnapshotNormalization();
await testAchievementPersistence();
testAchievementNotifications();
await testTranslationCoverage();

console.log("Achievement registry integrity: passed (111 definitions)");
console.log("Achievement evaluator thresholds: passed");
console.log("Achievement translations: passed (de/en/ru, 111 definitions each)");
