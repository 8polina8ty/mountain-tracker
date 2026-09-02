import {
  calculateCoordinateDistanceMeters,
  type Coordinate,
} from "./peak-matcher.ts";
import { normalizeRouteGeometry } from "./route-geometry.ts";
import type { ComparableRoute } from "./route-similarity.ts";

export interface DedupCandidatePair {
  routeAId: string;
  routeBId: string;
  sharedCellCount: number;
  cellCoverageAByB: number;
  cellCoverageBByA: number;
  lengthRatio: number;
  endpointDistanceMeters: number;
  sharedConfirmedSummitIds: string[];
  reasons: string[];
}

export interface DedupCandidateReport {
  totalRoutes: number;
  theoreticalPairs: number;
  spatiallyOverlappingPairs: number;
  candidatePairs: DedupCandidatePair[];
  reductionPercentage: number;
}

export interface DedupRouteSignature {
  sourceId: string;
  confirmedPeakIds: string[];
  lengthMeters: number;
  cells: Set<string>;
  start: Coordinate;
  end: Coordinate;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const CELL_SIZE_METERS = 500;
const SIGNATURE_SAMPLE_METERS = 250;

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function cellCoordinates(coordinate: Coordinate): [number, number, number] {
  const longitude = degreesToRadians(coordinate[0]);
  const latitude = degreesToRadians(coordinate[1]);
  const radius = EARTH_RADIUS_METERS * Math.cos(latitude);
  return [
    Math.floor((radius * Math.cos(longitude)) / CELL_SIZE_METERS),
    Math.floor((radius * Math.sin(longitude)) / CELL_SIZE_METERS),
    Math.floor(
      (EARTH_RADIUS_METERS * Math.sin(latitude)) / CELL_SIZE_METERS,
    ),
  ];
}

function expandedCellKeys(coordinate: Coordinate): string[] {
  const [centerX, centerY, centerZ] = cellCoordinates(coordinate);
  const keys: string[] = [];
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        keys.push(`${centerX + x}:${centerY + y}:${centerZ + z}`);
      }
    }
  }
  return keys;
}

export function createDedupRouteSignature(
  route: ComparableRoute,
): DedupRouteSignature {
  const normalized = normalizeRouteGeometry(route.geometry, {
    resampleIntervalMeters: SIGNATURE_SAMPLE_METERS,
    duplicatePointToleranceMeters: 0.5,
  });
  const nonEmpty = normalized.components.filter(
    (component) => component.length > 0,
  );
  const first = nonEmpty[0];
  const last = nonEmpty.at(-1);
  if (!first || !last) {
    throw new Error(`Route ${route.sourceId} has no geometry for dedup candidates`);
  }
  const cells = new Set<string>();
  normalized.components
    .flat()
    .forEach((coordinate) =>
      expandedCellKeys(coordinate).forEach((key) => cells.add(key)),
    );
  return {
    sourceId: route.sourceId,
    confirmedPeakIds: [...route.summitEvidence.confirmedPeakIds],
    lengthMeters: normalized.lengthMeters,
    cells,
    start: first[0],
    end: last[last.length - 1],
  };
}

function stablePair(left: string, right: string): [string, string] {
  return left.localeCompare(right, "en", { numeric: true }) <= 0
    ? [left, right]
    : [right, left];
}

function pairKey(left: string, right: string): string {
  return JSON.stringify(stablePair(left, right));
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  const [smaller, larger] =
    left.size <= right.size ? [left, right] : [right, left];
  let count = 0;
  smaller.forEach((value) => {
    if (larger.has(value)) {
      count += 1;
    }
  });
  return count;
}

function sharedConfirmedSummits(
  left: DedupRouteSignature,
  right: DedupRouteSignature,
): string[] {
  const rightIds = new Set(right.confirmedPeakIds);
  return [...new Set(left.confirmedPeakIds)]
    .filter((peakId) => rightIds.has(peakId))
    .sort();
}

function endpointDistance(
  left: DedupRouteSignature,
  right: DedupRouteSignature,
): number {
  const forward =
    (calculateCoordinateDistanceMeters(left.start, right.start) +
      calculateCoordinateDistanceMeters(left.end, right.end)) /
    2;
  const reversed =
    (calculateCoordinateDistanceMeters(left.start, right.end) +
      calculateCoordinateDistanceMeters(left.end, right.start)) /
    2;
  return Math.min(forward, reversed);
}

