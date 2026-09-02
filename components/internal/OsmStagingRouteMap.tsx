"use client";

import type { PreviewCoordinate, PreviewRouteGeometry } from "@/Lib/osmStagingPreview/core";
import {
  analyzeRouteTopology,
  selectRouteEndpoints,
} from "@/Lib/osmStagingPreview/topology";
import MountainRouteMap from "@/components/mountain/MountainRouteMap";

export default function OsmStagingRouteMap({
  geometry,
  routeName,
  summit,
  mountain,
  startContext,
}: {
  geometry: PreviewRouteGeometry;
  routeName: string;
  summit: { coordinates: PreviewCoordinate; name: string };
  mountain: { coordinates: PreviewCoordinate; name: string };
  startContext?: {
    coordinates: PreviewCoordinate;
    label: string;
  } | null;
}) {
  const topology = analyzeRouteTopology(geometry);
  const endpointSelection = selectRouteEndpoints(topology, [summit.coordinates]);
  const topologyEndpoints = endpointSelection.available
    ? {
        startCoordinate: endpointSelection.startCoordinate as PreviewCoordinate,
        endCoordinate: endpointSelection.endCoordinate as PreviewCoordinate,
        startLabel: startContext?.label,
      }
    : null;

  if (
    startContext &&
    (!topologyEndpoints ||
      topologyEndpoints.startCoordinate[0] !== startContext.coordinates[0] ||
      topologyEndpoints.startCoordinate[1] !== startContext.coordinates[1])
  ) {
    throw new Error("Phase 11H start context does not match the selected route endpoint.");
  }

  return (
    <>
      <MountainRouteMap
        geojson={{
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry }],
        }}
        routeName={routeName}
        topologyEndpoints={topologyEndpoints}
        qaMarkers={{
          summit: { coordinates: summit.coordinates, label: `OSM summit: ${summit.name}` },
          mountain: {
            coordinates: mountain.coordinates,
            label: `Mountain Tracker: ${mountain.name}`,
          },
        }}
      />
      <aside
        aria-label="Route topology diagnostic"
        className="mt-2 border-l-4 border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-4 py-3 text-xs text-[var(--color-text-secondary)]"
      >
        <strong>Topology: {topology.classification}</strong>
        {` · ${topology.connectedGroupCount} connected group${topology.connectedGroupCount === 1 ? "" : "s"} · ${topology.physicalEndpointCount} physical endpoint${topology.physicalEndpointCount === 1 ? "" : "s"}`}
        <span className="block mt-1">
          {endpointSelection.available &&
          endpointSelection.warning === "BRANCHING_ENDPOINT_SELECTION_AMBIGUOUS"
            ? "Warning: Start and Finish are inferred physical endpoints; endpoint selection remains ambiguous because the route topology is branching. Geometry remains unchanged."
            : endpointSelection.available
              ? `S/F orientation: ${endpointSelection.orientationReason}. Geometry remains unchanged.`
              : "Global S/F markers hidden because route topology is disconnected or ambiguous. Component geometry remains unchanged."}
        </span>
      </aside>
    </>
  );
}
