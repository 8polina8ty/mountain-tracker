import { MAX_HEIGHT, MIN_HEIGHT } from "./constants.ts";
import { normalizeText } from "./peakUtils.ts";
import type { MountainMapFilters, PeakFeatureCollection, PeakProperties, SelectedPeak } from "./types.ts";

export const DEFAULT_MAP_FILTERS: MountainMapFilters = {
  minHeight: MIN_HEIGHT,
  maxHeight: MAX_HEIGHT,
  ascentStatus: "all",
};

export const ALTITUDE_PRESETS = [
  { minHeight: 700, maxHeight: 999 },
  { minHeight: 1000, maxHeight: 1999 },
  { minHeight: 2000, maxHeight: 2999 },
  { minHeight: 3000, maxHeight: 3999 },
  { minHeight: 4000, maxHeight: MAX_HEIGHT },
] as const;

export type MountainFilterDraft = {
  minHeight: string;
  maxHeight: string;
  ascentStatus: MountainMapFilters["ascentStatus"];
};

export function createFilterDraft(filters: MountainMapFilters): MountainFilterDraft {
  return { ...filters, minHeight: String(filters.minHeight), maxHeight: String(filters.maxHeight) };
}

export function validateFilterDraft(draft: MountainFilterDraft): {
  filters: MountainMapFilters | null;
  error: "requiredHeight" | "wholeHeight" | "invalidHeightRange" | null;
} {
  if (!draft.minHeight.trim() || !draft.maxHeight.trim()) {
    return { filters: null, error: "requiredHeight" };
  }
  const min = Number(draft.minHeight);
  const max = Number(draft.maxHeight);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isInteger(min) || !Number.isInteger(max)) {
    return { filters: null, error: "wholeHeight" };
  }
  if (min > max) return { filters: null, error: "invalidHeightRange" };
  const clamp = (height: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
  return {
    filters: { minHeight: clamp(min), maxHeight: clamp(max), ascentStatus: draft.ascentStatus },
    error: null,
  };
}

export function hasCustomHeight(filters: MountainMapFilters): boolean {
  return filters.minHeight !== MIN_HEIGHT || filters.maxHeight !== MAX_HEIGHT;
}

export function activeFilterCount(filters: MountainMapFilters): number {
  return Number(hasCustomHeight(filters))
    + Number(filters.ascentStatus !== "all");
}

export function matchesMountainFilters(
  properties: PeakProperties,
  filters: MountainMapFilters,
  climbedMountainIds: ReadonlySet<number>,
  normalizedSearch = "",
): boolean {
  const height = Number(properties.height);
  const climbed = climbedMountainIds.has(Number(properties.id));
  return height >= filters.minHeight && height <= filters.maxHeight
    && (filters.ascentStatus === "all"
      || (filters.ascentStatus === "climbed" ? climbed : !climbed))
    && (!normalizedSearch || [properties.name, properties.name_de].some(
      (name) => name && normalizeText(name).includes(normalizedSearch),
    ));
}

export function filterMountainsInView(
  original: PeakFeatureCollection,
  bounds: { west: number; south: number; east: number; north: number },
  filters: MountainMapFilters,
  climbedMountainIds: ReadonlySet<number>,
  appliedSearch: string,
): PeakFeatureCollection {
  const search = normalizeText(appliedSearch);
  return {
    type: "FeatureCollection",
    features: original.features.filter((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      return longitude >= bounds.west && longitude <= bounds.east
        && latitude >= bounds.south && latitude <= bounds.north
        && matchesMountainFilters(feature.properties, filters, climbedMountainIds, search);
    }).map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        climbed: climbedMountainIds.has(Number(feature.properties.id)),
      },
    })),
  };
}

export function retainVisiblePeak(
  selected: SelectedPeak | null,
  filtered: PeakFeatureCollection,
): SelectedPeak | null {
  if (selected?.selectionSource === "search") return selected;
  return selected && filtered.features.some(
    (feature) => Number(feature.properties.osm_id) === Number(selected.osm_id),
  ) ? selected : null;
}
