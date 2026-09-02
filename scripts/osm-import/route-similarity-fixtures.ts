import type { Coordinate, RouteGeometry } from "./peak-matcher.ts";
import { reverseRouteGeometry } from "./route-geometry.ts";
import type {
  ComparableRoute,
  RouteSimilarityClassification,
} from "./route-similarity.ts";

export interface RouteSimilarityFixture {
  fixtureId: string;
  description: string;
  route: ComparableRoute;
  acceptableClassifications: RouteSimilarityClassification[];
}

const EARTH_RADIUS_METERS = 6_371_008.8;

function components(geometry: RouteGeometry): Coordinate[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

function geometryFromComponents(
  sourceGeometry: RouteGeometry,
  coordinates: Coordinate[][],
): RouteGeometry {
  return sourceGeometry.type === "LineString"
    ? { type: "LineString", coordinates: coordinates[0] }
    : { type: "MultiLineString", coordinates };
}

function copyGeometry(geometry: RouteGeometry): RouteGeometry {
  return geometryFromComponents(
    geometry,
    components(geometry).map((component) =>
      component.map((coordinate) => [...coordinate] as Coordinate),
    ),
  );
}

function routeVariant(
  base: ComparableRoute,
  fixtureId: string,
  geometry: RouteGeometry,
  retainSummitEvidence = true,
): ComparableRoute {
  return {
    sourceId: `fixture-${fixtureId}`,
    name: `${base.name} fixture ${fixtureId}`,
    geometry,
    summitEvidence: retainSummitEvidence
      ? {
          confirmedPeakIds: [...base.summitEvidence.confirmedPeakIds],
          associatedPeakIds: [...base.summitEvidence.associatedPeakIds],
        }
      : { confirmedPeakIds: [], associatedPeakIds: [] },
  };
}

function reducePointDensity(geometry: RouteGeometry): RouteGeometry {
  return geometryFromComponents(
    geometry,
    components(geometry).map((component) => {
      if (component.length <= 2) {
        return [...component];
      }

      const reduced = component.filter(
        (_coordinate, index) => index === 0 || index % 3 === 0,
      );
      const finalCoordinate = component[component.length - 1];
      if (reduced[reduced.length - 1] !== finalCoordinate) {
        reduced.push(finalCoordinate);
      }
      return reduced;
    }),
  );
}

function offsetCoordinate(
  coordinate: Coordinate,
  eastMeters: number,
  northMeters: number,
): Coordinate {
  const latitudeRadians = (coordinate[1] * Math.PI) / 180;
  return [
    coordinate[0] +
      (eastMeters / (EARTH_RADIUS_METERS * Math.cos(latitudeRadians))) *
        (180 / Math.PI),
    coordinate[1] +
      (northMeters / EARTH_RADIUS_METERS) * (180 / Math.PI),
  ];
}

function addSmallNoise(geometry: RouteGeometry): RouteGeometry {
  let pointIndex = 0;
  return geometryFromComponents(
    geometry,
    components(geometry).map((component) =>
      component.map((coordinate) => {
        const east = Math.sin(pointIndex * 0.37) * 2.5;
        const north = Math.cos(pointIndex * 0.29) * 2.5;
        pointIndex += 1;
        return offsetCoordinate(coordinate, east, north);
      }),
    ),
  );
}

function trimSmallBeginning(geometry: RouteGeometry): RouteGeometry {
  const updated = components(copyGeometry(geometry));
  const firstUsableIndex = updated.findIndex((component) => component.length > 2);
  if (firstUsableIndex >= 0) {
    const component = updated[firstUsableIndex];
    const trimCount = Math.max(1, Math.floor(component.length * 0.05));
    updated[firstUsableIndex] = component.slice(
      Math.min(trimCount, component.length - 2),
    );
  }
  return geometryFromComponents(geometry, updated);
}

function shortInteriorSubset(geometry: RouteGeometry): RouteGeometry {
  const longest = [...components(geometry)].sort(
    (left, right) => right.length - left.length,
  )[0];
  const start = Math.floor(longest.length * 0.4);
  const end = Math.max(start + 2, Math.floor(longest.length * 0.6));
  return { type: "LineString", coordinates: longest.slice(start, end) };
}

function sharedApproachWithDivergence(geometry: RouteGeometry): RouteGeometry {
  const updated = components(copyGeometry(geometry));
  let longestIndex = 0;
  updated.forEach((component, index) => {
    if (component.length > updated[longestIndex].length) {
      longestIndex = index;
    }
  });
  const longest = updated[longestIndex];
  const divergenceStart = Math.max(2, Math.floor(longest.length * 0.55));
  updated[longestIndex] = longest.map((coordinate, index) => {
    if (index < divergenceStart) {
      return coordinate;
    }

    const progress =
      (index - divergenceStart + 1) / (longest.length - divergenceStart + 1);
    return offsetCoordinate(coordinate, progress * 800, progress * 500);
  });
  return geometryFromComponents(geometry, updated);
}

function unrelatedGeometry(geometry: RouteGeometry): RouteGeometry {
  return geometryFromComponents(
    geometry,
    components(geometry).map((component) =>
      component.map(
        (coordinate) => [coordinate[0] + 0.2, coordinate[1] + 0.2] as Coordinate,
      ),
    ),
  );
}

export function createHollentalsteigSimilarityFixtures(
  base: ComparableRoute,
): RouteSimilarityFixture[] {
  return [
    {
      fixtureId: "A",
      description: "exact copy",
      route: routeVariant(base, "A", copyGeometry(base.geometry)),
      acceptableClassifications: ["EXACT_DUPLICATE"],
    },
    {
      fixtureId: "B",
      description: "fully reversed geometry",
      route: routeVariant(base, "B", reverseRouteGeometry(base.geometry)),
      acceptableClassifications: ["EXACT_DUPLICATE"],
    },
    {
      fixtureId: "C",
      description: "reduced point density",
      route: routeVariant(base, "C", reducePointDensity(base.geometry)),
      acceptableClassifications: ["EXACT_DUPLICATE", "NEAR_DUPLICATE"],
    },
    {
      fixtureId: "D",
      description: "small deterministic GPS noise",
      route: routeVariant(base, "D", addSmallNoise(base.geometry)),
      acceptableClassifications: ["EXACT_DUPLICATE", "NEAR_DUPLICATE"],
    },
    {
      fixtureId: "E",
      description: "small beginning section removed",
      route: routeVariant(base, "E", trimSmallBeginning(base.geometry)),
      acceptableClassifications: ["EXACT_DUPLICATE", "NEAR_DUPLICATE"],
    },
    {
      fixtureId: "F",
      description: "short interior subset",
      route: routeVariant(
        base,
        "F",
        shortInteriorSubset(base.geometry),
        false,
      ),
      acceptableClassifications: ["SAME_VARIANT", "UNRELATED"],
    },
    {
      fixtureId: "G",
      description: "shared approach with later divergence",
      route: routeVariant(
        base,
        "G",
        sharedApproachWithDivergence(base.geometry),
      ),
      acceptableClassifications: ["SAME_VARIANT"],
    },
    {
      fixtureId: "H",
      description: "geographically unrelated shifted route",
      route: routeVariant(base, "H", unrelatedGeometry(base.geometry), false),
      acceptableClassifications: ["UNRELATED"],
    },
  ];
}
