export const ACHIEVEMENT_CATEGORIES = [
  "summits",
  "altitude",
  "geography",
  "gps",
  "participation",
  "photography",
  "planning",
] as const;

export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

export const ACHIEVEMENT_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
] as const;

export type AchievementRarity = (typeof ACHIEVEMENT_RARITIES)[number];

export const ACHIEVEMENT_POINTS: Record<AchievementRarity, number> = {
  common: 10,
  uncommon: 25,
  rare: 50,
  epic: 100,
  legendary: 250,
};

export const ALTITUDE_ZONES = [
  "below-1000",
  "1000-1499",
  "1500-1999",
  "2000-2499",
  "2500-2999",
  "3000-3499",
  "3500-plus",
] as const;

export type AltitudeZone = (typeof ALTITUDE_ZONES)[number];

export const ACHIEVEMENT_IDS = [
  "first-ascent",
  "five-ascents",
  "ten-ascents",
  "twenty-five-ascents",
  "fifty-ascents",
  "summits-100",
  "summits-250",
  "summits-500",
  "summits-750",
  "summits-1000",
  "summit-elevation-total-1000",
  "summit-elevation-total-5000",
  "ten-thousand-height",
  "summit-elevation-total-25000",
  "summit-elevation-total-50000",
  "summit-elevation-total-100000",
  "summit-elevation-total-250000",
  "summit-elevation-total-500000",
  "summit-elevation-total-750000",
  "summit-elevation-total-1000000",
  "summit-height-500",
  "summit-height-1000",
  "summit-height-1500",
  "above-clouds",
  "summit-height-2500",
  "summit-height-3000",
  "summit-height-3500",
  "summit-height-4000",
  "altitude-zone-below-1000",
  "altitude-zone-1000-1499",
  "altitude-zone-1500-1999",
  "altitude-zone-2000-2499",
  "altitude-zone-2500-2999",
  "altitude-zone-3000-3499",
  "altitude-zone-3500-plus",
  "altitude-zones-3",
  "altitude-zones-5",
  "altitude-zones-7",
  "countries-2",
  "countries-3",
  "countries-5",
  "countries-10",
  "countries-15",
  "countries-20",
  "countries-30",
  "gps-tracks-1",
  "gps-tracks-5",
  "gps-tracks-10",
  "gps-tracks-25",
  "gps-tracks-50",
  "gps-tracks-100",
  "gps-tracks-250",
  "gps-tracks-500",
  "gps-distance-km-10",
  "gps-distance-km-50",
  "gps-distance-km-100",
  "gps-distance-km-250",
  "gps-distance-km-500",
  "gps-distance-km-1000",
  "gps-distance-km-2500",
  "gps-distance-km-5000",
  "gps-distance-km-10000",
  "gps-elevation-gain-1000",
  "gps-elevation-gain-5000",
  "gps-elevation-gain-10000",
  "gps-elevation-gain-25000",
  "gps-elevation-gain-50000",
  "gps-elevation-gain-100000",
  "gps-elevation-gain-250000",
  "gps-elevation-gain-500000",
  "gps-elevation-gain-1000000",
  "gps-linked-summits-1",
  "gps-linked-summits-5",
  "gps-linked-summits-10",
  "gps-linked-summits-25",
  "gps-linked-summits-50",
  "gps-linked-summits-100",
  "gps-linked-summits-250",
  "gps-linked-summits-500",
  "active-months-1",
  "active-months-3",
  "active-months-6",
  "active-months-12",
  "active-months-24",
  "active-months-36",
  "active-months-60",
  "active-months-120",
  "active-years-2",
  "active-years-3",
  "active-years-5",
  "active-years-10",
  "active-years-15",
  "summits-in-year-5",
  "summits-in-year-10",
  "summits-in-year-25",
  "summits-in-year-50",
  "calendar-months-represented-3",
  "calendar-months-represented-6",
  "calendar-months-represented-9",
  "calendar-months-represented-12",
  "ascent-photos-1",
  "ascent-photos-5",
  "ascent-photos-10",
  "ascent-photos-25",
  "ascent-photos-50",
  "ascent-photos-100",
  "favorites-1",
  "favorites-5",
  "favorites-10",
  "favorites-25",
  "zugspitze",
] as const;

