# Phase 11 controlled OSM route publication

## Phase 11C-CAT v2 addendum

`mountain-tracker-osm-publication/v1` is a frozen compatibility contract for the
six ACTIVE OSM publications created with `route_type = hiking`. Their canonical
payloads, hashes, idempotency keys, and provenance are not recalculated.

Future multi-category publications use the additive
`mountain-tracker-osm-publication/v2` contract and the separate
`publish_approved_osm_route_v2(jsonb)` review artifact. Route role remains the
existing `semanticType` (`summit_route`, `local_hike`, and so on). Activity is an
independent canonical classification whose `routeType` is exactly one of
`hiking`, `mountaineering`, `via_ferrata`, `climbing`, `ski_touring`, `mixed`, or
`other`. Its source-evidence snapshot and canonical hash are stored in provenance.
Explicit technical evidence wins over generic `route=hiking`; conflicting or
insufficient evidence requires manual review and is not publishable by the v2
mapping until separately resolved.

`database/osm_route_publication_v2.sql` has been applied. It preserves the
deployed v1 RPC, permits both provenance contract versions, adds nullable v2
activity evidence (required only for v2), and adds the shared seven-value
`mountain_routes.route_type` constraint. Two canary routes have been published.

This document defines `mountain-tracker-osm-publication/v1`. Phase 11C.2 canary
and batch CLIs have controlled `--execute` modes that call the v2 RPC under
`service_role` authorization with mandatory post-write verification.

## Deployed `mountain_routes` audit (2026-08-27)

The read-only PostgREST OpenAPI document reports 21 columns. Required columns
are `id`, `mountain_id`, `name`, `route_type`, `is_verified`, `created_at`,
and `updated_at`. `id` is an `int8` primary key. `mountain_id` is an `int8`
foreign key to `mountains.id`. Defaults exposed by OpenAPI are
`route_type = 'hiking'`, `is_verified = false`, and `created_at/updated_at =
now()`. The remaining columns are nullable in the exposed contract. Text fields
are `text`; `distance_km` is `numeric`; elevation/duration are `int4`;
`created_by` is `uuid`; timestamps are `timestamptz`; `is_verified` is boolean.

The deployed table now contains 8 rows:
- 6 v1 routes with `route_type = hiking` (relations 196164, 20916, 33528,
  199145, 207900, 207913)
- 2 v2 canary routes published 2026-08-27:
  - Relation 361148 "Wanderweg 10" → mountain 12787, `route_type = hiking`
  - Relation 140270 "Via Ferrata Rosalba Grasselli" → mountain 77279,
    `route_type = via_ferrata`

All rows use nullable `created_by` and `gpx_url`, a public absolute
`route-gpx` Storage URL for GeoJSON, and `source_name/source_url` for
attribution. The `route-gpx` bucket is public, limits objects to 10 MiB, and
permits `application/geo+json` among its MIME types. Anonymous read returns all
8 rows, proving effective public SELECT for verified routes.

PostgREST does not expose `information_schema`, `pg_catalog`, or the `storage`
schema. Therefore unique/check constraints beyond the exposed PK/FK, indexes,
trigger bodies, RLS enablement/policy bodies, grants, and ownership cannot be
authoritatively enumerated through the available read-only channel. OpenAPI
lists HTTP GET/POST/PATCH/DELETE shapes, but that is not evidence that browser
roles may write. The v2 SQL contains a column-existence guard and does not
change existing `mountain_routes` RLS, policies, triggers, grants, or indexes.

Application inspection found only two reads and no writes: Mountain Detail lists
verified rows by `mountain_id`; the GPX endpoint reads a verified row and only
accepts absolute HTTP(S) `gpx_url`. Mountain Detail fetches `geojson_url` as a
GeoJSON FeatureCollection and supports LineString/MultiLineString.

## Additive architecture and traceability

`mountain_routes` remains the compact application row. The service-only
`osm_route_publication_provenance` table links it to the immutable staging UUID
and stores the publication identity, canonical/source OSM relation IDs, all
Phase 10 hashes, dataset fingerprint, geometry hash, exact QA decision and
history snapshot, reviewer evidence, ODbL attribution, topology, warnings/audit
evidence, and target payload hash. Geometry itself is not duplicated.

Traceability is:

`mountain_routes` → provenance → staging route → canonical/source relation IDs →
dataset/payload/candidate hashes → QA decision/history → ODbL source evidence.

RLS is enabled on provenance. Browser roles receive no privileges. `service_role`
receives SELECT and execution of both atomic definer RPCs
(`publish_approved_osm_route` and `publish_approved_osm_route_v2`), but no
direct provenance mutation grant.

## Deterministic field mapping

