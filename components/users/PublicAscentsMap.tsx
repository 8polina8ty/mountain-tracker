"use client";

import { useEffect, useRef } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { getPathname } from "@/i18n/navigation";

export type PublicAscentMapItem = {
  ascent_id: number;
  climbed_at: string | null;
  created_at: string;
  mountain_id: number;
  mountain_name: string | null;
  mountain_name_de: string | null;
  mountain_height: number;
  latitude: number;
  longitude: number;
};

type PublicAscentsMapProps = {
  ascents: PublicAscentMapItem[];
};

const SOURCE_ID = "public-user-ascents";
const LAYER_ID = "public-user-ascents-points";

export default function PublicAscentsMap({
  ascents,
}: PublicAscentsMapProps) {
  const locale = useLocale();
  const t = useTranslations("PublicProfile.Map");
  const tUnits = useTranslations("PublicProfile.Units");
  const format = useFormatter();
  const containerRef =
    useRef<HTMLDivElement | null>(null);

  const mapRef = useRef<Map | null>(null);

  /*
   * Первый эффект создаёт карту только один раз.
   */
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
      zoom: 5,
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

  /*
   * Второй эффект обновляет только точки.
   */
  useEffect(() => {
    const currentMap = mapRef.current;

    if (!currentMap) {
      return;
    }

    const map: Map = currentMap;

    const validAscents = ascents.filter((ascent) => {
      return (
        Number.isFinite(ascent.latitude) &&
        Number.isFinite(ascent.longitude)
      );
    });

    const features = validAscents.map((ascent) => {
      const mountainName =
        ascent.mountain_name_de ??
        ascent.mountain_name ??
        t("unnamedMountain");

      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [
            ascent.longitude,
            ascent.latitude,
          ] as [number, number],
        },
        properties: {
          ascentId: ascent.ascent_id,
          mountainId: ascent.mountain_id,
          name: mountainName,
          height: ascent.mountain_height,
          climbedAt:
            ascent.climbed_at ??
            ascent.created_at,
        },
      };
    });

    const geoJsonData = {
      type: "FeatureCollection" as const,
      features,
    };

    function handleMouseEnter() {
      map.getCanvas().style.cursor = "pointer";
    }

    function handleMouseLeave() {
      map.getCanvas().style.cursor = "";
    }

    function handlePointClick(
      event: maplibregl.MapLayerMouseEvent,
    ) {
      const feature = event.features?.[0];

      if (!feature) {
        return;
      }

      const coordinates = (
        feature.geometry as GeoJSON.Point
      ).coordinates.slice() as [number, number];

      const name = String(
        feature.properties?.name ?? t("mountainFallback"),
      );

      const height = Number(
        feature.properties?.height ?? 0,
      );

      const mountainId = Number(
        feature.properties?.mountainId,
      );

      const climbedAt = String(
        feature.properties?.climbedAt ?? "",
      );

      const popupContent =
        document.createElement("div");

      popupContent.className = "space-y-2";

      const title =
        document.createElement("strong");

      title.textContent = name;

      const heightText =
        document.createElement("div");

      heightText.textContent =
        `⛰ ${format.number(height)} ${tUnits("meter")}`;

      const dateText =
        document.createElement("div");

      dateText.textContent = climbedAt
        ? `📅 ${format.dateTime(new Date(climbedAt), {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })}`
        : `📅 ${t("dateUnknown")}`;

      const link =
        document.createElement("a");

      link.href = getPathname({
        href: `/mountain/${mountainId}`,
        locale,
      });
      link.textContent = t("openMountain");
      link.className =
        "font-semibold text-green-700";

      popupContent.append(
        title,
        heightText,
        dateText,
        link,
      );

      new maplibregl.Popup({
        offset: 14,
      })
        .setLngLat(coordinates)
        .setDOMContent(popupContent)
        .addTo(map);
    }

    function updateMapPoints() {
      const existingSource = map.getSource(
        SOURCE_ID,
      ) as GeoJSONSource | undefined;

      if (existingSource) {
        existingSource.setData(geoJsonData);
      } else {
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: geoJsonData,
        });

        map.addLayer({
          id: LAYER_ID,
          type: "circle",
          source: SOURCE_ID,
          paint: {
            "circle-radius": 9,
            "circle-color": [
              "step",
              ["get", "height"],
              "#22c55e",
              1000,
              "#84cc16",
              1300,
              "#facc15",
              1600,
              "#f97316",
              2000,
              "#ef4444",
              4000,
              "#9333ea",
              6000,
              "#2563eb",
            ],
            "circle-stroke-width": 3,
            "circle-stroke-color": "#ffffff",
          },
        });

        map.on(
          "mouseenter",
          LAYER_ID,
          handleMouseEnter,
        );

        map.on(
          "mouseleave",
          LAYER_ID,
          handleMouseLeave,
        );

        map.on(
          "click",
          LAYER_ID,
          handlePointClick,
        );
      }

      if (features.length === 1) {
        map.flyTo({
          center:
            features[0].geometry.coordinates,
          zoom: 11,
        });

        return;
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
          duration: 700,
        });
      }
    }

    if (map.isStyleLoaded()) {
      updateMapPoints();
    } else {
      map.once("load", updateMapPoints);
    }

 return () => {
  if (mapRef.current !== map) {
    return;
  }

  map.off("load", updateMapPoints);

  if (!map.loaded()) {
    return;
  }

  if (map.getLayer(LAYER_ID)) {
    map.off(
      "mouseenter",
      LAYER_ID,
      handleMouseEnter,
    );

    map.off(
      "mouseleave",
      LAYER_ID,
      handleMouseLeave,
    );

    map.off(
      "click",
      LAYER_ID,
      handlePointClick,
    );
  }
};
  }, [ascents, format, locale, t, tUnits]);

  if (ascents.length === 0) {
    return (
      <div className="flex h-[480px] items-center justify-center rounded-3xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div>
          <div className="text-5xl">🏔️</div>

          <h2 className="mt-4 text-2xl font-bold text-gray-900">
            {t("emptyTitle")}
          </h2>

          <p className="mt-2 text-gray-500">
            {t("emptyDescription")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      aria-label={t("label")}
      className="h-[480px] w-full overflow-hidden rounded-3xl border border-gray-200 shadow-sm"
    />
  );
}
