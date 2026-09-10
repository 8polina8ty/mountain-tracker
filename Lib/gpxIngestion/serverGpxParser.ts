import sax, { type QualifiedAttribute, type QualifiedTag } from "sax";

import {
  GpxNormalizationError,
  normalizeServerGpx,
  type NormalizeGeometryOptions,
} from "./gpxNormalization.ts";
import { sanitizeMetadata } from "./metadataSanitization.ts";
import {
  DEFAULT_SERVER_GPX_LIMITS,
  ServerGpxError,
  validateServerGpxParserLimits,
  type ServerGpxErrorCode,
  type ServerGpxParser,
  type ServerGpxParserLimits,
  type ServerParsedGpx,
} from "./parserContract.ts";
import type {
  GpxNormalizationFlag,
  NormalizedServerGpx,
  ParsedGpxPoint,
} from "./types.ts";

export const SERVER_GPX_PARSER_NAME = "sax";
export const SERVER_GPX_PARSER_VERSION = "sax@1.6.1/phase12b-v1";

const GPX_NAMESPACE_URIS = new Set([
  "",
  "http://www.topografix.com/GPX/1/0",
  "http://www.topografix.com/GPX/1/1",
]);
const STRICT_DECIMAL =
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

type ElementFrame = {
  local: string;
  uri: string;
};

type PendingPoint = {
  point: ParsedGpxPoint;
  elevationSeen: boolean;
  timeSeen: boolean;
};

export class SaxServerGpxParser implements ServerGpxParser {
  readonly parserName = SERVER_GPX_PARSER_NAME;
  readonly parserVersion = SERVER_GPX_PARSER_VERSION;