| Target field | Class | Mapping |
|---|---|---|
| `id` | DERIVED | Deployed identity/default, never client supplied |
| `mountain_id` | DIRECT | Confirmed summit exact `mountainId`; required |
| `name` | DIRECT | Trimmed OSM candidate route name; blank blocks |
| `start_location` | REQUIRES_FUTURE_ENRICHMENT | `NULL`; coordinates are not fabricated as a place name |
| `route_type` | DERIVED | v1: `summit_route` → `hiking`; v2: activity classification `routeType` (one of 7); other semantics block |
| `difficulty_system`, `difficulty_value` | REQUIRES_FUTURE_ENRICHMENT | `NULL` |
| `distance_km` | DERIVED | `round(distanceMeters) / 1000`; deterministic 0.001 km resolution |
| `elevation_gain_m`, `duration_minutes` | REQUIRES_FUTURE_ENRICHMENT | `NULL` |
| `description`, `best_season`, `equipment` | REQUIRES_FUTURE_ENRICHMENT | `NULL` |
| `warnings` | DERIVED/NULL | Explicit topology warning for BRANCHING/DISCONNECTED/AMBIGUOUS; otherwise `NULL`; complete structured evidence stays in provenance |
| `gpx_url` | NOT_SUPPORTED | `NULL`; OSM publication does not fabricate GPX |
| `source_name` | DERIVED | `OpenStreetMap` |
| `source_url` | DIRECT | Canonical `https://www.openstreetmap.org/relation/<id>` |
| `is_verified` | DERIVED | `true` only after exact VISUALLY_APPROVED validation |
| `created_by` | NULL | `NULL`, matching the deployed service-owned row convention |
| `geojson_url` | DERIVED | Stable implemented same-origin publication endpoint |
| `created_at`, `updated_at` | DERIVED | Deployed database defaults |

## Geometry contract

The selected strategy is a real same-origin route:

`/api/osm-route-publications/openstreetmap/relation/<canonical-id>/geojson`

It resolves active provenance with the server service client, revalidates the
linked verified `mountain_routes` row, staging payload hash, and geometry hash,
then wraps the unmodified staging LineString or MultiLineString in a
FeatureCollection. It never reorders, simplifies, uploads, or connects
components. The existing public Storage pattern was inspected but not selected:
it would add an object write outside the atomic database transaction and
duplicate immutable staging geometry.

The response includes explicit topology metadata. BRANCHING uses the Phase 10A.1
inferred physical endpoints and preserves `endpointSelectionAmbiguous = true`
plus `BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS`. DISCONNECTED returns explicit
null topology endpoints, preventing MountainRouteMap's legacy flattened-coordinate
fallback from inventing a global Start/Finish. Existing non-OSM GeoJSON without
metadata retains its current rendering behavior.

## Idempotency, transaction, and rollback

The identity is the staging idempotency key plus publication contract. Unique
constraints also cover staging UUID, mountain route, and provider/canonical
relation/contract. The v2 RPC locks and validates staging, one exact confirmed
summit, current QA and complete history, canonical candidate/manifest/target/
geometry/history hashes, manifest membership, mountain existence, mapping, and
duplicate identity. It then inserts `mountain_routes` and provenance in one
transaction. Exact rerun returns `UNCHANGED` without writes; any changed
payload, candidate set/manifest, geometry, QA version/history, target, dataset,
or contract fails closed.

Rollback locks one exact provenance identity and verifies expected route ID and
target hash. It deletes provenance then that one `mountain_routes` row in the
same transaction. Any later foreign-key reference makes route deletion fail and
restores the provenance delete. It never targets mountains, GPX activities,
ascents, journals, or community routes.

## Review and future authorization boundary

Review `database/osm_route_publication.sql`,
`database/osm_route_publication_v2.sql`, and
`database/osm_route_publication_rollback.sql` together with this contract and
the locked first manifest. Applying SQL, deploying the application endpoint, or
invoking either RPC requires a new explicit authorization. The current CLI
rejects write flags and implements only `--dry-run` for Phase 11C.1; Phase 11C.2
canary and batch have controlled `--execute` modes with confirmation strings.

## Phase 11C.2 Canary (deployed 2026-08-27)

Locked manifest: `data/osm/alps/publication/phase11c2a-v2-canary.json`
Deterministic hash: `787c9bc2a9b64dfbc181bf679e4b357acbe7dbd66a6bda462ec47f62a4f422f0`

### Records

| Relation | Name | Mountain | Route Type | Semantic | Activity Hash |
|---|---|---|---|---|---|
| 361148 | Wanderweg 10 | 12787 | hiking | summit_route | 0c62d8ca93c96481245293177d305c9ef4c172dd81279d2979384e23113d5b09 |
| 140270 | Via Ferrata "Rosalba Grasselli" | 77279 | via_ferrata | summit_route | 3dcb145b260b04458b8fe7e3e0a301f07d5589e10330c7e5c7364c0fa7ad4e42 |

### Idempotency keys
- `openstreetmap:relation:361148:mountain-tracker-osm-route/v1:mountain-tracker-osm-publication/v2`
- `openstreetmap:relation:140270:mountain-tracker-osm-route/v1:mountain-tracker-osm-publication/v2`

### Verification performed by `--execute`
1. Calls `publish_approved_osm_route_v2` RPC for each candidate
2. Validates RPC returns `action: "CREATED"` with a valid `mountain_route_id`
3. Post-write: queries `osm_route_publication_provenance` for ACTIVE rows
4. Verifies count = beforeCount + 2
5. Verifies both new rows have `publication_contract_version = v2` and `publication_status = ACTIVE`
6. Verifies canonical_relation_id matches expected (361148, 140270)

### Read-only preflight command
```bash
node --experimental-strip-types scripts/osm-import/publish-phase11c2a-v2-canary.ts
```

### Controlled execute command (requires exact confirmation)
```bash
node --experimental-strip-types scripts/osm-import/publish-phase11c2a-v2-canary.ts --execute --manifest data/osm/alps/publication/phase11c2a-v2-canary.json --confirm-relations 361148,140270
```

## Phase 11C.2 Batch (prepared, not executed)

Locked manifest: `data/osm/alps/publication/phase11c2-v2-batch.json`
Selects 10 additional SIMPLE topology, quality-100 hiking routes for v2 publication.

Execute command requires `--confirm-relations` with all 10 canonical relation IDs.