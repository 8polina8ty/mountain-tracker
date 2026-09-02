export type EleParseStatus =
  | "VALID_METERS"
  | "VALID_CONVERTED_FEET"
  | "AMBIGUOUS_ELE"
  | "INVALID_ELE";

export interface EleParseResult {
  status: EleParseStatus;
  raw: string;
  normalizedMeters: number | null;
  feet: number | null;
  reason: string;
}

export const ELE_PLAUSIBLE_MIN_METERS = -430;
export const ELE_PLAUSIBLE_MAX_METERS = 9000;
export const FEET_TO_METERS = 0.3048;

function numberLike(value: string, units: "m" | "ft"): EleParseResult | null {
  if (/[,;]/.test(value)) return null;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (units === "ft") {
    const meters = numeric * FEET_TO_METERS;
    if (meters < ELE_PLAUSIBLE_MIN_METERS || meters > ELE_PLAUSIBLE_MAX_METERS) {
      return {
        status: "INVALID_ELE",
        raw: `${value} ft`,
        normalizedMeters: null,
        feet: numeric,
        reason: "IMP PLAUSIBLE CONVERTED ELEVATION OUT_OF_RANGE",
      };
    }
    return {
      status: "VALID_CONVERTED_FEET",
      raw: `${value} ft`,
      normalizedMeters: round(meters),
      feet: numeric,
      reason: "FEET_CONVERTED_TO_METERS",
    };
  }
  if (numeric < ELE_PLAUSIBLE_MIN_METERS || numeric > ELE_PLAUSIBLE_MAX_METERS) {
    return {
      status: "INVALID_ELE",
      raw: value,
      normalizedMeters: null,
      feet: null,
      reason: "PLAUSIBLE_ELEVATION_OUT_OF_RANGE",
    };
  }
  return {
    status: "VALID_METERS",
    raw: value,
    normalizedMeters: numeric,
    feet: null,
    reason: "METERS",
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const METER_UNIT_MARKERS = [
  /^([0-9]+(\.[0-9]+)?)\s*m$/i,
  /^([0-9]+(\.[0-9]+)?)\s*m\s*\(?[üÜ]\.?\s*[mM]\)?$/i,
  /^([0-9]+(\.[0-9]+)?)\s*m\s*\.?\s*a?\s*\.?\s*s?\s*l?$/i,
  /^([0-9]+(\.[0-9]+)?)\s*m\s*u\s*\.?\s*M\s*\.?$/i,
  /^([0-9]+(\.[0-9]+)?)\s*ü\s*\.\s*M\s*\.?$/i,
  /^([0-9]+(\.[0-9]+)?)\s*Meters$/i,
  /^([0-9]+(\.[0-9]+)?)\s*metres$/i,
];

const FOOT_UNIT_MARKERS = [
  /^([0-9]+(\.[0-9]+)?)\s*ft$/i,
  /^([0-9]+(\.[0-9]+)?)\s*feet$/i,
];

export function normalizeEle(raw: string): EleParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { status: "INVALID_ELE", raw, normalizedMeters: null, feet: null, reason: "EMPTY" };
  }

  for (const marker of METER_UNIT_MARKERS) {
    const match = marker.exec(trimmed);
    if (match) {
      return numberLike(match[1], "m") ?? {
        status: "AMBIGUOUS_ELE", raw, normalizedMeters: null, feet: null, reason: "METER_UNIT_NUMBER_INVALID",
      };
    }
  }

  for (const marker of FOOT_UNIT_MARKERS) {
    const match = marker.exec(trimmed);
    if (match) {
      return numberLike(match[1], "ft") ?? {
        status: "AMBIGUOUS_ELE", raw, normalizedMeters: null, feet: null, reason: "FOOT_UNIT_NUMBER_INVALID",
      };
    }
  }

  const plain = numberLike(trimmed, "m");
  if (plain) return plain;

  if (/[a-zA-Z]/.test(trimmed)) {
    return {
      status: "INVALID_ELE",
      raw,
      normalizedMeters: null,
      feet: null,
      reason: "NON_NUMERIC_UNIT_UNRECOGNIZED",
    };
  }
  if (/[,;]/.test(trimmed)) {
    return {
      status: "AMBIGUOUS_ELE",
      raw,
      normalizedMeters: null,
      feet: null,
      reason: "COMMA_DECIMAL_THOUSANDS_AMBIGUOUS",
    };
  }
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    return {
      status: "AMBIGUOUS_ELE",
      raw,
      normalizedMeters: null,
      feet: null,
      reason: "NUMBER_NON_CONFORMANT",
    };
  }
  return { status: "INVALID_ELE", raw, normalizedMeters: null, feet: null, reason: "UNPARSEABLE" };
}
