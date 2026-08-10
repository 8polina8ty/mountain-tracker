import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AchievementSnapshot,
  AltitudeZone,
} from "./achievementRegistry";

type JsonRecord = Record<string, unknown>;

const SNAPSHOT_ALTITUDE_ZONES = [
  "below-1000",
  "1000-1499",
  "1500-1999",
  "2000-2499",
  "2500-2999",
  "3000-3499",
  "3500-plus",
] as const satisfies readonly AltitudeZone[];

const ALTITUDE_ZONE_SET = new Set<string>(SNAPSHOT_ALTITUDE_ZONES);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(parent: JsonRecord, key: string): JsonRecord {
  const value = parent[key];
  return isRecord(value) ? value : {};
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function nonNegativeInteger(value: unknown): number {
  return Math.trunc(nonNegativeNumber(value));
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : nonNegativeNumber(value);
}

function normalizeGeneratedAt(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : fallback;
}

function normalizeAltitudeZones(value: unknown): AltitudeZone[] {
  if (!Array.isArray(value)) return [];

  const received = new Set(
    value.filter(
      (zone): zone is AltitudeZone =>
        typeof zone === "string" && ALTITUDE_ZONE_SET.has(zone),
    ),
  );

  return SNAPSHOT_ALTITUDE_ZONES.filter((zone) => received.has(zone));
}

function normalizeAscentsByYear(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).flatMap(([year, valueForYear]) => {
      const count = nonNegativeInteger(valueForYear);
      return /^\d{4}$/.test(year) && count > 0 ? [[year, count]] : [];
    }),
  );
}

export function createEmptyAchievementSnapshot(
  generatedAt = new Date().toISOString(),
): AchievementSnapshot {
  return {
    generatedAt,
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
    },
    gps: {
      readyTrackCount: 0,
      totalDistanceM: 0,
      totalElevationGainM: 0,
      maximumElevationM: null,
      confirmedMountainCount: 0,
    },
    planning: {
      favoriteCount: 0,
    },
  };
}

/**
 * Treats the RPC boundary as untrusted input and returns the exact v2 contract.
 * Invalid counters become zero; the nullable GPS maximum remains null.
 */
export function normalizeAchievementSnapshot(
  value: unknown,
  fallbackGeneratedAt = new Date().toISOString(),
): AchievementSnapshot {
  if (!isRecord(value)) return createEmptyAchievementSnapshot(fallbackGeneratedAt);

  const ascents = readRecord(value, "ascents");
  const gps = readRecord(value, "gps");
  const planning = readRecord(value, "planning");

  return {
    generatedAt: normalizeGeneratedAt(value.generatedAt, fallbackGeneratedAt),
    ascents: {
      records: nonNegativeInteger(ascents.records),
      uniqueMountainIds: nonNegativeInteger(ascents.uniqueMountainIds),
      summitElevationTotalM: nonNegativeNumber(ascents.summitElevationTotalM),
      maximumSummitElevationM: nonNegativeNumber(
        ascents.maximumSummitElevationM,
      ),
      distinctCountryCodes: nonNegativeInteger(ascents.distinctCountryCodes),
      altitudeZones: normalizeAltitudeZones(ascents.altitudeZones),
      ascentsByYear: normalizeAscentsByYear(ascents.ascentsByYear),
      distinctActiveMonths: nonNegativeInteger(ascents.distinctActiveMonths),
      distinctActiveYears: nonNegativeInteger(ascents.distinctActiveYears),
      calendarMonthsRepresented: Math.min(
        12,
        nonNegativeInteger(ascents.calendarMonthsRepresented),
      ),
      photoCount: nonNegativeInteger(ascents.photoCount),
      gpsLinkedCount: nonNegativeInteger(ascents.gpsLinkedCount),
    },
    gps: {
      readyTrackCount: nonNegativeInteger(gps.readyTrackCount),
      totalDistanceM: nonNegativeNumber(gps.totalDistanceM),
      totalElevationGainM: nonNegativeNumber(gps.totalElevationGainM),
      maximumElevationM: nullableNonNegativeNumber(gps.maximumElevationM),
      confirmedMountainCount: nonNegativeInteger(gps.confirmedMountainCount),
    },
    planning: {
      favoriteCount: nonNegativeInteger(planning.favoriteCount),
    },
  };
}

/** Server-side entry point. The RPC derives its subject exclusively from auth.uid(). */
export async function getAchievementSnapshot(
  supabase: SupabaseClient,
): Promise<AchievementSnapshot> {
  const { data, error } = await supabase.rpc("get_achievement_snapshot");

  if (error) {
    throw new Error(`Unable to load achievement snapshot: ${error.message}`, {
      cause: error,
    });
  }

  return normalizeAchievementSnapshot(data);
}