  async parse(
    rawBytes: Uint8Array,
    limits: ServerGpxParserLimits,
  ): Promise<ServerParsedGpx> {
    validateServerGpxParserLimits(limits);
    if (rawBytes.byteLength > limits.maximumRawBytes) {
      throw new ServerGpxError(
        "INPUT_TOO_LARGE",
        `GPX input exceeds the ${limits.maximumRawBytes}-byte limit.`,
      );
    }
    if (rawBytes.byteLength === 0) {
      throw new ServerGpxError("INVALID_XML", "GPX input is empty.");
    }

    const xml = decodeUtf8(rawBytes);
    rejectForbiddenDeclarations(xml);
    rejectUnsupportedDeclaredEncoding(xml);

    const elementStack: ElementFrame[] = [];
    const segments: ServerParsedGpx["segments"] = [];
    const flags = new Set<GpxNormalizationFlag>();
    let rootNamespace: string | null = null;
    let rootSeen = false;
    let trackCount = 0;
    let segmentCount = 0;
    let pointCount = 0;
    let routeElementSeen = false;
    let currentSegment: ParsedGpxPoint[] | null = null;
    let currentPoint: PendingPoint | null = null;
    let capturedElement: "name" | "ele" | "time" | null = null;
    let capturedText = "";
    let trackName: string | null = null;

    const parser = sax.parser(true, {
      xmlns: true,
      position: false,
      strictEntities: true,
      maxEntityCount: 64,
      maxEntityDepth: 2,
    });

    parser.onerror = () => {
      throw new ServerGpxError("INVALID_XML", "GPX contains malformed XML.");
    };
    parser.ondoctype = () => {
      throw new ServerGpxError(
        "DOCTYPE_NOT_ALLOWED",
        "DOCTYPE declarations are not allowed in GPX input.",
      );
    };
    parser.onsgmldeclaration = (declaration) => {
      throw new ServerGpxError(
        declaration.trimStart().toUpperCase().startsWith("ENTITY")
          ? "ENTITY_NOT_ALLOWED"
          : "INVALID_XML",
        "SGML and ENTITY declarations are not allowed in GPX input.",
      );
    };
    parser.onopentag = (tag) => {
      if (Object.keys(tag.attributes).length > limits.maximumAttributesPerElement) {
        throw new ServerGpxError(
          "ATTRIBUTE_LIMIT_EXCEEDED",
          "A GPX element exceeds the attribute-count limit.",
        );
      }
      const frame = frameForTag(tag);
      elementStack.push(frame);
      if (elementStack.length > limits.maximumElementDepth) {
        throw new ServerGpxError(
          "NESTING_LIMIT_EXCEEDED",
          "GPX element nesting exceeds the configured limit.",
        );
      }

      if (elementStack.length === 1) {
        rootSeen = frame.local === "gpx";
        rootNamespace = frame.uri;
        if (!rootSeen || !GPX_NAMESPACE_URIS.has(frame.uri)) {
          throw new ServerGpxError(
            "UNSUPPORTED_GPX",
            "The XML root is not a supported GPX 1.0/1.1 document.",
          );
        }
        return;
      }
      if (frame.uri !== rootNamespace) return;

      if (frame.local === "rte" || frame.local === "rtept") {
        routeElementSeen = true;
      }
      if (isPath(elementStack, "gpx", "trk")) {
        trackCount += 1;
        if (trackCount > 1) flags.add("MULTIPLE_TRACKS");
      } else if (isPath(elementStack, "gpx", "trk", "name")) {
        beginCapture("name");
      } else if (isPath(elementStack, "gpx", "trk", "trkseg")) {
        segmentCount += 1;
        if (segmentCount > limits.maximumSegments) {
          throw new ServerGpxError(
            "TOO_MANY_SEGMENTS",
            `GPX exceeds the ${limits.maximumSegments}-segment limit.`,
          );
        }
        currentSegment = [];
      } else if (isPath(elementStack, "gpx", "trk", "trkseg", "trkpt")) {
        if (currentSegment === null || currentPoint !== null) {
          throw new ServerGpxError(
            "UNSUPPORTED_GPX",
            "GPX track points must be direct children of a track segment.",
          );
        }
        pointCount += 1;
        if (pointCount > limits.maximumTrackPoints) {
          throw new ServerGpxError(
            "TOO_MANY_POINTS",
            `GPX exceeds the ${limits.maximumTrackPoints}-point limit.`,
          );
        }
        currentPoint = {
          point: {
            coordinate: parseCoordinateAttributes(tag.attributes),
            time: null,
          },
          elevationSeen: false,
          timeSeen: false,
        };
      } else if (
        isPath(elementStack, "gpx", "trk", "trkseg", "trkpt", "ele")
      ) {
        if (currentPoint === null || currentPoint.elevationSeen) {
          throw new ServerGpxError(
            "INVALID_ELEVATION",
            "A GPX track point contains an invalid elevation structure.",
          );
        }
        currentPoint.elevationSeen = true;
        beginCapture("ele");
      } else if (
        isPath(elementStack, "gpx", "trk", "trkseg", "trkpt", "time")
      ) {
        if (currentPoint === null || currentPoint.timeSeen) {
          flags.add("MALFORMED_TIMESTAMP_DROPPED");
          return;
        }
        currentPoint.timeSeen = true;
        beginCapture("time");
      }
    };

    parser.ontext = appendCapturedText;
    parser.oncdata = appendCapturedText;
    parser.onclosetag = () => {
      if (isPath(elementStack, "gpx", "trk", "name") && capturedElement === "name") {
        const sanitizedName = sanitizeMetadata({ name: capturedText }).name;
        if (trackName === null && sanitizedName !== null) trackName = sanitizedName;
        endCapture();
      } else if (
        isPath(elementStack, "gpx", "trk", "trkseg", "trkpt", "ele") &&
        capturedElement === "ele"
      ) {
        if (currentPoint === null) {
          throw new ServerGpxError("INVALID_ELEVATION", "Elevation has no track point.");
        }
        const elevation = parseFiniteDecimal(
          capturedText,
          "INVALID_ELEVATION",
          "GPX contains an invalid elevation.",
        );
        const coordinate = currentPoint.point.coordinate;
        currentPoint.point.coordinate = [coordinate[0], coordinate[1], elevation];
        endCapture();
      } else if (
        isPath(elementStack, "gpx", "trk", "trkseg", "trkpt", "time") &&
        capturedElement === "time"
      ) {
        if (currentPoint !== null) {
          const timestamp = normalizeTimestamp(capturedText);
          if (timestamp === null) flags.add("MALFORMED_TIMESTAMP_DROPPED");
          currentPoint.point.time = timestamp;
        }
        endCapture();
      } else if (isPath(elementStack, "gpx", "trk", "trkseg", "trkpt")) {
        if (currentSegment === null || currentPoint === null) {
          throw new ServerGpxError(
            "UNSUPPORTED_GPX",
            "GPX track point structure is invalid.",
          );
        }
        currentSegment.push(currentPoint.point);
        currentPoint = null;
      } else if (isPath(elementStack, "gpx", "trk", "trkseg")) {
        if (currentSegment === null) {
          throw new ServerGpxError(
            "UNSUPPORTED_GPX",
            "GPX track segment structure is invalid.",
          );
        }
        if (currentSegment.length > 0) segments.push({ points: currentSegment });
        currentSegment = null;
      }
      elementStack.pop();
    };

    function beginCapture(element: "name" | "ele" | "time"): void {
      capturedElement = element;
      capturedText = "";
    }

    function endCapture(): void {
      capturedElement = null;
      capturedText = "";
    }

    function appendCapturedText(text: string): void {
      if (capturedElement === null) return;
      const limit =
        capturedElement === "name" ? limits.maximumMetadataCharacters : 256;
      if (capturedText.length + text.length > limit) {
        throw new ServerGpxError(
          capturedElement === "name" ? "METADATA_TOO_LARGE" : "INVALID_XML",
          "A retained GPX text field exceeds its configured limit.",
        );
      }
      capturedText += text;
    }

    try {
      parser.write(xml).close();
    } catch (error) {
      if (error instanceof ServerGpxError) throw error;
      throw new ServerGpxError("INVALID_XML", "GPX contains malformed XML.");
    }

    if (!rootSeen) {
      throw new ServerGpxError("UNSUPPORTED_GPX", "No supported GPX root was found.");
    }
    if (routeElementSeen) {
      throw new ServerGpxError(
        "UNSUPPORTED_GPX",
        "GPX route elements (rte/rtept) are not supported by Phase 12B.",
      );
    }
    if (trackCount === 0) {
      throw new ServerGpxError(
        "UNSUPPORTED_GPX",
        "GPX contains no track (trk) elements.",
      );
    }
    if (pointCount === 0 || segments.length === 0) {
      throw new ServerGpxError("NO_TRACK_POINTS", "GPX contains no track points.");
    }

    return {
      segments,
      trackName,
      flags: [...flags].sort(),
    };
  }
}

