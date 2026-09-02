# Zugspitze OpenStreetMap route importer

This isolated prototype reads hiking-route relations and peak nodes from a small
bounding box around Zugspitze. Phase 1 downloads data from the Overpass API,
reconstructs relation geometry, calculates route length locally, and writes JSON
and GeoJSON files. Phase 2 locally evaluates route-to-peak proximity. Phase 3
classifies route semantics and makes a conservative final summit-association
decision. Phase 4 compares route geometry and forms duplicate-only groups. No
phase connects to Supabase or Mountain Tracker application code.

## Run

Use the repository's Node 24 runtime:

```powershell
node --experimental-strip-types scripts/osm-import/import-zugspitze.ts
node --experimental-strip-types scripts/osm-import/match-zugspitze-peaks.ts
node --experimental-strip-types scripts/osm-import/analyze-zugspitze-routes.ts
node --experimental-strip-types scripts/osm-import/analyze-zugspitze-similarity.ts
```

The importer first discovers `type=route` relations tagged `route=hiking` or
`route=foot`, plus `natural=peak` nodes, inside the configured Zugspitze bounding
box. A second read retrieves the complete recursive member closure for the exact
relation IDs found. Set `OVERPASS_API_URL` to prefer another Overpass interpreter;
the public default endpoints remain fallbacks.

## Generated files

- `data/osm/zugspitze-routes.json` contains normalized routes and a validation
  report.
- `data/osm/zugspitze-peaks.json` contains normalized peak nodes.
- `data/osm/zugspitze-routes.geojson` contains the routes as a GeoJSON Feature
  Collection.
- `data/osm/zugspitze-route-peak-matches.json` contains route/peak candidates,
  classifications, confidence values, geometry diagnostics, and a summary.
- `data/osm/zugspitze-route-analysis.json` contains route semantics, quality
  scores, component endpoint evidence, and final summit associations.
- `data/osm/zugspitze-route-similarity.json` contains all unique pair metrics,
  classifications, performance statistics, and synthetic fixture results.
- `data/osm/zugspitze-route-groups.json` contains duplicate groups and canonical
  selection evidence without deleting any source route.

The files are replaced only after both Overpass reads and local reconstruction
complete. Each route retains its OSM relation ID, canonical OSM URL, selected
route metadata, original tags, geometry, coordinate count, component count, and
locally calculated Haversine distance.

## Reconstruction and limitations

Relation members are expanded recursively in their supplied order. Consecutive
ways are joined only when they share the same endpoint node ID; a way may be
reversed to connect its endpoint to the preceding way. A break starts a new
geometry component, so disconnected data is exported as a `MultiLineString`
rather than bridged with a synthetic segment. Missing relations, ways, or nodes
reject the affected route instead of exporting partial geometry.

## Peak Matcher

The matcher reads the generated Zugspitze route and peak JSON files locally; it
does not make another Overpass request. It measures every peak against every
line segment in each route, so a peak between widely spaced route coordinates is
measured against the projected point on the segment rather than only against the
stored coordinates. `MultiLineString` components are evaluated independently,
and no segment is created across a component gap.

Only route/peak pairs within 500 metres are retained as candidates. The initial,
provisional classifications are deliberately explicit:

- `MATCHED`: at most 30 m from route geometry, or at most 60 m from geometry
  and at most 100 m from the nearest component endpoint.
- `POSSIBLE`: more than 30 m and at most 150 m from geometry, unless the
  endpoint-assisted `MATCHED` rule applies.
- `REJECTED`: more than 150 m from geometry, up to the 500 m candidate limit.

Confidence is a deterministic, tunable distance score with a small endpoint
proximity bonus. It is diagnostic only and never overrides the explicit
classification. Each candidate also records the nearest projected coordinate,
component and segment indexes, projection fraction, nearest endpoint, distances,
and human-readable reasons.

Run the focused tests with:

```powershell
node --experimental-strip-types --test scripts/osm-import/peak-matcher.test.ts
node --experimental-strip-types --test scripts/osm-import/route-analysis.test.ts
node --experimental-strip-types --test scripts/osm-import/route-similarity.test.ts
```

