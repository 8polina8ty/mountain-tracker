"use client";

import MountainRouteMap from "./MountainRouteMap";

export default function CommunityRouteMap({ geojsonUrl, routeName }: { geojsonUrl: string; routeName: string }) {
  return <MountainRouteMap geojsonUrl={geojsonUrl} routeName={routeName} />;
}
