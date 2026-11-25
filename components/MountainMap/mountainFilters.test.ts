import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALTITUDE_PRESETS, DEFAULT_MAP_FILTERS, activeFilterCount, filterMountainsInView, matchesMountainFilters, retainVisiblePeak, createFilterDraft, validateFilterDraft, hasCustomHeight } from "./mountainFilters.ts";
import type { MountainMapFilters, PeakFeature, PeakFeatureCollection, SelectedPeak } from "./types.ts";

const bounds = { west: 5, south: 45, east: 15, north: 55 };
const climbed = new Set([2, 4]);
const peak = (id: number, height: number, name = "Alpine Peak", longitude = 10): PeakFeature => ({
  type: "Feature", geometry: { type: "Point", coordinates: [longitude, 50] },
  properties: { id, osm_id: id + 100, height, name },
});
const original: PeakFeatureCollection = {
  type: "FeatureCollection",
  features: [peak(1, 700), peak(2, 999), peak(3, 2000), peak(4, 3000), peak(5, 8850)],
};
const filter = (overrides: Partial<MountainMapFilters> = {}, search = "") =>
  filterMountainsInView(original, bounds, { ...DEFAULT_MAP_FILTERS, ...overrides }, climbed, search);
const ids = (collection: PeakFeatureCollection) => collection.features.map((f) => f.properties.id);
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("defaults preserve every loaded in-range mountain and do not mutate original GeoJSON", () => {
  assert.deepEqual(DEFAULT_MAP_FILTERS, { minHeight: 700, maxHeight: 8850, ascentStatus: "all" });
  assert.deepEqual(ids(filter()), [1, 2, 3, 4, 5]);
  assert.deepEqual(filter().features.map((f) => f.properties.climbed), [false, true, false, true, false]);
  assert.equal(original.features[1].properties.climbed, undefined);
});

test("altitude boundaries are inclusive and exclude out-of-range data", () => {
  assert.deepEqual(ids(filter({ minHeight: 999, maxHeight: 3000 })), [2, 3, 4]);
  assert.deepEqual(ids(filter({ minHeight: 2000, maxHeight: 2000 })), [3]);
  for (const height of [699, 8851, NaN]) {
    assert.equal(matchesMountainFilters(peak(9, height).properties, DEFAULT_MAP_FILTERS, climbed), false);
  }
});

test("climbed and unclimbed use database mountain IDs, including an empty ascent set", () => {
  assert.deepEqual(ids(filter({ ascentStatus: "climbed" })), [2, 4]);
  assert.deepEqual(ids(filter({ ascentStatus: "unclimbed" })), [1, 3, 5]);
  assert.equal(matchesMountainFilters(peak(102, 1000).properties, { ...DEFAULT_MAP_FILTERS, ascentStatus: "climbed" }, climbed), false);
  assert.equal(filterMountainsInView(original, bounds, { ...DEFAULT_MAP_FILTERS, ascentStatus: "climbed" }, new Set(), "").features.length, 0);
});

test("search, altitude and ascent filters combine; search normalization and name fallback survive", () => {
  assert.deepEqual(ids(filter({ minHeight: 2000, maxHeight: 4000, ascentStatus: "climbed" }, "  ALPINE  ")), [4]);
  assert.deepEqual(ids(filter({}, "missing")), []);
  assert.equal(matchesMountainFilters({ id: 2, osm_id: 102, height: 999, name_de: "Zugspitze" }, DEFAULT_MAP_FILTERS, climbed, "zug"), true);
});

test("viewport excludes buffered mountains and retains inclusive edges", () => {
  const data: PeakFeatureCollection = { type: "FeatureCollection", features: [peak(1, 700, "A", 5), peak(2, 700, "A", 15), peak(3, 700, "A", 16)] };
  assert.deepEqual(ids(filterMountainsInView(data, bounds, DEFAULT_MAP_FILTERS, climbed, "")), [1, 2]);
});

test("selection closes when altitude, ascent, search or viewport excludes the peak", () => {
  const selected: SelectedPeak = { ...original.features[1].properties, longitude: 10, latitude: 50 };
  assert.equal(retainVisiblePeak(selected, filter()), selected);
  assert.equal(retainVisiblePeak(null, filter()), null);
  assert.equal(retainVisiblePeak(selected, filter({ minHeight: 1000 })), null);
  assert.equal(retainVisiblePeak(selected, filter({ ascentStatus: "unclimbed" })), null);
  assert.equal(retainVisiblePeak(selected, filter({}, "missing")), null);
  assert.equal(retainVisiblePeak(selected, filterMountainsInView(original, { ...bounds, west: 11 }, DEFAULT_MAP_FILTERS, climbed, "")), null);
});

