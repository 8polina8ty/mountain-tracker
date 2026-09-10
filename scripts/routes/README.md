# Route Factory

Deterministic offline pipeline for generated-route front-seat classification, review, and
publication preparation. Everything runs through ordinary npm commands on a developer machine;
no Codex/OpenCode session, no network, no production writes.

This stage covers `generate -> status -> validate -> review -> prepare-publication [publish]`.
Production publication (`publish --execute`) is intentionally NOT enabled in this stage.

## Quick start

```
npm run routes -- generate --mountains 138,150 --limit 2
npm run routes -- status --run <runId>
npm run routes -- validate --run <runId>
npm run routes -- review --run <runId> [--decide "<mountainId>:APPROVE|REGENERATE|REJECT"]
npm run routes -- prepare-publication --run <runId>
npm run routes -- publish [--manifest-sha256 <hash>] [--execute]
```

Run directories live under `data/routes/runs/<runId>/`. `runId` is deterministic
(`rf-<fingerprint.prefix>`): re-running the same selection resumes the same run and idempotently
continues from its checkpoint. `--limit N` caps how many mountains are processed per invocation
so a large batch can be split across several shells without changing the fingerprint.

### 100-mountain multi-batch smoke

```
npm run routes:smoke
```

Processes every frozen pilot row through the front-seat classifier in three resume batches
(`--limit` 40 / 75 / 100) against the on-disk checkpoint, then proves determinism by re-deriving
the single-pass result and comparing manifest hashes. The recorded outcome is the honest
fail-closed classification of the integrity-only frozen pilot: **0 AUTO_APPROVED /
0 NEEDS_REVIEW / 100 REJECTED / 0 FAILED**, because the frozen discovery rows predate the Base
Access V2 evidence (`startRole` / `accessEvidence`) that gates auto-approval. This is the
expected output, not a defect; the reviewed `final-review.json` remains the source of truth for
states. No production writes occur, and no publication artifacts are produced.

## Pipeline

### generate

- Loads the frozen pilot integrity checkpoint (`loadFrozenSource()`: corpus internal hash,
  summit policy params, per-artifact SHA256 locks, report attestations).
- Loads the reviewed checkpoint `data/gpx/base-access-start-v2/final-review.json`
  (contract `mountain-tracker/base-access-canary-product-review/v1`) as the per-mountain
  classification feed. Each row binds the reviewed candidate: `resultHash`,
  `deterministicReplayVerified`, `fabricatedGapCount`, `startRole`, `safety`, access evidence,
  and the product-review reasons that produced the published canary.
- Classifies every selected row with `classifyReviewedRow`:
  - Gate re-check (re-checkable subset of the exact publication gate): PRIMARY_BASE_ACCESS role,
    generator auto-eligible, SAFE, non-hut kind, deterministic replay, zero fabricated gaps,
    valid 64-hex result hash. Any failure => `REJECTED`.
  - Otherwise warnings are derived from the review reasons; non-empty => `NEEDS_REVIEW`,
    empty => `AUTO_APPROVED`.
  - Canary ground truth (10 mountains) reproduces exactly: 3 AUTO_APPROVED (796, 12895, 73101),
    7 NEEDS_REVIEW, 0 REJECTED, 0 FAILED.
- `--mountains` filters by production mountain id (the DB `mountain_id`, as used by the
  deployment mapping and the V2 replacement manifest).
- Writes `manifest.json` (hash-bound, stable across resume) and `summary.json` with per-mountain
  entries, plus state folders `candidates/ approved/ needs-review/ rejected/ failed/`.

Review-reason vocabulary mapping (Base Access V2 product review -> Route Factory warning):

| Product review reason | Factory warning |
| --- | --- |
| `DIFFERENT_ASCENT_VARIANT_REVIEW` | `DIFFERENT_UPPER_APPROACH` |
| `SUBSTANTIALLY_LONGER_APPROACH_REVIEW` | `DETOUR_RATIO_HIGH` |
| `REMOTE_SERVICE_OR_TRACK_ACCESS_REVIEW` | `SERVICE_TRACK_DEPENDENCE` |
| anything else | `PUBLIC_ACCESS_NOT_CUSTOMARY_UNVERIFIED` |

### status / validate

- `status` prints totals, remaining, state counts, and checkpoint validity.
- `validate` recomputes the manifest hash, cross-checks the summary counts, and requires a
  matching checkpoint. `valid: true` means the run moved without drift.

### review

- Writes `review/review-prep.json`: every NEEDS_REVIEW mountain with its warnings and candidate
  ids for human triage.
- `--decide "<mountainId>:APPROVE|REGENERATE|REJECT"` records one decision at a time into
  `review/decisions.json`. Only `APPROVE` feeds `prepare-publication`.

### prepare-publication

- Includes AUTO_APPROVED entries plus mountains with a recorded human APPROVE.
- Seeds publication artifacts deterministically from the locally reviewed V2 replacement
  manifest (`data/gpx/base-access-v2-replacement/replacement-manifest.json`), keyed by the
  production mountain id. Missing seeds are excluded as `UNSOURCED_ARTIFACTS`;
  NEEDS_REVIEW/REJECTED without a decision are excluded as `STATE_*`.
- Validates every seed (64-hex publication/request/artifact hashes, positive bytes, positive
  distance, exact storage path) and writes `publication/locked-manifest.json` plus
  `.sha256`.

### publish

- Default is `DRY_RUN`; no production write is ever performed without `--execute`.
- `--execute` additionally requires the exact `--manifest-sha256` of the locked manifest.
- In this stage `execute` is refused with `PUBLISH_EXECUTE_NOT_ENABLED_THIS_TASK`; wiring the
  real Supabase publication path is a later stage.

## Determinism and integrity

- Run fingerprint = dataset identity (datasetKey/region/snapshot/pbfSha256) + adaptive policy
  hash (sha256 of the reviewed checkpoint policy) + the selected mountain ids. Different dataset,
  policy, or selection => a different run.
- Manifest hash covers all manifest content except `manifestHash` and `startedAt`, so two
  identical runs agree and resume makes no accounting drift.
- The frozen pilot remains an integrity-only checkpoint: the runtime adaptive policy has
  legitimately drifted since the frozen artifacts were produced (accepted, documented in the
  summary), so classification never relies on it - the reviewed `final-review.json` is the
  source of truth for states.

## Safety notes

- Zero network, zero Supabase writes, zero storage writes. All outputs are local files.
- `final-review.json` and the replacement manifest are reviewed, manually deployed artifacts -
  do not edit them casually; `generate` asserts their contract/version and hash shape.
- Do not commit `data/routes/**` debris unless explicitly asked; run directories are
  reproducible on demand.