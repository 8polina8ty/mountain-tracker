# Phase 8A offline administrative boundaries

## Selected dataset

- Provider: William & Mary geoLab.
- Dataset: geoBoundaries `gbOpen` ADM1 high-precision single-country files.
- Snapshot: commit `9469f09`, built 2023-12-12, downloaded through URLs pinned to that commit.
- Product documentation: <https://www.geoboundaries.org/> and
  <https://github.com/wmgeolab/geoBoundaries>.
- Geometry: full-resolution WGS84 GeoJSON `Polygon`/`MultiPolygon` files.
- Local normalized output: `data/osm/boundaries/alps-admin.geojson`.

The pinned snapshot is used instead of the moving `api/current` URLs. The source
manifest records the exact URL, byte count, and SHA-256 for every downloaded
country file. Normalization does not simplify, union, repair, or infer geometry.

## Licensing and attribution

geoBoundaries states that individual files retain the license recorded in each
boundary's metadata. Phase 8A therefore preserves the license, license URL,
source, source URL, attribution, boundary ID, and represented year per normalized
feature. The selected inputs allow commercial use, subject to their conditions:

| Country | Source represented by geoBoundaries | Represented year | License |
|---|---|---:|---|
| DE | Federal Agency for Cartography and Geodesy | 2021 | Data licence Germany – attribution – 2.0 |
| AT | Federal Office for Metrology and Survey | 2017 | CC BY-SA 2.0 |
| CH | Federal Office of Topography swisstopo | 2022 | swisstopo OGD terms |
| IT | ISTAT | 2023 | CC BY 3.0 |
| FR | IGN-F | 2022 | Etalab Open License 2.0 |
| SI | Eurostat, European Commission | 2021 | CC BY 4.0 |
| LI | OpenStreetMap and Wambacher | 2017 | ODbL 1.0 |

Primary terms and metadata:

- geoBoundaries license/metadata rule:
  <https://github.com/wmgeolab/geoBoundaries/blob/main/LICENSE>
- Germany: <https://www.govdata.de/dl-de/by-2-0>
- Austria: <https://creativecommons.org/licenses/by-sa/2.0/>
- Switzerland:
  <https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices>
- Italy: <https://creativecommons.org/licenses/by/3.0/>
- France: <https://www.etalab.gouv.fr/licence-ouverte-open-licence/>
- Slovenia: <https://creativecommons.org/licenses/by/4.0/>
- Liechtenstein/OSM-derived boundary:
  <https://opendatacommons.org/licenses/odbl/1-0/>

The German, CC BY, Etalab, and swisstopo inputs require source attribution.
Austria's CC BY-SA and Liechtenstein's ODbL source also carry share-alike
conditions for covered adaptations/derivative databases. The combined normalized
file is therefore kept local and ignored by Git. It must not be redistributed or
bundled into a public release without preserving every attribution and completing
a license review for the proposed distribution form. The Mountain Tracker
application code is separate from this local boundary database.

## Administrative-grain caveats

The normalized `admin1` values preserve geoBoundaries' ADM1 grain; Phase 8A does
not relabel lower or higher levels as ADM1. In this snapshot Italy's five ADM1
features are statistical macro-regions, and Slovenia's two ADM1 features are
macro-regions. This is less granular than Italian regions or Slovenian statistical
regions, but it is explicit and reproducible. Germany, Austria, Switzerland,
France, and Liechtenstein resolve to the ADM1 units supplied in their source files.

## Reproduction

Download the pinned source files and normalize them:

```text
node --experimental-strip-types scripts/osm-import/prepare-admin-boundaries.ts --download
```

Rebuild from already downloaded sources without network access:

```text
node --experimental-strip-types scripts/osm-import/prepare-admin-boundaries.ts
```

Then run the Phase 8 dry run:

```text
node --experimental-strip-types scripts/osm-import/stage-alps-routes.ts --dry-run --admin-boundaries data/osm/boundaries/alps-admin.geojson
```

No command in this workflow writes to Supabase. The staging SQL is unrelated and
must remain unapplied unless separately reviewed and authorized.
