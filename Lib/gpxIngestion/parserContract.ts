import type { GpxNormalizationFlag, ParsedGpxSegment } from "./types.ts";

export type ServerGpxErrorCode =
  | "INPUT_TOO_LARGE"
  | "INVALID_XML"
  | "DOCTYPE_NOT_ALLOWED"
  | "ENTITY_NOT_ALLOWED"
  | "UNSUPPORTED_GPX"
  | "NO_TRACK_POINTS"
  | "TOO_MANY_POINTS"
  | "TOO_MANY_SEGMENTS"
  | "METADATA_TOO_LARGE"
  | "NESTING_LIMIT_EXCEEDED"
  | "ATTRIBUTE_LIMIT_EXCEEDED"
  | "INVALID_COORDINATE"
  | "INVALID_ELEVATION"
  | "INSUFFICIENT_GEOMETRY";

export class ServerGpxError extends Error {
  readonly code: ServerGpxErrorCode;

  constructor(code: ServerGpxErrorCode, message: string) {
    super(message);
    this.name = "ServerGpxError";
    this.code = code;
  }
}

export interface ServerGpxParserLimits {
  maximumRawBytes: number;
  maximumTrackPoints: number;
  maximumSegments: number;
  maximumMetadataCharacters: number;
  maximumElementDepth: number;
  maximumAttributesPerElement: number;
}

export const DEFAULT_SERVER_GPX_LIMITS: Readonly<ServerGpxParserLimits> = {
  maximumRawBytes: 25 * 1024 * 1024,
  maximumTrackPoints: 250_000,
  maximumSegments: 10_000,
  maximumMetadataCharacters: 64_000,
  maximumElementDepth: 128,
  maximumAttributesPerElement: 64,
};

export interface ServerParsedGpx {
  segments: ParsedGpxSegment[];
  trackName: string | null;
  flags: GpxNormalizationFlag[];
}

/**
 * Implementations consume bytes without browser globals. They must preserve
 * trkseg boundaries, disable/reject DTDs and entities, avoid external I/O, and
 * enforce every supplied resource limit.
 */
export interface ServerGpxParser {
  readonly parserName: string;
  readonly parserVersion: string;
  parse(rawBytes: Uint8Array, limits: ServerGpxParserLimits): Promise<ServerParsedGpx>;
}

export function validateServerGpxParserLimits(
  limits: ServerGpxParserLimits,
): ServerGpxParserLimits {
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error("All server GPX parser limits must be positive safe integers.");
  }
  if (limits.maximumRawBytes > 100 * 1024 * 1024) {
    throw new Error("maximumRawBytes exceeds the Phase 12 safety ceiling.");
  }
  if (limits.maximumTrackPoints > 1_000_000) {
    throw new Error("maximumTrackPoints exceeds the Phase 12 safety ceiling.");
  }
  if (limits.maximumSegments > 100_000) {
    throw new Error("maximumSegments exceeds the Phase 12 safety ceiling.");
  }
  if (limits.maximumMetadataCharacters > 1_000_000) {
    throw new Error("maximumMetadataCharacters exceeds the Phase 12 safety ceiling.");
  }
  if (limits.maximumElementDepth > 512) {
    throw new Error("maximumElementDepth exceeds the Phase 12 safety ceiling.");
  }
  if (limits.maximumAttributesPerElement > 256) {
    throw new Error("maximumAttributesPerElement exceeds the Phase 12 safety ceiling.");
  }
  return limits;
}