export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];

/** Audit version for the approved 111-definition Achievement System v2 registry. */
export const ACHIEVEMENT_DEFINITION_VERSION = 2;

const ACHIEVEMENT_ID_SET = new Set<string>(ACHIEVEMENT_IDS);

export function isAchievementId(value: unknown): value is AchievementId {
  return typeof value === "string" && ACHIEVEMENT_ID_SET.has(value);
}

export const LEGACY_ACHIEVEMENT_IDS = [
  "first-ascent",
  "five-ascents",
  "ten-ascents",
  "twenty-five-ascents",
  "fifty-ascents",
  "above-clouds",
  "zugspitze",
  "ten-thousand-height",
] as const satisfies readonly AchievementId[];

export type AchievementMetric =
  | "uniqueSummits"
  | "summitElevationTotalM"
  | "maximumSummitElevationM"
  | "altitudeZoneBelow1000"
  | "altitudeZone1000To1499"
  | "altitudeZone1500To1999"
  | "altitudeZone2000To2499"
  | "altitudeZone2500To2999"
  | "altitudeZone3000To3499"
  | "altitudeZone3500Plus"
  | "altitudeZoneCount"
  | "countries"
  | "gpsTrackCount"
  | "gpsDistanceM"
  | "gpsElevationGainM"
  | "gpsLinkedSummits"
  | "activeMonths"
  | "activeYears"
  | "maximumSummitsInYear"
  | "calendarMonthsRepresented"
  | "photoCount"
  | "favoriteCount"
  | "legacyZugspitze";

export type AchievementComparator = "gte" | "contains";
export type AchievementPublicVisibility = "safe" | "private-by-default";
export type AchievementIntegrity =
  | "standard"
  | "user-reported"
  | "gps-derived";

export type AchievementDefinition = {
  id: AchievementId;
  translationKey: string;
  category: AchievementCategory;
  metric: AchievementMetric;
  target: number;
  comparator: AchievementComparator;
  chainId?: string;
  tier?: number;
  rarity: AchievementRarity;
  points: number;
  icon: string;
  publicVisibility: AchievementPublicVisibility;
  integrity: AchievementIntegrity;
};

export type AchievementSnapshot = {
  generatedAt: string;
  ascents: {
    records: number;
    uniqueMountainIds: number;
    /** Sum of the elevations of the user's distinct recorded summits. */
    summitElevationTotalM: number;
    maximumSummitElevationM: number;
    distinctCountryCodes: number;
    altitudeZones: AltitudeZone[];
    ascentsByYear: Record<string, number>;
    distinctActiveMonths: number;
    distinctActiveYears: number;
    calendarMonthsRepresented: number;
    photoCount: number;
    gpsLinkedCount: number;
  };
  gps: {
    readyTrackCount: number;
    totalDistanceM: number;
    /** Actual cumulative ascent gain calculated from ready GPS tracks. */
    totalElevationGainM: number;
    maximumElevationM: number | null;
    confirmedMountainCount: number;
  };
  planning: {
    favoriteCount: number;
  };
  /** Temporary compatibility input until named summit membership joins the snapshot. */
  compatibility?: {
    hasZugspitze: boolean;
  };
};

export type AchievementEvaluation = {
  achievementId: AchievementId;
  current: number;
  target: number;
  progress: number;
  unlocked: boolean;
};

export type AchievementEvaluationResult = {
  evaluations: AchievementEvaluation[];
  unlockedIds: AchievementId[];
  unlockedPoints: number;
};

type DefinitionOptions = Omit<
  AchievementDefinition,
  "comparator" | "points"
> & {
  comparator?: AchievementComparator;
};