test("presets set exact bounds and do not override ascent status", () => {
  assert.deepEqual(ALTITUDE_PRESETS.map((p) => [p.minHeight, p.maxHeight]), [[700, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 8850]]);
  for (const preset of ALTITUDE_PRESETS) {
    const draft: MountainMapFilters = { ...DEFAULT_MAP_FILTERS, ascentStatus: "climbed", ...preset };
    assert.equal(draft.ascentStatus, "climbed");
    assert.equal(activeFilterCount(draft), 2);
  }
  assert.deepEqual(ids(filter(ALTITUDE_PRESETS[0])), [1, 2]);
});

test("manual whole-number drafts validate without changing text while editing", () => {
  const draft = { minHeight: "1500", maxHeight: "3000", ascentStatus: "all" as const };
  const result = validateFilterDraft(draft);
  assert.deepEqual(result, { filters: { minHeight: 1500, maxHeight: 3000, ascentStatus: "all" }, error: null });
  assert.deepEqual(ids(filter(result.filters!)), [3, 4]);
  assert.equal(validateFilterDraft({ ...draft, minHeight: "1501", maxHeight: "2999" }).filters?.minHeight, 1501);
  assert.equal(draft.minHeight, "1500");
});

test("Apply clamps out-of-range whole numbers, but never swaps a reversed range", () => {
  const draft = createFilterDraft(DEFAULT_MAP_FILTERS);
  assert.deepEqual(validateFilterDraft({ ...draft, minHeight: "500", maxHeight: "9000" }).filters, DEFAULT_MAP_FILTERS);
  assert.equal(validateFilterDraft({ ...draft, minHeight: "3000", maxHeight: "1500" }).error, "invalidHeightRange");
  assert.equal(validateFilterDraft({ ...draft, minHeight: "9000", maxHeight: "8850" }).filters, null);
  assert.equal(validateFilterDraft({ ...draft, minHeight: "600", maxHeight: "500" }).filters, null);
});

test("empty, fractional and non-finite inputs can never become applied filters", () => {
  for (const bound of ["minHeight", "maxHeight"] as const) {
    for (const value of ["", "  ", "NaN", "Infinity", "1500.5"]) {
      const result = validateFilterDraft({ ...createFilterDraft(DEFAULT_MAP_FILTERS), [bound]: value });
      assert.equal(result.filters, null);
      assert.ok(result.error);
    }
  }
});

test("Reset restores defaults; draft edits and dismissal cannot mutate applied filters", () => {
  const applied = { minHeight: 1500, maxHeight: 3500, ascentStatus: "climbed" as const };
  const draft = createFilterDraft(applied);
  draft.minHeight = "";
  assert.deepEqual(applied, { minHeight: 1500, maxHeight: 3500, ascentStatus: "climbed" });
  assert.equal(createFilterDraft(applied).minHeight, "1500");
  assert.deepEqual(validateFilterDraft(createFilterDraft(DEFAULT_MAP_FILTERS)).filters, { minHeight: 700, maxHeight: 8850, ascentStatus: "all" });
  const sheet = source("MapFilterSheet.tsx");
  assert.match(sheet, /useState\(\(\) => createFilterDraft\(appliedFilters\)\)/);
  assert.match(sheet, /setDraft\(createFilterDraft\(DEFAULT_MAP_FILTERS\)\)/);
  assert.match(sheet, /if \(result.filters\) onApply\(result.filters\)/);
  assert.match(sheet, /disabled=\{!validFilters\}/);
  assert.match(sheet, /onClick=\{onClose\}/);
  assert.doesNotMatch(sheet, /source\.setData|clearSearch|flyTo/);
});