## Route semantics and final summit association

Phase 3 classifies each relation with deterministic metadata and geometry rules:

- `summit_route`: strong evidence that a component ends at a natural peak.
- `long_distance_trail`: recognized identities such as E4, Via Alpina, or
  Nordalpenweg, supported where available by network and length metadata.
- `via_ferrata`: explicit klettersteig/ferrata identity with supporting local
  route evidence.
- `local_hike`: a named or referenced local-scale hiking relation.
- `approach`: explicit approach/access semantics.
- `unknown`: insufficient evidence for a safer specific type.

The Phase 2 geometric classification and Phase 3 final association are separate.
`CONFIRMED` requires `MATCHED` geometry, a component endpoint within 10 metres of
the summit, and no conflicting long-distance-trail identity. `POSSIBLE` geometry
always becomes `REVIEW`, never `CONFIRMED`. A matched long-distance trail also
remains `REVIEW`; crossing a summit coordinate does not show that the relation is
a dedicated summit route. Phase 2 `REJECTED` pairs remain rejected.

Each `LineString` or `MultiLineString` component retains independent start/end
coordinates and its nearest peak evidence. Disconnected components are never
treated as a continuous journey. The separate 0–100 route quality score rewards
useful identity/metadata, connected geometry, clear component endpoints, and a
reasonable length while penalizing missing names, fragmentation, inconsistent
geometry statistics, and suspicious lengths. This score describes import data
quality; it is not summit confidence.

## Geometry similarity and duplicate groups

Phase 4 creates comparison-only geometry without altering the Phase 1 source
artifacts. It removes consecutive points within 0.5 m, resamples each component
at 25 m, and preserves every `MultiLineString` gap. Reversing route direction
does not change duplicate detection.

Every pair uses several independent signals: bidirectional geometry coverage
within 40 m, minimum symmetric coverage, length ratio, forward and reversed
endpoint distances, component endpoint overlap, an approximate combined shape
score, component counts, and shared confirmed summit evidence. The minimum of
the two directional coverage values prevents a short route contained inside a
much longer route from being treated as a duplicate. Names are retained for
debugging but do not upgrade similarity classification.

The provisional classifications are:

- `EXACT_DUPLICATE`: at least 0.98 length ratio and symmetric coverage, plus
  very strong direction-independent endpoint agreement.
- `NEAR_DUPLICATE`: at least 0.90 length ratio and symmetric coverage with
  strong endpoint agreement.
- `SAME_VARIANT`: substantial shared geometry and endpoint/corridor evidence,
  but meaningful differences remain.
- `DIFFERENT_VARIANT`: a shared confirmed summit with materially different
  geometry.
- `UNRELATED`: insufficient geometry and destination evidence.

Only `EXACT_DUPLICATE` and `NEAR_DUPLICATE` edges form duplicate groups.
`SAME_VARIANT` is deliberately never merged. Canonical selection is stable:
highest Phase 3 quality score, then richest metadata, then source ID. All source
routes remain present. Geometry coverage uses normalized samples indexed in a
small Earth-centered spatial grid, avoiding original point-to-point Cartesian
comparisons across all 77,573 coordinates.

## Alps bulk ingestion (Phase 5)