function defineAchievement(options: DefinitionOptions): AchievementDefinition {
  return {
    ...options,
    comparator: options.comparator ?? "gte",
    points: ACHIEVEMENT_POINTS[options.rarity],
  };
}

type ThresholdEntry = readonly [
  id: AchievementId,
  translationKey: string,
  target: number,
  rarity: AchievementRarity,
];

type ChainOptions = {
  chainId: string;
  category: AchievementCategory;
  metric: AchievementMetric;
  icon: string;
  publicVisibility: AchievementPublicVisibility;
  integrity: AchievementIntegrity;
};

function defineThresholdChain(
  options: ChainOptions,
  entries: readonly ThresholdEntry[],
): AchievementDefinition[] {
  return entries.map(([id, translationKey, target, rarity], index) =>
    defineAchievement({
      ...options,
      id,
      translationKey,
      target,
      rarity,
      tier: index + 1,
    }),
  );
}

const summitDefinitions = defineThresholdChain(
  { chainId: "summit-explorer", category: "summits", metric: "uniqueSummits", icon: "\u{1F97E}", publicVisibility: "safe", integrity: "user-reported" },
  [
    ["first-ascent", "firstAscent", 1, "common"],
    ["five-ascents", "fiveAscents", 5, "common"],
    ["ten-ascents", "tenAscents", 10, "uncommon"],
    ["twenty-five-ascents", "twentyFiveAscents", 25, "uncommon"],
    ["fifty-ascents", "fiftyAscents", 50, "rare"],
    ["summits-100", "summits100", 100, "rare"],
    ["summits-250", "summits250", 250, "epic"],
    ["summits-500", "summits500", 500, "epic"],
    ["summits-750", "summits750", 750, "legendary"],
    ["summits-1000", "summits1000", 1000, "legendary"],
  ],
);

const summitElevationDefinitions = defineThresholdChain(
  { chainId: "summit-elevation-total", category: "altitude", metric: "summitElevationTotalM", icon: "\u{2197}", publicVisibility: "safe", integrity: "user-reported" },
  [
    ["summit-elevation-total-1000", "summitElevationTotal1000", 1_000, "common"],
    ["summit-elevation-total-5000", "summitElevationTotal5000", 5_000, "common"],
    ["ten-thousand-height", "tenThousandHeight", 10_000, "uncommon"],
    ["summit-elevation-total-25000", "summitElevationTotal25000", 25_000, "uncommon"],
    ["summit-elevation-total-50000", "summitElevationTotal50000", 50_000, "rare"],
    ["summit-elevation-total-100000", "summitElevationTotal100000", 100_000, "rare"],
    ["summit-elevation-total-250000", "summitElevationTotal250000", 250_000, "epic"],
    ["summit-elevation-total-500000", "summitElevationTotal500000", 500_000, "epic"],
    ["summit-elevation-total-750000", "summitElevationTotal750000", 750_000, "legendary"],
    ["summit-elevation-total-1000000", "summitElevationTotal1000000", 1_000_000, "legendary"],
  ],
);

const highestSummitDefinitions = defineThresholdChain(
  { chainId: "highest-summit", category: "altitude", metric: "maximumSummitElevationM", icon: "\u{25B3}", publicVisibility: "safe", integrity: "user-reported" },
  [
    ["summit-height-500", "summitHeight500", 500, "common"],
    ["summit-height-1000", "summitHeight1000", 1_000, "common"],
    ["summit-height-1500", "summitHeight1500", 1_500, "uncommon"],
    ["above-clouds", "aboveClouds", 2_000, "uncommon"],
    ["summit-height-2500", "summitHeight2500", 2_500, "rare"],
    ["summit-height-3000", "summitHeight3000", 3_000, "rare"],
    ["summit-height-3500", "summitHeight3500", 3_500, "epic"],
    ["summit-height-4000", "summitHeight4000", 4_000, "epic"],
  ],
);

