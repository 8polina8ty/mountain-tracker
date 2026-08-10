"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Mountain } from "lucide-react";

import type { Ascent } from "@/hooks/useAccount";

type ClimbedMountainsMapProps = {
  ascents: Ascent[];
  getMountainName: (
    mountain: Ascent["mountains"],
  ) => string;
};

export default function ClimbedMountainsMap({
  ascents,
  getMountainName,
}: ClimbedMountainsMapProps) {
  const containerRef =
    useRef<HTMLDivElement | null>(null);

  const mapRef = useRef<Map | null>(null);

  useEffect(() => {
  if (!containerRef.current || mapRef.current) {
    return;
  }

  const map = new maplibregl.Map({
    container: containerRef.current,
    style: {
      version: 8,
      sources: {
        opentopomap: {
          type: "raster",
          tiles: [
            "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
            "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
            "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          attribution:
            "Kartendaten: © OpenStreetMap-Mitwirkende, SRTM | Kartendarstellung: © OpenTopoMap (CC-BY-SA)",
        },
      },
      layers: [
        {
          id: "opentopomap",
          type: "raster",
          source: "opentopomap",
        },
      ],
    },
    center: [10.45, 51.16],
    zoom: 5.5,
  });

  map.addControl(
    new maplibregl.NavigationControl(),
    "top-right",
  );

  mapRef.current = map;

  return () => {
    map.remove();
    mapRef.current = null;
  };
}, []);

useEffect(() => {
 const currentMap = mapRef.current;

if (!currentMap) {
  return;
}

const map: Map = currentMap;

  const validAscents = ascents.filter((ascent) => {
    const latitude = Number(
      ascent.mountains?.latitude,
    );

    const longitude = Number(
      ascent.mountains?.longitude,
    );

    return (
      ascent.mountains &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude)
    );
  });

  const features = validAscents.map((ascent) => ({
    type: "Feature" as const,
    geometry: {
      type: "Point" as const,
      coordinates: [
        Number(ascent.mountains!.longitude),
        Number(ascent.mountains!.latitude),
      ] as [number, number],
    },
    properties: {
      ascentId: ascent.id,
      mountainId: ascent.mountains!.id,
      name: getMountainName(ascent.mountains),
      height: ascent.mountains!.height,
      climbedAt:
        ascent.climbed_at ??
        ascent.created_at ??
        "",
    },
  }));

  const geoJsonData = {
    type: "FeatureCollection" as const,
    features,
  };

  function updateClimbedMountains() {
    const existingSource = map.getSource(
      "climbed-mountains",
    ) as maplibregl.GeoJSONSource | undefined;

    if (existingSource) {
      existingSource.setData(geoJsonData);
    } else {
      map.addSource("climbed-mountains", {
        type: "geojson",
        data: geoJsonData,
      });

      map.addLayer({
        id: "climbed-mountains-points",
        type: "circle",
        source: "climbed-mountains",
        paint: {
          "circle-radius": 9,
          "circle-color": "#16a34a",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on(
        "mouseenter",
        "climbed-mountains-points",
        () => {
          map.getCanvas().style.cursor = "pointer";
        },
      );

      map.on(
        "mouseleave",
        "climbed-mountains-points",
        () => {
          map.getCanvas().style.cursor = "";
        },
      );

      map.on(
        "click",
        "climbed-mountains-points",
        (event) => {
          const feature = event.features?.[0];

          if (!feature) {
            return;
          }

          const coordinates = (
            feature.geometry as GeoJSON.Point
          ).coordinates.slice() as [number, number];

          const name = String(
            feature.properties?.name ?? "Вершина",
          );

          const height = Number(
            feature.properties?.height ?? 0,
          );

          const mountainId = Number(
            feature.properties?.mountainId,
          );

          const popupContent =
            document.createElement("div");

          popupContent.className = "space-y-2";

          const title = document.createElement("strong");
          title.textContent = name;

          const heightText =
            document.createElement("div");

          heightText.textContent = `⛰ ${height} м`;

          const link = document.createElement("a");

          link.href = `/mountain/${mountainId}`;
          link.textContent = "Открыть вершину →";
          link.className =
            "font-semibold text-green-700";

          popupContent.append(
            title,
            heightText,
            link,
          );

          new maplibregl.Popup({
            offset: 14,
          })
            .setLngLat(coordinates)
            .setDOMContent(popupContent)
            .addTo(map);
        },
      );
    }

    if (features.length === 1) {
      map.flyTo({
        center: features[0].geometry.coordinates,
        zoom: 11,
      });
    }

    if (features.length > 1) {
      const bounds =
        new maplibregl.LngLatBounds();

      features.forEach((feature) => {
        bounds.extend(
          feature.geometry.coordinates,
        );
      });

      map.fitBounds(bounds, {
        padding: 70,
        maxZoom: 11,
        duration: 800,
      });
    }
  }

  if (map.isStyleLoaded()) {
    updateClimbedMountains();
  } else {
    map.once("load", updateClimbedMountains);
  }

  return () => {
    map.off("load", updateClimbedMountains);
  };
}, [ascents, getMountainName]);

  if (ascents.length === 0) {
    return (
      <div className="flex min-h-[420px] h-[min(68dvh,720px)] items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <div>
          <Mountain aria-hidden="true" className="mx-auto h-9 w-9 text-[var(--color-forest)]" />

          <h2 className="mt-4 text-2xl font-bold text-[var(--color-text)]">
            Пока нет покорённых вершин
          </h2>

          <p className="mt-2 text-[var(--color-text-muted)]">
            Отмеченные восхождения появятся на этой карте.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Интерактивная карта покорённых вершин"
      className="h-[min(68dvh,720px)] min-h-[420px] w-full overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] shadow-[var(--shadow-card)]"
    />
  );
}
