import { isCountryCode } from "./countries.ts";

export type CountryProgress = {
  countryCode: string | null; totalMountains: number; climbedMountains: number;
  remainingMountains: number; progressPercent: number | null;
};
export type CountryMountain = {
  id: string; name: string | null; nameDe: string | null; height: number | null;
  countryCode: string; climbed: boolean;
};
export type CountryMountainPage = { countryCode: string | null; items: CountryMountain[]; nextCursor: string | null };
export const COUNTRY_PAGE_SIZE = 20;
export const COUNTRY_MAX_PAGE_SIZE = 50;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function normalizeCountryProgress(value: unknown): CountryProgress | null {
  const row = record(value);
  if (!row || !(row.countryCode === null || isCountryCode(row.countryCode)) || !count(row.totalMountains) ||
    !count(row.climbedMountains) || !count(row.remainingMountains) || row.climbedMountains > row.totalMountains ||
    row.remainingMountains !== Math.max(row.totalMountains - row.climbedMountains, 0)) return null;
  const percent = row.progressPercent;
  if (row.totalMountains === 0 ? percent !== null :
    typeof percent !== "number" || !Number.isFinite(percent) || Math.abs(percent - row.climbedMountains / row.totalMountains * 100) > 0.000001) return null;
  if (row.countryCode === null && (row.totalMountains !== 0 || row.climbedMountains !== 0)) return null;
  return row as CountryProgress;
}

export function isMountainCursor(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807");
}
export function normalizeCountryMountainPage(value: unknown): CountryMountainPage | null {
  const row = record(value);
  if (!row || !(row.countryCode === null || isCountryCode(row.countryCode)) || !Array.isArray(row.items) ||
    row.items.length > COUNTRY_MAX_PAGE_SIZE || !(row.nextCursor === null || isMountainCursor(row.nextCursor))) return null;
  if (row.countryCode === null && (row.items.length > 0 || row.nextCursor !== null)) return null;
  const items: CountryMountain[] = [];
  for (const value of row.items) {
    const item = record(value);
    if (!item || !isMountainCursor(item.id) || item.countryCode !== row.countryCode || typeof item.climbed !== "boolean") return null;
    items.push({ id: item.id, name: typeof item.name === "string" ? item.name : null,
      nameDe: typeof item.nameDe === "string" ? item.nameDe : null,
      height: typeof item.height === "number" && Number.isFinite(item.height) ? item.height : null,
      countryCode: item.countryCode as string, climbed: item.climbed });
  }
  return { countryCode: row.countryCode as string | null, items, nextCursor: row.nextCursor as string | null };
}

export function parseCountryMountainFilters(query: Record<string, string | string[] | undefined>) {
  const text = (key: string) => typeof query[key] === "string" ? query[key] as string : "";
  const search = text("search").trim();
  const minText = text("min").trim(); const maxText = text("max").trim();
  const min = minText ? Number(minText) : null; const max = maxText ? Number(maxText) : null;
  const climbed = text("climbed") || "all"; const cursor = text("after") || null;
  if (search.length > 100 || (min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)) ||
    (min !== null && max !== null && min > max) || !["all", "climbed", "unclimbed"].includes(climbed) ||
    (cursor !== null && !isMountainCursor(cursor))) return null;
  return { search, min_height: min, max_height: max, climbed_filter: climbed, after_id: cursor, result_limit: COUNTRY_PAGE_SIZE };
}