const altitudeZoneDefinitions: AchievementDefinition[] = [
  ["altitude-zone-below-1000", "altitudeZoneBelow1000", "altitudeZoneBelow1000", "common"],
  ["altitude-zone-1000-1499", "altitudeZone1000To1499", "altitudeZone1000To1499", "common"],
  ["altitude-zone-1500-1999", "altitudeZone1500To1999", "altitudeZone1500To1999", "common"],
  ["altitude-zone-2000-2499", "altitudeZone2000To2499", "altitudeZone2000To2499", "uncommon"],
  ["altitude-zone-2500-2999", "altitudeZone2500To2999", "altitudeZone2500To2999", "uncommon"],
  ["altitude-zone-3000-3499", "altitudeZone3000To3499", "altitudeZone3000To3499", "rare"],
  ["altitude-zone-3500-plus", "altitudeZone3500Plus", "altitudeZone3500Plus", "rare"],
].map(([id, translationKey, metric, rarity], index) =>
  defineAchievement({
    id: id as AchievementId,
    translationKey,
    category: "altitude",
    metric: metric as AchievementMetric,
    target: 1,
    chainId: "altitude-zones",
    tier: index + 1,
    rarity: rarity as AchievementRarity,
    icon: "\u{25CE}",
    publicVisibility: "safe",
    integrity: "user-reported",
  }),
);

altitudeZoneDefinitions.push(
  ...defineThresholdChain(
    { chainId: "altitude-zones", category: "altitude", metric: "altitudeZoneCount", icon: "\u{25CE}", publicVisibility: "safe", integrity: "user-reported" },
    [
      ["altitude-zones-3", "altitudeZones3", 3, "uncommon"],
      ["altitude-zones-5", "altitudeZones5", 5, "rare"],
      ["altitude-zones-7", "altitudeZones7", 7, "epic"],
    ],
  ).map((definition, index) => ({ ...definition, tier: index + 8 })),
);

const countryDefinitions = defineThresholdChain(
  { chainId: "countries", category: "geography", metric: "countries", icon: "\u{2316}", publicVisibility: "private-by-default", integrity: "user-reported" },
  [
    ["countries-2", "countries2", 2, "uncommon"],
    ["countries-3", "countries3", 3, "uncommon"],
    ["countries-5", "countries5", 5, "rare"],
    ["countries-10", "countries10", 10, "rare"],
    ["countries-15", "countries15", 15, "epic"],
    ["countries-20", "countries20", 20, "epic"],
    ["countries-30", "countries30", 30, "legendary"],
  ],
);

const gpsTrackDefinitions = defineThresholdChain(
  { chainId: "gps-tracks", category: "gps", metric: "gpsTrackCount", icon: "\u{2313}", publicVisibility: "private-by-default", integrity: "gps-derived" },
  [
    ["gps-tracks-1", "gpsTracks1", 1, "common"], ["gps-tracks-5", "gpsTracks5", 5, "common"],
    ["gps-tracks-10", "gpsTracks10", 10, "uncommon"], ["gps-tracks-25", "gpsTracks25", 25, "uncommon"],
    ["gps-tracks-50", "gpsTracks50", 50, "rare"], ["gps-tracks-100", "gpsTracks100", 100, "rare"],
    ["gps-tracks-250", "gpsTracks250", 250, "epic"], ["gps-tracks-500", "gpsTracks500", 500, "legendary"],
  ],
);

const gpsDistanceDefinitions = defineThresholdChain(
  { chainId: "gps-distance", category: "gps", metric: "gpsDistanceM", icon: "\u{223F}", publicVisibility: "private-by-default", integrity: "gps-derived" },
  [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000].map((kilometers, index) => [
    `gps-distance-km-${kilometers}` as AchievementId,
    `gpsDistanceKm${kilometers}`,
    kilometers * 1_000,
    (["common", "common", "uncommon", "uncommon", "rare", "rare", "epic", "epic", "legendary"] as const)[index],
  ]),
);

