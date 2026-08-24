export const COMMUNITY_ROUTE_TITLE_MAX = 120;
export const COMMUNITY_ROUTE_SUMMARY_MAX = 300;
export const COMMUNITY_ROUTE_DESCRIPTION_MAX = 8000;
export const COMMUNITY_ROUTE_START_LOCATION_MAX = 200;
export const COMMUNITY_ROUTE_DIFFICULTY_SYSTEM_MAX = 40;
export const COMMUNITY_ROUTE_DIFFICULTY_VALUE_MAX = 40;
export const COMMUNITY_ROUTE_BEST_SEASON_MAX = 500;
export const COMMUNITY_ROUTE_EQUIPMENT_MAX = 4000;
export const COMMUNITY_ROUTE_WARNINGS_MAX = 4000;
export const COMMUNITY_ROUTE_CONDITIONS_NOTES_MAX = 4000;

export const COMMUNITY_ROUTE_TYPES = [
  "hiking", "mountaineering", "via_ferrata", "climbing", "ski_touring", "mixed", "other",
] as const;
export type CommunityRouteType = (typeof COMMUNITY_ROUTE_TYPES)[number];

export const COMMUNITY_ROUTE_EDITABLE_FIELDS = [
  "title", "summary", "description", "start_location", "route_type", "difficulty_system",
  "difficulty_value", "best_season", "equipment", "warnings", "conditions_notes",
] as const;

export type CommunityRouteContent = {
  title: string; summary: string | null; description: string | null; start_location: string | null;
  route_type: CommunityRouteType | null; difficulty_system: string | null; difficulty_value: string | null;
  best_season: string | null; equipment: string | null; warnings: string | null; conditions_notes: string | null;
};
export type CommunityRouteContentError = "invalid_body" | "unknown_field" | "required" | "too_long" | "invalid_route_type";

const limits: Record<keyof CommunityRouteContent, number> = {
  title: COMMUNITY_ROUTE_TITLE_MAX, summary: COMMUNITY_ROUTE_SUMMARY_MAX,
  description: COMMUNITY_ROUTE_DESCRIPTION_MAX, start_location: COMMUNITY_ROUTE_START_LOCATION_MAX,
  route_type: 32, difficulty_system: COMMUNITY_ROUTE_DIFFICULTY_SYSTEM_MAX,
  difficulty_value: COMMUNITY_ROUTE_DIFFICULTY_VALUE_MAX, best_season: COMMUNITY_ROUTE_BEST_SEASON_MAX,
  equipment: COMMUNITY_ROUTE_EQUIPMENT_MAX, warnings: COMMUNITY_ROUTE_WARNINGS_MAX,
  conditions_notes: COMMUNITY_ROUTE_CONDITIONS_NOTES_MAX,
};

function optionalText(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value.trim() || null : undefined;
}

export function validateCommunityRouteContent(input: unknown):
  | { ok: true; value: CommunityRouteContent }
  | { ok: false; error: CommunityRouteContentError; field?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_body" };
  const source = input as Record<string, unknown>;
  const allowed = new Set<string>(COMMUNITY_ROUTE_EDITABLE_FIELDS);
  const unknown = Object.keys(source).find((key) => !allowed.has(key));
  if (unknown) return { ok: false, error: "unknown_field", field: unknown };
  if (typeof source.title !== "string" || source.title.trim().length === 0) return { ok: false, error: "required", field: "title" };

  const result = {} as CommunityRouteContent;
  for (const field of COMMUNITY_ROUTE_EDITABLE_FIELDS) {
    const value = field === "title" ? source.title.trim() : optionalText(source[field]);
    if (value === undefined) return { ok: false, error: "invalid_body", field };
    if (value !== null && value.length > limits[field]) return { ok: false, error: "too_long", field };
    (result as Record<string, unknown>)[field] = value;
  }
  if (result.route_type !== null && !COMMUNITY_ROUTE_TYPES.some((type) => type === result.route_type)) {
    return { ok: false, error: "invalid_route_type", field: "route_type" };
  }
  return { ok: true, value: result };
}