export async function parseAndNormalizeServerGpx(
  rawBytes: Uint8Array,
  limitOverrides: Partial<ServerGpxParserLimits> = {},
): Promise<NormalizedServerGpx> {
  const limits = validateServerGpxParserLimits({
    ...DEFAULT_SERVER_GPX_LIMITS,
    ...limitOverrides,
  });
  const parser = new SaxServerGpxParser();
  const parsed = await parser.parse(rawBytes, limits);
  const normalizationLimits: Partial<NormalizeGeometryOptions> = {
    maximumTrackPoints: limits.maximumTrackPoints,
    maximumSegments: limits.maximumSegments,
  };
  try {
    return normalizeServerGpx(rawBytes, parsed, normalizationLimits);
  } catch (error) {
    if (!(error instanceof GpxNormalizationError)) throw error;
    throw mapNormalizationError(error);
  }
}

function frameForTag(tag: QualifiedTag): ElementFrame {
  return {
    local: tag.local || tag.name.split(":").at(-1) || "",
    uri: tag.uri || "",
  };
}

function isPath(stack: ElementFrame[], ...parts: string[]): boolean {
  if (stack.length !== parts.length) return false;
  const namespace = stack[0]?.uri;
  return parts.every(
    (part, index) =>
      stack[index].local === part && stack[index].uri === namespace,
  );
}

