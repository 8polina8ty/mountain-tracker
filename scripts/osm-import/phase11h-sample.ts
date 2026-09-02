import {
  PHASE11H_SAMPLE_TARGET,
  qualityBand,
  type Phase11hQualityBand,
} from "./phase11h-naming.ts";
import type { Phase11gQualificationResult } from "./phase11g-qualification.ts";

export type Phase11hSelectionTier =
  | "NAMED_STRATUM"
  | "HUT_FULL_COVERAGE"
  | "BASE_BAND_STRATUM"
  | "HASH_RANDOM_CONTROL";

export interface Phase11hSampleRecord {
  canonicalRelationId: string;
  qualificationHash: string;
  startContext: string | null;
  qualityScore: number;
  qualityBand: Phase11hQualityBand;
  greenClass: string | null;
  selectionTier: Phase11hSelectionTier;
  selectionReason: string;
}

export interface Phase11hSampleSelection {
  records: Phase11hSampleRecord[];
  targetSize: number;
  deterministicOrderingRule: string;
}

function byHash(
  records: Phase11gQualificationResult[],
): Phase11gQualificationResult[] {
  return [...records].sort((left, right) =>
    left.deterministicQualificationHash.localeCompare(right.deterministicQualificationHash),
  );
}

export function selectPhase11hCalibrationSample(
  greens: Phase11gQualificationResult[],
  targetSize = PHASE11H_SAMPLE_TARGET,
): Phase11hSampleSelection {
  const named = greens.filter((record) => record.greenClass === "GREEN_NAMED");
  const missing = greens.filter((record) => record.greenClass === "GREEN_MISSING_NAME");
  const hut = byHash(missing.filter((record) => record.startContext === "HUT_START"));
  const base = byHash(missing.filter((record) => record.startContext === "BASE_START"));

  const selected = new Map<string, Phase11gQualificationResult>();
  const tierOf = new Map<string, Phase11hSelectionTier>();
  const reasonOf = new Map<string, string>();

  const add = (
    record: Phase11gQualificationResult,
    tier: Phase11hSelectionTier,
    reason: string,
  ): void => {
    if (selected.has(record.canonicalRouteSourceId)) return;
    selected.set(record.canonicalRouteSourceId, record);
    tierOf.set(record.canonicalRouteSourceId, tier);
    reasonOf.set(record.canonicalRouteSourceId, reason);
  };

  // 1. The single GREEN_NAMED route must be reviewed (display-label reference).
  for (const record of byHash(named)) {
    add(record, "NAMED_STRATUM", "Single Phase 11G GREEN_NAMED route; required display-label reference.");
  }

  // 2. Full coverage of the HUT_START recovery class (small and novel).
  if (selected.size < targetSize) {
    for (const record of hut) {
      if (selected.size >= targetSize) break;
      add(
        record,
        "HUT_FULL_COVERAGE",
        `HUT_START recovery class, quality ${record.qualityScore} (${qualityBand(record.qualityScore)}).`,
      );
    }
  }

  // 3. BASE_START band strata (>=3 per quality band when available).
  const baseByBand: Record<Phase11hQualityBand, Phase11gQualificationResult[]> = {
    Q65_74: [],
    Q75_89: [],
    Q90: [],
  };
  for (const record of base) {
    baseByBand[qualityBand(record.qualityScore)].push(record);
  }
  if (selected.size < targetSize) {
    for (const band of ["Q65_74", "Q75_89", "Q90"] as const) {
      const bandRecords = byHash(baseByBand[band]).slice(0, 3);
      for (const record of bandRecords) {
        if (selected.size >= targetSize) break;
        add(
          record,
          "BASE_BAND_STRATUM",
          `BASE_START quality band ${band} recovery stratum, quality ${record.qualityScore}.`,
        );
      }
    }
  }

  // 4. Deterministic random control fill from remaining BASE routes by hash order.
  const remainingBase = base.filter((record) => !selected.has(record.canonicalRouteSourceId));
  for (const record of remainingBase) {
    if (selected.size >= targetSize) break;
    add(
      record,
      "HASH_RANDOM_CONTROL",
      "Deterministic hash-order random control from remaining BASE_START GREEN candidates.",
    );
  }

  const ordered = [...selected.values()].sort((left, right) =>
    left.deterministicQualificationHash.localeCompare(right.deterministicQualificationHash),
  );
  const records: Phase11hSampleRecord[] = ordered.map((record) => ({
    canonicalRelationId: record.canonicalRouteSourceId,
    qualificationHash: record.deterministicQualificationHash,
    startContext: record.startContext ?? null,
    qualityScore: record.qualityScore,
    qualityBand: qualityBand(record.qualityScore),
    greenClass: record.greenClass,
    selectionTier: tierOf.get(record.canonicalRouteSourceId)!,
    selectionReason: reasonOf.get(record.canonicalRouteSourceId)!,
  }));

  return {
    records,
    targetSize,
    deterministicOrderingRule:
      "sorted by Phase 11G deterministicQualificationHash ascending; stratified tiers NAMED_STRATUM, HUT_FULL_COVERAGE, BASE_BAND_STRATUM, HASH_RANDOM_CONTROL",
  };
}