const gpsElevationGainDefinitions = defineThresholdChain(
  { chainId: "gps-elevation-gain", category: "gps", metric: "gpsElevationGainM", icon: "\u{2191}", publicVisibility: "private-by-default", integrity: "gps-derived" },
  [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000].map((target, index) => [
    `gps-elevation-gain-${target}` as AchievementId,
    `gpsElevationGain${target}`,
    target,
    (["common", "common", "uncommon", "uncommon", "rare", "rare", "epic", "epic", "legendary"] as const)[index],
  ]),
);

const gpsLinkedDefinitions = defineThresholdChain(
  { chainId: "gps-linked-summits", category: "gps", metric: "gpsLinkedSummits", icon: "\u{2316}", publicVisibility: "private-by-default", integrity: "gps-derived" },
  [1, 5, 10, 25, 50, 100, 250, 500].map((target, index) => [
    `gps-linked-summits-${target}` as AchievementId,
    `gpsLinkedSummits${target}`,
    target,
    (["common", "common", "uncommon", "uncommon", "rare", "rare", "epic", "legendary"] as const)[index],
  ]),
);

const activeMonthDefinitions = defineThresholdChain(
  { chainId: "active-months", category: "participation", metric: "activeMonths", icon: "\u{25A6}", publicVisibility: "safe", integrity: "user-reported" },
  [1, 3, 6, 12, 24, 36, 60, 120].map((target, index) => [
    `active-months-${target}` as AchievementId,
    `activeMonths${target}`,
    target,
    (["common", "common", "uncommon", "uncommon", "rare", "rare", "epic", "legendary"] as const)[index],
  ]),
);

const activeYearDefinitions = defineThresholdChain(
  { chainId: "active-years", category: "participation", metric: "activeYears", icon: "\u{25A6}", publicVisibility: "safe", integrity: "user-reported" },
  [
    ["active-years-2", "activeYears2", 2, "uncommon"],
    ["active-years-3", "activeYears3", 3, "uncommon"],
    ["active-years-5", "activeYears5", 5, "rare"],
    ["active-years-10", "activeYears10", 10, "epic"],
    ["active-years-15", "activeYears15", 15, "legendary"],
  ],
);

const summitsInYearDefinitions = defineThresholdChain(
  { chainId: "summits-in-year", category: "participation", metric: "maximumSummitsInYear", icon: "\u{25A6}", publicVisibility: "safe", integrity: "user-reported" },
  [
    ["summits-in-year-5", "summitsInYear5", 5, "common"],
    ["summits-in-year-10", "summitsInYear10", 10, "uncommon"],
    ["summits-in-year-25", "summitsInYear25", 25, "rare"],
    ["summits-in-year-50", "summitsInYear50", 50, "epic"],
  ],
);

const calendarDiversityDefinitions = defineThresholdChain(
  { chainId: "calendar-diversity", category: "participation", metric: "calendarMonthsRepresented", icon: "\u{25A6}", publicVisibility: "safe", integrity: "user-reported" },
  [
    ["calendar-months-represented-3", "calendarMonthsRepresented3", 3, "common"],
    ["calendar-months-represented-6", "calendarMonthsRepresented6", 6, "uncommon"],
    ["calendar-months-represented-9", "calendarMonthsRepresented9", 9, "rare"],
    ["calendar-months-represented-12", "calendarMonthsRepresented12", 12, "epic"],
  ],
);

const photoDefinitions = defineThresholdChain(
  { chainId: "ascent-photos", category: "photography", metric: "photoCount", icon: "\u{25A3}", publicVisibility: "private-by-default", integrity: "user-reported" },
  [
    ["ascent-photos-1", "ascentPhotos1", 1, "common"], ["ascent-photos-5", "ascentPhotos5", 5, "common"],
    ["ascent-photos-10", "ascentPhotos10", 10, "uncommon"], ["ascent-photos-25", "ascentPhotos25", 25, "uncommon"],
    ["ascent-photos-50", "ascentPhotos50", 50, "rare"], ["ascent-photos-100", "ascentPhotos100", 100, "rare"],
  ],
);