test("default/custom chip labels and category badges depend only on applied filters", () => {
  assert.equal(hasCustomHeight(DEFAULT_MAP_FILTERS), false);
  assert.equal(hasCustomHeight({ ...DEFAULT_MAP_FILTERS, minHeight: 1500, maxHeight: 3500 }), true);
  assert.equal(activeFilterCount(DEFAULT_MAP_FILTERS), 0);
  assert.equal(activeFilterCount({ ...DEFAULT_MAP_FILTERS, maxHeight: 3000 }), 1);
  assert.equal(activeFilterCount({ ...DEFAULT_MAP_FILTERS, ascentStatus: "climbed" }), 1);
  assert.equal(activeFilterCount({ ...DEFAULT_MAP_FILTERS, maxHeight: 3000, ascentStatus: "climbed" }), 2);
  const bar = source("MapFilterBar.tsx");
  assert.match(bar, /hasCustomHeight\(props.appliedFilters\)/);
  assert.match(bar, /t\("presetRange", \{ min: props.appliedFilters.minHeight, max: props.appliedFilters.maxHeight \}\)/);
  assert.match(bar, /t\("height"\)/);
  assert.match(bar, /t\("status"\)/);
  const de = JSON.parse(source("../../messages/de/map.json")).Map.Filter;
  assert.equal(de.height, "H\u00f6he");
});

test("manual fields, accessible validation and dismissible single popover contracts", () => {
  const fields = source("MapFilterFields.tsx");
  const sheet = source("MapFilterSheet.tsx");
  const bar = source("MapFilterBar.tsx");
  assert.match(fields, /type="number"/);
  assert.match(fields, /min=\{MIN_HEIGHT\} max=\{MAX_HEIGHT\}/);
  assert.match(fields, /onBlur=\{onBlur\}/);
  assert.match(fields, /aria-invalid=\{Boolean\(error\)\}/);
  assert.match(fields, /aria-describedby=/);
  assert.match(fields, /role="alert"/);
  for (const file of [fields, sheet, source("HeightFilter.tsx")]) assert.doesNotMatch(file, /type="range"/);
  assert.match(sheet, /event.key === "Escape"/);
  assert.match(sheet, /trigger.focus/);
  assert.match(sheet, /dialog\?\.showModal/);
  assert.match(sheet, /removeEventListener\("pointerdown"/);
  assert.match(bar, /AnimatePresence mode="wait"/);
  assert.match(bar, /key=\{open.session\}/);
  assert.match(bar, /session: \+\+sessionRef.current/);
  assert.match(sheet, /if \(!mobile\) window.addEventListener\("resize"/);
  assert.match(sheet, /useReducedMotion/);
});

test("map source filtering and cluster/layer contracts stay unchanged", () => {
  const visible = source("useVisibleMountains.ts");
  assert.match(visible, /map\.getSource\("peaks"\)/);
  assert.match(visible, /source\.setData\(filteredGeoJson\)/);
  assert.match(visible, /setVisiblePeakCount\(filteredGeoJson\.features\.length\)/);
  assert.match(visible, /retainVisiblePeak\(currentPeak, filteredGeoJson\)/);
  assert.doesNotMatch(visible, /setFilter\(/);
  assert.match(source("mapSources.ts"), /map\.addSource\("peaks"/);
  assert.match(source("mapSources.ts"), /cluster: true/);
  for (const id of ["clusters", "cluster-count", "individual-peaks"]) {
    assert.ok(source("mapLayers.ts").includes(`id: "${id}"`));
  }
});

test("only minimum height feeds network reload; LOD, debounce and abort guards remain", () => {
  const loader = source("useMountainMap.ts");
  assert.match(loader, /\[minimumHeight, minHeightRef\]/);
  assert.doesNotMatch(loader, /filters\.maxHeight|ascentStatus/);
  assert.match(loader, /getLodMinimumHeight\(/);
  assert.match(loader, /getLodResultLimit\(/);
  assert.match(loader, /isCurrentViewInsideLoadedBounds\(/);
  assert.match(loader, /new AbortController\(\)/);
  assert.match(loader, /loadVersion !== mountainLoadVersionRef\.current/);
  assert.match(loader, /\}, 300\)/);
  assert.match(loader, /reloadMountainsRef\.current = null/);
  assert.doesNotMatch(source("mountainData.ts"), /max_height:/);
});

test("all six filter namespaces have identical keys and valid ICU messages", async () => {
  const { default: IntlMessageFormat } = await import("intl-messageformat");
  let expected: string[] | undefined;
  for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
    const messages = JSON.parse(source(`../../messages/${locale}/map.json`)).Map.Filter;
    expected ??= Object.keys(messages).sort();
    assert.deepEqual(Object.keys(messages).sort(), expected);
    for (const message of Object.values(messages) as string[]) {
      assert.ok(message.length > 0);
      for (const count of [0, 1, 2, 5]) {
        new IntlMessageFormat(message, locale).format({ count, min: 700, max: 8850, height: 4000 });
      }
    }
  }
});
