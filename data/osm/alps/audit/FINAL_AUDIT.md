# Phase 7 — Final Alps Dataset Audit & Mountain Coverage

## Executive answers

1. **OSM hiking relations analyzed:** 72,541
2. **Routes reconstructed successfully:** 71,840 (701 rejected)
3. **CONFIRMED summit associations:** 2,885
4. **Unique source routes with confirmed summits:** 2,780
5. **Unique peaks covered:** 2,094 (3.5834% of Phase 6 peaks)
6. **Canonical confirmed routes after deduplication:** 2,772
7. **AUTO_IMPORT_READY canonical routes:** 1,065
8. **Unique peaks covered by AUTO_IMPORT_READY routes:** 840
9. **MANUAL_REVIEW_REQUIRED canonical routes:** 1,707
10. **EXCLUDE canonical routes:** 0
11. **Main remaining risks:** REVIEW records are not publishable, country coverage lacks an administrative-boundary join, and flagged route-quality edge cases require human inspection.
12. **Recommended Phase 8:** validate the deterministic samples, design an idempotent staging-only importer for AUTO_IMPORT_READY records, and retain full OSM/canonical association provenance.

## Confirmed route and peak coverage

- Exactly one confirmed summit: 2,690 routes
- Multiple confirmed summits: 90 routes
- Maximum confirmed summits on one route: 5
- Average confirmed summits per confirmed route: 1.04
- Peaks with exactly one confirmed route: 1,506
- Peaks with 2–5 routes: 584
- Peaks with 6–10 routes: 4
- Peaks with more than 10 routes: 0

## Deduplication

- EXACT_DUPLICATE pairs: 269
- NEAR_DUPLICATE pairs: 74
- Duplicate groups: 308
- Routes represented in groups: 633
- Confirmed duplicate representations removed: 8
- Canonical confirmed routes remaining: 2,772

Summit associations from duplicate source representations are merged into their canonical audit record. Source route IDs, association evidence, and ODbL provenance remain attached.

## Quality and review

Quality distribution:

```json
{
  "buckets": {
    "90-100": 718,
    "80-89": 504,
    "70-79": 534,
    "60-69": 388,
    "50-59": 251,
    "<50": 385
  },
  "statistics": {
    "count": 2780,
    "missing": 0,
    "minimum": 0,
    "maximum": 100,
    "average": 73.56,
    "median": 76,
    "p10": 44,
    "p25": 62,
    "p75": 90,
    "p90": 100
  },
  "flagCounts": {
    "LOW_QUALITY": 385,
    "HIGH_FRAGMENTATION": 241,
    "MISSING_NAME": 1283,
    "UNKNOWN_SEMANTIC": 0,
    "SUSPICIOUS_SHORT": 25,
    "SUSPICIOUS_LONG": 0,
    "MULTIPLE_SUMMITS": 90
  }
}
```

- REVIEW associations: 25,387
- Unique REVIEW routes: 12,038
- Unique REVIEW peaks: 13,758
- Cases meeting all four high-confidence opportunity criteria: 45

No REVIEW association was promoted.

## Top 20 covered peaks

| Rank | Peak | OSM source ID | Elevation (m) | Source routes | Canonical variants | Avg. route quality |
|---:|---|---:|---:|---:|---:|---:|
| 1 | Punta Cermenati (Monte Resegone) | 26864438 | 1,875 | 7 | 7 | 75.43 |
| 2 | Blueme | 11586484042 | 1,392 | 7 | 7 | 62.71 |
| 3 | Tschiernock | 418117276 | 2,088 | 6 | 6 | 78.67 |
| 4 | Hühnerkogel / Košenjak | 344591473 | 1,522 | 6 | 6 | 84.83 |
| 5 | Pointe Chaligne | 1814344543 | 2,607 | 5 | 5 | 77.40 |
| 6 | Becca d'Aver | 1311884365 | 2,469 | 5 | 5 | 76.80 |
| 7 | Kuhgrat | 26863444 | 2,122 | 5 | 4 | 56.00 |
| 8 | Raduha | 1594993025 | 2,062 | 5 | 5 | 83.00 |
| 9 | Porezen | 26864352 | 1,632 | 5 | 5 | 95.00 |
| 10 | Corna Trentapassi | 527246106 | 1,244 | 5 | 5 | 72.00 |
| 11 | Canto Alto | 851653535 | 1,146 | 5 | 5 | 73.20 |
| 12 | Monte Pravello | 465507041 | 1,015 | 5 | 5 | 61.40 |
| 13 | Stolpnik | 3902613632 | 1,012 | 5 | 5 | 91.80 |
| 14 | Monte Mars | 1451518829 | 2,600 | 4 | 4 | 66.25 |
| 15 | Marchkinkele - Cornetto Di Confine | 1659572456 | 2,545 | 4 | 4 | 74.75 |
| 16 | Monte Barbeston | 726133727 | 2,482 | 4 | 4 | 80.50 |
| 17 | Ojstrica | 1843185025 | 2,350 | 4 | 4 | 86.00 |
| 18 | Piza Pranseies | 4259018947 | 2,254 | 4 | 4 | 64.25 |
| 19 | Rappastein | 2433401131 | 2,222 | 4 | 4 | 91.50 |
| 20 | Chrüz | 2291218257 | 2,196 | 4 | 4 | 64.00 |

## Elevation coverage

- Covered peaks ≥4,000 m: 0
- Covered peaks ≥3,000 m: 165
- Covered peaks ≥2,000 m: 1,196
- Covered peaks missing elevation: 27
- Unnamed covered peaks: 26

## Country and region limitation

Status: **UNAVAILABLE_FROM_CURRENT_ARTIFACTS**. The Phase 6 artifacts contain no administrative-boundary join, so comprehensive country/region coverage requires a future offline boundary dataset.

Only explicit country-code tags were accepted. Route names were not used and no external API or reverse geocoder was called.

## Integrity

- Status: **PASS**
- Critical failures: 0
- Total recorded failures: 0

## Performance

```json
{
  "inputLoadingMilliseconds": 9352.8,
  "aggregationMilliseconds": 270.4,
  "dedupCanonicalProcessingMilliseconds": 83.9,
  "auditGenerationMilliseconds": 1400.4,
  "outputWritingMilliseconds": 774.9,
  "totalRuntimeMilliseconds": 11109.5,
  "peakObservedRssMegabytes": 456.1,
  "inputRows": {
    "routes": 71840,
    "peaks": 58436,
    "analyses": 71840,
    "duplicateGroups": 308
  },
  "expensivePhase6WorkRepeated": false
}
```

The audit read existing JSONL/summary artifacts only. It did not extract the PBF or recompute route similarities.

## Remaining data-quality risks

- REVIEW associations remain unpublished and require matcher research or manual validation.
- Country/region coverage is incomplete without an offline administrative-boundary join.
- Canonical merging preserves source association provenance, but Phase 8 must define the durable import schema and review workflow.
- Low-quality, fragmented, unnamed, unusually short/long, multiple-summit, and unknown-semantic routes require manual inspection.

## Recommended Phase 8

1. Manually validate the deterministic confirmed and high-confidence REVIEW samples.
2. Define a reviewed staging schema and idempotent dry-run importer for AUTO_IMPORT_READY canonical routes only.
3. Add an offline Alps administrative-boundary join before country-level reporting or rollout decisions.
4. Preserve OSM source IDs, ODbL attribution, canonical/source provenance, and merged summit associations during staging.
5. Do not publish REVIEW records automatically; establish an explicit adjudication workflow.
