// Phase 12E multilingual semantic-name normalization. Versioned, deterministic
// and adversarial-safe: qualifier stripping uses an explicit bounded vocabulary
// and never performs fuzzy, per-route or substring matching.

export const SEMANTIC_NAME_NORMALIZATION_VERSION =
  "mountain-tracker/semantic-name-normalization/v3" as const;

export const SEMANTIC_QUALIFIER_TAXONOMY_VERSION =
  "mountain-tracker/semantic-qualifier-taxonomy/v2" as const;

// Explicit language dictionaries supported by frozen OSM name/status evidence.
// Shared spellings retain all applicable languages; no language is guessed.
export const STATUS_QUALIFIERS: Readonly<Record<string, readonly string[]>> = {
  de: ['verf.', 'verfallen', 'ruine'], en: ['ruin', 'ruins'], fr: ['ruine'], it: ['rudere'],
};
export interface SemanticNameQualifier {
  kind: 'STATUS' | 'ELEVATION' | 'FEATURE'; rawValue: string; normalizedValue: string;
  languages: string[]; taxonomyVersion: typeof SEMANTIC_QUALIFIER_TAXONOMY_VERSION;
}
export function semanticNameParts(rawValue: string): { rawValue: string; identityName: string; qualifiers: SemanticNameQualifier[] } {
  const normalized = normalizeSemanticName(rawValue);
  const match = rawValue.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  const qualifier = match?.[2] ?? '';
  const value = normalizeSemanticName(qualifier);
  const languages = value.length <= 40 ? Object.entries(STATUS_QUALIFIERS).filter(([, terms]) => terms.includes(value)).map(([language]) => language).sort() : [];
  if (match?.[1].trim() && languages.length) return { rawValue, identityName: normalizeSemanticName(match[1]),
    qualifiers: [{ kind: 'STATUS', rawValue: qualifier, normalizedValue: value, languages, taxonomyVersion: SEMANTIC_QUALIFIER_TAXONOMY_VERSION }] };
  const existing = withoutWhitelistedTrailingQualifier(rawValue);
  if (existing.stripped && qualifier) return { rawValue, identityName: normalizeSemanticName(existing.stripped), qualifiers: [{
    kind: elevationQualifierMeters(rawValue) === null ? 'FEATURE' : 'ELEVATION', rawValue: qualifier,
    normalizedValue: value, languages: [], taxonomyVersion: SEMANTIC_QUALIFIER_TAXONOMY_VERSION }] };
  return { rawValue, identityName: normalized, qualifiers: [] };
}

const QUALIFIER_STRUCTURAL_TERMS = new Set([
  "bivio",
  "centro paese",
  "palazzo comunale",
  "trampolino",
  "stazione",
  "frazione",
  "parcheggio",
  "rifugio",
  "seggiovia",
]);

const ALTITUDE_WORDS = new Set([
  "quota",
  "altitudine",
  "altitude",
  "höhe",
  "hoehe",
  "elevation",
]);

const ALTITUDE_UNIT_PATTERN =
  /\b\d+(?:[.,]\d+)?\s*(?:m|mt|meter|metri|metres|s\.l\.m|s\.m|m\.s\.l\.m|ü\.?\s*m|ue\.?\s*m|m\.?)\b/i;

export interface SemanticQualifierDecision {
  stripped: string | null;
  reason: "NOT_TRAILING" | "NOT_WHITELISTED" | "EMPTY_AFTER_STRIP" | null;
}

export function isWhitelistedQualifier(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (ALTITUDE_UNIT_PATTERN.test(normalized)) return true;
  if (ALTITUDE_WORDS.has(normalized)) return true;
  if (ALTITUDE_WORDS.has(normalized.split(/\s+/)[0] ?? "")) return true;
  const head = normalized.split(/\s+/)[0] ?? "";
  const joined = normalized.split(/\s+/).join(" ");
  return QUALIFIER_STRUCTURAL_TERMS.has(head) || QUALIFIER_STRUCTURAL_TERMS.has(joined);
}

export function withoutWhitelistedTrailingQualifier(
  value: string,
): SemanticQualifierDecision {
  const normalized = value.normalize("NFKC").replaceAll(/\s+/g, " ").trim();
  const parenthetical = normalized.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (parenthetical) {
    if (!isWhitelistedQualifier(parenthetical[2] ?? "")) {
      return { stripped: null, reason: "NOT_WHITELISTED" };
    }
    const base = (parenthetical[1] ?? "").trim();
    if (!base) return { stripped: null, reason: "EMPTY_AFTER_STRIP" };
    return { stripped: base, reason: null };
  }
  const comma = normalized.match(/^(.*?),\s*([^,()]*)$/);
  if (comma) {
    if (!isWhitelistedQualifier(comma[2] ?? "")) {
      return { stripped: null, reason: "NOT_WHITELISTED" };
    }
    const base = (comma[1] ?? "").trim();
    if (!base) return { stripped: null, reason: "EMPTY_AFTER_STRIP" };
    return { stripped: base, reason: null };
  }
  return { stripped: null, reason: "NOT_TRAILING" };
}

export function normalizeSemanticName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll(/[‘’ʼ]/g, "'")
    .replaceAll(/[‐‑–—]/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export type SemanticNameVariant =
  | { kind: "EXACT_OSM_NAME"; name: string }
  | { kind: "NAME_VARIANT"; name: string }
  | { kind: "STATUS_QUALIFIER_STRIPPED"; name: string }
  | { kind: "QUALIFIER_STRIPPED"; name: string };

export function candidateSemanticNames(
  hintName: string,
  maximumCandidates = 4,
): SemanticNameVariant[] {
  const primary = normalizeSemanticName(hintName);
  if (!primary) return [];
  const out: SemanticNameVariant[] = [{ kind: "EXACT_OSM_NAME", name: primary }];
  const parts = semanticNameParts(hintName);
  if (parts.qualifiers.some(q => q.kind === 'STATUS') && parts.identityName !== primary) {
    out.push({ kind: 'STATUS_QUALIFIER_STRIPPED', name: parts.identityName });
  }
  const qualifier = withoutWhitelistedTrailingQualifier(primary);
  if (
    qualifier.stripped &&
    qualifier.stripped !== primary &&
    !out.some((entry) => entry.name === qualifier.stripped)
  ) {
    out.push({ kind: "QUALIFIER_STRIPPED", name: qualifier.stripped });
  }
  return out.slice(0, Math.max(1, maximumCandidates));
}

export function featureNameVariants(
  tags: Readonly<Record<string, string>>,
): string[] {
  const variants = new Set<string>();
  for (const [key, value] of Object.entries(tags)) {
    if (!/^(?:name|official_name|short_name|alt_name|local_name|loc_name|reg_name|old_name)(?:[:.].*)?$/.test(key)) {
      continue;
    }
    for (const part of value.split(";")) {
      const normalized = normalizeSemanticName(part);
      if (normalized) variants.add(normalized);
    }
  }
  return [...variants].sort();
}

export function elevationQualifierMeters(value: string): number | null {
  const qualifier = value.match(/\(([^()]*)\)\s*$/)?.[1] ?? '';
  const match = qualifier.match(/(?:quota|altitude|altitudine|höhe|hoehe|elevation)?\s*(-?\d{1,4}(?:[.,]\d+)?)\s*(?:m|mt|metri|meters?|metres?)\b/i);
  if (!match) return null;
  const meters = Number(match[1].replace(',', '.'));
  return Number.isFinite(meters) && meters >= -500 && meters <= 9000 ? meters : null;
}