const favoriteDefinitions = defineThresholdChain(
  { chainId: "favorites", category: "planning", metric: "favoriteCount", icon: "\u{2606}", publicVisibility: "safe", integrity: "standard" },
  [
    ["favorites-1", "favorites1", 1, "common"],
    ["favorites-5", "favorites5", 5, "common"],
    ["favorites-10", "favorites10", 10, "uncommon"],
    ["favorites-25", "favorites25", 25, "uncommon"],
  ],
);

const zugspitzeDefinition = defineAchievement({
  id: "zugspitze",
  translationKey: "zugspitze",
  category: "geography",
  metric: "legacyZugspitze",
  target: 1,
  rarity: "uncommon",
  icon: "\u{1F1E9}\u{1F1EA}",
  publicVisibility: "safe",
  integrity: "user-reported",
});

export const ACHIEVEMENT_REGISTRY: readonly AchievementDefinition[] = [
  ...summitDefinitions,
  ...summitElevationDefinitions,
  ...highestSummitDefinitions,
  ...altitudeZoneDefinitions,
  ...countryDefinitions,
  ...gpsTrackDefinitions,
  ...gpsDistanceDefinitions,
  ...gpsElevationGainDefinitions,
  ...gpsLinkedDefinitions,
  ...activeMonthDefinitions,
  ...activeYearDefinitions,
  ...summitsInYearDefinitions,
  ...calendarDiversityDefinitions,
  ...photoDefinitions,
  ...favoriteDefinitions,
  zugspitzeDefinition,
];

export const ACHIEVEMENT_REGISTRY_BY_ID = new Map(
  ACHIEVEMENT_REGISTRY.map((definition) => [definition.id, definition]),
);

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveAchievementMetric(
  metric: AchievementMetric,
  snapshot: AchievementSnapshot,
): number {
  const zones = new Set(snapshot.ascents.altitudeZones);

  switch (metric) {
    case "uniqueSummits": return finiteNonNegative(snapshot.ascents.uniqueMountainIds);
    case "summitElevationTotalM": return finiteNonNegative(snapshot.ascents.summitElevationTotalM);
    case "maximumSummitElevationM": return finiteNonNegative(snapshot.ascents.maximumSummitElevationM);
    case "altitudeZoneBelow1000": return zones.has("below-1000") ? 1 : 0;
    case "altitudeZone1000To1499": return zones.has("1000-1499") ? 1 : 0;
    case "altitudeZone1500To1999": return zones.has("1500-1999") ? 1 : 0;
    case "altitudeZone2000To2499": return zones.has("2000-2499") ? 1 : 0;
    case "altitudeZone2500To2999": return zones.has("2500-2999") ? 1 : 0;
    case "altitudeZone3000To3499": return zones.has("3000-3499") ? 1 : 0;
    case "altitudeZone3500Plus": return zones.has("3500-plus") ? 1 : 0;
    case "altitudeZoneCount": return zones.size;
    case "countries": return finiteNonNegative(snapshot.ascents.distinctCountryCodes);
    case "gpsTrackCount": return finiteNonNegative(snapshot.gps.readyTrackCount);
    case "gpsDistanceM": return finiteNonNegative(snapshot.gps.totalDistanceM);
    case "gpsElevationGainM": return finiteNonNegative(snapshot.gps.totalElevationGainM);
    case "gpsLinkedSummits": return finiteNonNegative(snapshot.ascents.gpsLinkedCount);
    case "activeMonths": return finiteNonNegative(snapshot.ascents.distinctActiveMonths);
    case "activeYears": return finiteNonNegative(snapshot.ascents.distinctActiveYears);
    case "maximumSummitsInYear": return Math.max(0, ...Object.values(snapshot.ascents.ascentsByYear).map(finiteNonNegative));
    case "calendarMonthsRepresented": return finiteNonNegative(snapshot.ascents.calendarMonthsRepresented);
    case "photoCount": return finiteNonNegative(snapshot.ascents.photoCount);
    case "favoriteCount": return finiteNonNegative(snapshot.planning.favoriteCount);
    case "legacyZugspitze": return snapshot.compatibility?.hasZugspitze ? 1 : 0;
  }
}