export function generateDedupCandidates(
  routes: ComparableRoute[],
): DedupCandidateReport {
  return generateDedupCandidatesFromSignatures(
    routes.map(createDedupRouteSignature),
  );
}

export function generateDedupCandidatesFromSignatures(
  signatures: DedupRouteSignature[],
): DedupCandidateReport {
  const signatureById = new Map(
    signatures.map((signature) => [signature.sourceId, signature]),
  );
  const routesByCell = new Map<string, string[]>();
  signatures.forEach((signature) =>
    signature.cells.forEach((cell) => {
      const routeIds = routesByCell.get(cell);
      if (routeIds) {
        routeIds.push(signature.sourceId);
      } else {
        routesByCell.set(cell, [signature.sourceId]);
      }
    }),
  );

  const overlappingPairKeys = new Set<string>();
  routesByCell.forEach((routeIds) => {
    const uniqueIds = [...new Set(routeIds)];
    for (let left = 0; left < uniqueIds.length; left += 1) {
      for (let right = left + 1; right < uniqueIds.length; right += 1) {
        overlappingPairKeys.add(pairKey(uniqueIds[left], uniqueIds[right]));
      }
    }
  });

  const confirmedByPeak = new Map<string, string[]>();
  signatures.forEach((signature) =>
    signature.confirmedPeakIds.forEach((peakId) => {
      const routeIds = confirmedByPeak.get(peakId);
      if (routeIds) {
        routeIds.push(signature.sourceId);
      } else {
        confirmedByPeak.set(peakId, [signature.sourceId]);
      }
    }),
  );
  confirmedByPeak.forEach((routeIds) => {
    for (let left = 0; left < routeIds.length; left += 1) {
      for (let right = left + 1; right < routeIds.length; right += 1) {
        overlappingPairKeys.add(pairKey(routeIds[left], routeIds[right]));
      }
    }
  });

  const candidatePairs: DedupCandidatePair[] = [];
  for (const key of [...overlappingPairKeys].sort()) {
    const [routeAId, routeBId] = JSON.parse(key) as [string, string];
    const routeA = signatureById.get(routeAId);
    const routeB = signatureById.get(routeBId);
    if (!routeA || !routeB) {
      continue;
    }
    const sharedCellCount = intersectionSize(routeA.cells, routeB.cells);
    const coverageA = sharedCellCount / routeA.cells.size;
    const coverageB = sharedCellCount / routeB.cells.size;
    const lengthRatio =
      Math.min(routeA.lengthMeters, routeB.lengthMeters) /
      Math.max(routeA.lengthMeters, routeB.lengthMeters);
    const endpoints = endpointDistance(routeA, routeB);
    const sharedSummits = sharedConfirmedSummits(routeA, routeB);
    const spatialCorridor =
      sharedCellCount >= 2 && Math.max(coverageA, coverageB) >= 0.25;
    const nearbyEndpoints = endpoints <= 750;

    if (!spatialCorridor && !nearbyEndpoints && sharedSummits.length === 0) {
      continue;
    }

    const reasons: string[] = [];
    if (spatialCorridor) {
      reasons.push(
        `${sharedCellCount} coarse spatial cells overlap (${(coverageA * 100).toFixed(1)}%/${(coverageB * 100).toFixed(1)}%).`,
      );
    }
    if (nearbyEndpoints) {
      reasons.push(`Direction-independent endpoints are ${endpoints.toFixed(1)} m apart.`);
    }
    if (sharedSummits.length > 0) {
      reasons.push(`Shared confirmed summit IDs: ${sharedSummits.join(", ")}.`);
    }

    candidatePairs.push({
      routeAId,
      routeBId,
      sharedCellCount,
      cellCoverageAByB: Number(coverageA.toFixed(4)),
      cellCoverageBByA: Number(coverageB.toFixed(4)),
      lengthRatio: Number(lengthRatio.toFixed(4)),
      endpointDistanceMeters: Number(endpoints.toFixed(1)),
      sharedConfirmedSummitIds: sharedSummits,
      reasons,
    });
  }

  const theoreticalPairs = (signatures.length * (signatures.length - 1)) / 2;
  return {
    totalRoutes: signatures.length,
    theoreticalPairs,
    spatiallyOverlappingPairs: overlappingPairKeys.size,
    candidatePairs,
    reductionPercentage:
      theoreticalPairs === 0
        ? 100
        : Number(
            ((1 - candidatePairs.length / theoreticalPairs) * 100).toFixed(4),
          ),
  };
}