Phase 5 reads the local Geofabrik Alps PBF through the mature
[Osmium Tool](https://osmcode.org/osmium-tool/), rather than decoding a multi-GB
PBF in JavaScript. Install `osmium` with the package manager for your platform
(for example, `conda install -c conda-forge osmium-tool`) and verify it with
`osmium --version`. No new npm dependency is required.

The source extract is intentionally not downloaded by the importer. Download it
from the [Geofabrik Alps extract page](https://download.geofabrik.de/europe/alps.html)
and keep it in the ignored local source directory:

```powershell
New-Item -ItemType Directory -Force data/osm/source
curl.exe --fail --location --continue-at - --output data/osm/source/alps-latest.osm.pbf https://download.geofabrik.de/europe/alps-latest.osm.pbf
```

Start with the bounded 100-route run:

```powershell
node --experimental-strip-types scripts/osm-import/import-alps.ts --input data/osm/source/alps-latest.osm.pbf --limit-routes 100
```

After reviewing its summary, the next progression is:

```powershell
node --experimental-strip-types scripts/osm-import/import-alps.ts --input data/osm/source/alps-latest.osm.pbf --limit-routes 1000
```

`--skip-dedup` omits expensive Phase 4 comparisons while retaining candidate
statistics. A run without `--limit-routes` is rejected unless `--confirm-full`
is also supplied, so compilation or a bounded dry-run cannot accidentally start
the full Alps job.

Osmium first discovers only actual `type=route` hiking/foot relations, then
recursively extracts the selected hiking relations and their referenced members.
`add-locations-to-ways` uses a disk-backed sparse node-location index, and the
Node process streams OPL into a local SQLite checkpoint store. Relation members
are reconstructed in OSM order; disconnected ways become separate
`MultiLineString` components and missing data rejects the relation. Peaks are
extracted independently from `natural=peak` nodes.

The output directory is `data/osm/alps/` and contains scalable JSONL datasets:

- `routes.jsonl` and `rejected-routes.jsonl`
- `peaks.jsonl`
- `route-peak-associations.jsonl`
- `route-analysis.jsonl`
- `route-similarity.jsonl`
- `route-groups.jsonl`
- `summary.json`

`data/osm/alps/checkpoints/` holds the input fingerprint, selected relation IDs,
recursive/located PBF intermediates, disk node-location index, SQLite object
store, and atomic 100-route JSONL chunks. A rerun with the same PBF size/mtime
and route limit reuses completed expensive extraction stages. Changing the input
fingerprint or limit creates a fresh logical run; source PBF data is never
deleted automatically.

Peak matching builds a 500 m Earth-centered spatial grid and samples route
geometry at 250 m for conservative nearby-peak lookup. Only those coarse
candidates reach the existing precise segment matcher, which retains the
existing 500 m limit. Deduplication similarly builds cheap route corridor
signatures and compares Phase 4 geometry only for spatial/endpoint/shared-summit
candidates. `summary.json` records theoretical and evaluated pair counts,
reduction percentage, all stage timings, semantic/quality distributions, and an
approximate peak-index RSS delta.

Every route and peak source record keeps its OSM type/ID/URL, `ODbL-1.0`
license, attribution, and normalized provenance ID. Downstream publication of a
derived database may trigger ODbL attribution, share-alike, and data-offer
obligations; review the [OSM copyright guidance](https://www.openstreetmap.org/copyright)
before distributing an Alps-derived dataset. This pipeline does not publish,
upload, delete, or write to Mountain Tracker or Supabase.

This is a bounded prototype, not a production importer:

- The bounding box selects relations, but complete selected relations may extend
  outside it.
- OSM member order and topology can be incomplete or inconsistent; the importer
  does not solve a general route-ordering or graph traversal problem.
- Geometric proximity is only a screening signal. It does not prove that the
  signed route actually visits, reaches, or ascends a summit; nearby traverses,
  ridgelines, and disconnected relation members can produce false positives.
- Semantic classification is heuristic and only uses the current OSM relation
  metadata. It does not interpret guidebook intent, trail direction, terrain,
  elevation profiles, or whether a hiker completed the route.
- Similarity thresholds are provisional and should be calibrated against more
  sources and manually labeled variants before any automated production merge.
- It does not synthesize routes from `highway=path` or import data into Mountain
  Tracker/Supabase.
- Peak elevation is copied from the OSM `ele` tag when parseable; it is not
  independently verified.
- Public Overpass instances can be rate-limited or temporarily unavailable.

## OpenStreetMap provenance

The generated data is © OpenStreetMap contributors and is available under the
Open Database License (ODbL) 1.0. Keep attribution and license/provenance fields
with any derivative export. See the
[OpenStreetMap copyright and license page](https://www.openstreetmap.org/copyright).