export function evaluateAchievement(
  definition: AchievementDefinition,
  snapshot: AchievementSnapshot,
): AchievementEvaluation {
  const current = finiteNonNegative(resolveAchievementMetric(definition.metric, snapshot));
  const target = Number.isFinite(definition.target) && definition.target > 0 ? definition.target : 1;
  const progress = Math.min(Math.max(current / target, 0), 1);

  return {
    achievementId: definition.id,
    current,
    target,
    progress,
    unlocked: definition.comparator === "gte" && current >= target,
  };
}

export function evaluateAchievements(
  snapshot: AchievementSnapshot,
  registry: readonly AchievementDefinition[] = ACHIEVEMENT_REGISTRY,
): AchievementEvaluationResult {
  const evaluations = registry.map((definition) =>
    evaluateAchievement(definition, snapshot),
  );
  const unlockedIds = evaluations
    .filter((evaluation) => evaluation.unlocked)
    .map((evaluation) => evaluation.achievementId);

  return {
    evaluations,
    unlockedIds,
    unlockedPoints: unlockedIds.reduce(
      (total, id) => total + getAchievementPoints(id),
      0,
    ),
  };
}

export function getAchievementChain(chainId: string): AchievementDefinition[] {
  return ACHIEVEMENT_REGISTRY
    .filter((definition) => definition.chainId === chainId)
    .sort((first, second) => (first.tier ?? 0) - (second.tier ?? 0));
}

export function getNextAchievementInChain(
  achievementId: AchievementId,
): AchievementDefinition | null {
  const definition = ACHIEVEMENT_REGISTRY_BY_ID.get(achievementId);
  if (!definition?.chainId) return null;
  const chain = getAchievementChain(definition.chainId);
  return chain[chain.findIndex((item) => item.id === achievementId) + 1] ?? null;
}

export function getPreviousAchievementInChain(
  achievementId: AchievementId,
): AchievementDefinition | null {
  const definition = ACHIEVEMENT_REGISTRY_BY_ID.get(achievementId);
  if (!definition?.chainId) return null;
  const chain = getAchievementChain(definition.chainId);
  const index = chain.findIndex((item) => item.id === achievementId);
  return index > 0 ? chain[index - 1] : null;
}

export function getAchievementPoints(achievementId: AchievementId): number {
  return ACHIEVEMENT_REGISTRY_BY_ID.get(achievementId)?.points ?? 0;
}

export function getAchievementRegistryErrors(): string[] {
  const errors: string[] = [];
  const ids = new Set<AchievementId>();
  const translationKeys = new Set<string>();
  const chainTiers = new Set<string>();

  if (ACHIEVEMENT_REGISTRY.length !== 111) errors.push(`Expected 111 definitions, received ${ACHIEVEMENT_REGISTRY.length}.`);

  for (const definition of ACHIEVEMENT_REGISTRY) {
    if (ids.has(definition.id)) errors.push(`Duplicate achievement ID: ${definition.id}.`);
    ids.add(definition.id);
    if (translationKeys.has(definition.translationKey)) errors.push(`Duplicate translation key: ${definition.translationKey}.`);
    translationKeys.add(definition.translationKey);
    if (!Number.isFinite(definition.target) || definition.target <= 0) errors.push(`Invalid target for ${definition.id}.`);
    if (definition.points !== ACHIEVEMENT_POINTS[definition.rarity]) errors.push(`Invalid points for ${definition.id}.`);
    if (definition.chainId && definition.tier !== undefined) {
      const chainTier = `${definition.chainId}:${definition.tier}`;
      if (chainTiers.has(chainTier)) errors.push(`Duplicate chain tier: ${chainTier}.`);
      chainTiers.add(chainTier);
    }
  }

  for (const legacyId of LEGACY_ACHIEVEMENT_IDS) {
    if (!ids.has(legacyId)) errors.push(`Missing legacy achievement ID: ${legacyId}.`);
  }

  return errors;
}