function parseCoordinateAttributes(
  attributes: Record<string, QualifiedAttribute>,
): readonly [number, number] {
  const latitude = findUnqualifiedAttribute(attributes, "lat");
  const longitude = findUnqualifiedAttribute(attributes, "lon");
  if (latitude === null || longitude === null) {
    throw new ServerGpxError(
      "INVALID_COORDINATE",
      "A GPX track point is missing latitude or longitude.",
    );
  }
  const parsedLatitude = parseFiniteDecimal(
    latitude,
    "INVALID_COORDINATE",
    "GPX contains an invalid latitude.",
  );
  const parsedLongitude = parseFiniteDecimal(
    longitude,
    "INVALID_COORDINATE",
    "GPX contains an invalid longitude.",
  );
  if (parsedLatitude < -90 || parsedLatitude > 90) {
    throw new ServerGpxError(
      "INVALID_COORDINATE",
      "GPX contains an out-of-range latitude.",
    );
  }
  if (parsedLongitude < -180 || parsedLongitude > 180) {
    throw new ServerGpxError(
      "INVALID_COORDINATE",
      "GPX contains an out-of-range longitude.",
    );
  }
  return [parsedLongitude, parsedLatitude];
}

function findUnqualifiedAttribute(
  attributes: Record<string, QualifiedAttribute>,
  name: string,
): string | null {
  for (const attribute of Object.values(attributes)) {
    if ((attribute.local || attribute.name) === name && !attribute.uri) {
      return attribute.value;
    }
  }
  return null;
}

function parseFiniteDecimal(
  raw: string,
  code: ServerGpxErrorCode,
  message: string,
): number {
  const value = raw.trim();
  if (!STRICT_DECIMAL.test(value)) throw new ServerGpxError(code, message);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ServerGpxError(code, message);
  return parsed;
}

function normalizeTimestamp(raw: string): string | null {
  const value = raw.trim();
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
      return null;
    }
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function decodeUtf8(rawBytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    throw new ServerGpxError("INVALID_XML", "GPX input is not valid UTF-8.");
  }
}

function rejectForbiddenDeclarations(xml: string): void {
  if (/<!\s*ENTITY\b/i.test(xml)) {
    throw new ServerGpxError(
      "ENTITY_NOT_ALLOWED",
      "ENTITY declarations are not allowed in GPX input.",
    );
  }
  if (/<!\s*DOCTYPE\b/i.test(xml)) {
    throw new ServerGpxError(
      "DOCTYPE_NOT_ALLOWED",
      "DOCTYPE declarations are not allowed in GPX input.",
    );
  }
}

function rejectUnsupportedDeclaredEncoding(xml: string): void {
  const declaration = /^\s*<\?xml\s+([^?]+)\?>/i.exec(xml);
  const encoding = declaration?.[1].match(/\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    throw new ServerGpxError(
      "INVALID_XML",
      "Phase 12B accepts only UTF-8 GPX input.",
    );
  }
}

function mapNormalizationError(error: GpxNormalizationError): ServerGpxError {
  const code: ServerGpxErrorCode =
    error.code === "TOO_FEW_POINTS"
      ? "INSUFFICIENT_GEOMETRY"
      : error.code === "POINT_LIMIT_EXCEEDED"
        ? "TOO_MANY_POINTS"
        : error.code === "SEGMENT_LIMIT_EXCEEDED"
          ? "TOO_MANY_SEGMENTS"
          : error.code === "INVALID_COORDINATE"
            ? "INVALID_COORDINATE"
            : error.code === "INVALID_ELEVATION"
              ? "INVALID_ELEVATION"
              : "NO_TRACK_POINTS";
  return new ServerGpxError(code, "GPX normalization failed validation.");
}
