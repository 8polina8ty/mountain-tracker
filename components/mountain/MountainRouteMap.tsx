"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map,
  type Marker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type MountainRouteMapProps = {
  geojsonUrl: string;
  routeName: string;
};

type RouteGeoJson = GeoJSON.FeatureCollection<
  GeoJSON.LineString | GeoJSON.MultiLineString
>;

const ROUTE_SOURCE_ID = "mountain-route";
const ROUTE_BORDER_LAYER_ID = "mountain-route-border";
const ROUTE_LAYER_ID = "mountain-route-line";

export default function MountainRouteMap({
  geojsonUrl,
  routeName,
}: MountainRouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(
    null,
  );

  const mapRef = useRef<Map | null>(null);
  const startMarkerRef = useRef<Marker | null>(null);
  const finishMarkerRef = useRef<Marker | null>(null);

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] =
    useState("");

  /*
   * Первый эффект создаёт карту один раз.
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
      center: [11.05, 47.45],
      zoom: 10,
    });

    map.addControl(
      new maplibregl.NavigationControl(),
      "top-right",
    );

    mapRef.current = map;

    return () => {
      startMarkerRef.current?.remove();
      finishMarkerRef.current?.remove();

      startMarkerRef.current = null;
      finishMarkerRef.current = null;

      map.remove();
      mapRef.current = null;
    };
  }, []);

  /*
   * Второй эффект загружает и отображает GeoJSON.
   */
  useEffect(() => {
    const currentMap = mapRef.current;

if (!currentMap || !geojsonUrl) {
  return;
}

const map: Map = currentMap;

    const abortController = new AbortController();
    let effectCancelled = false;

    setLoading(true);
    setErrorMessage("");

    function getRouteCoordinates(
      geojson: RouteGeoJson,
    ): [number, number][] {
      const coordinates: [number, number][] = [];

      geojson.features.forEach((feature) => {
        if (feature.geometry.type === "LineString") {
          feature.geometry.coordinates.forEach(
            (coordinate) => {
              if (
                coordinate.length >= 2 &&
                Number.isFinite(coordinate[0]) &&
                Number.isFinite(coordinate[1])
              ) {
                coordinates.push([
                  coordinate[0],
                  coordinate[1],
                ]);
              }
            },
          );
        }

        if (
          feature.geometry.type === "MultiLineString"
        ) {
          feature.geometry.coordinates.forEach(
            (line) => {
              line.forEach((coordinate) => {
                if (
                  coordinate.length >= 2 &&
                  Number.isFinite(coordinate[0]) &&
                  Number.isFinite(coordinate[1])
                ) {
                  coordinates.push([
                    coordinate[0],
                    coordinate[1],
                  ]);
                }
              });
            },
          );
        }
      });

      return coordinates;
    }

    function createMarkerElement(
      label: string,
      backgroundClassName: string,
    ) {
      const element = document.createElement("div");

      element.className = [
        "flex",
        "h-10",
        "w-10",
        "items-center",
        "justify-center",
        "rounded-full",
        "border-4",
        "border-white",
        "text-sm",
        "font-bold",
        "text-white",
        "shadow-lg",
        backgroundClassName,
      ].join(" ");

      element.textContent = label;

      return element;
    }

    function updateRoute(
      geojson: RouteGeoJson,
      coordinates: [number, number][],
    ) {
      if (effectCancelled || mapRef.current !== map) {
        return;
      }

      const existingSource = map.getSource(
        ROUTE_SOURCE_ID,
      ) as GeoJSONSource | undefined;

      if (existingSource) {
        existingSource.setData(geojson);
      } else {
        map.addSource(ROUTE_SOURCE_ID, {
          type: "geojson",
          data: geojson,
        });

        map.addLayer({
          id: ROUTE_BORDER_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
          paint: {
            "line-color": "#ffffff",
            "line-width": 9,
            "line-opacity": 0.9,
          },
        });

        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: "line",
          source: ROUTE_SOURCE_ID,
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
          paint: {
            "line-color": "#16a34a",
            "line-width": 5,
            "line-opacity": 1,
          },
        });
      }

      startMarkerRef.current?.remove();
      finishMarkerRef.current?.remove();

      const firstCoordinate = coordinates[0];
      const lastCoordinate =
        coordinates[coordinates.length - 1];

      startMarkerRef.current = new maplibregl.Marker({
        element: createMarkerElement(
          "S",
          "bg-green-600",
        ),
        anchor: "center",
      })
        .setLngLat(firstCoordinate)
        .setPopup(
          new maplibregl.Popup({
            offset: 24,
          }).setText(`Старт: ${routeName}`),
        )
        .addTo(map);

      finishMarkerRef.current = new maplibregl.Marker({
        element: createMarkerElement(
          "F",
          "bg-red-600",
        ),
        anchor: "center",
      })
        .setLngLat(lastCoordinate)
        .setPopup(
          new maplibregl.Popup({
            offset: 24,
          }).setText(`Финиш: ${routeName}`),
        )
        .addTo(map);

      const bounds = new maplibregl.LngLatBounds();

      coordinates.forEach((coordinate) => {
        bounds.extend(coordinate);
      });

      map.fitBounds(bounds, {
        padding: {
          top: 60,
          right: 60,
          bottom: 60,
          left: 60,
        },
        maxZoom: 14,
        duration: 800,
      });
    }

    async function loadRoute() {
      try {
        const response = await fetch(geojsonUrl, {
          signal: abortController.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(
            `Не удалось загрузить маршрут: ${response.status}`,
          );
        }

        const geojson =
          (await response.json()) as RouteGeoJson;

        if (
          geojson.type !== "FeatureCollection" ||
          !Array.isArray(geojson.features)
        ) {
          throw new Error(
            "Файл не является корректным GeoJSON FeatureCollection.",
          );
        }

        const coordinates =
          getRouteCoordinates(geojson);

        if (coordinates.length < 2) {
          throw new Error(
            "В GeoJSON не найден корректный маршрут.",
          );
        }

        function showRoute() {
          updateRoute(geojson, coordinates);

          if (!effectCancelled) {
            setLoading(false);
          }
        }

        if (map.isStyleLoaded()) {
          showRoute();
        } else {
          map.once("load", showRoute);
        }
      } catch (error) {
        if (
          abortController.signal.aborted ||
          effectCancelled
        ) {
          return;
        }

        console.error(
          "Ошибка загрузки GeoJSON маршрута:",
          error,
        );

        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Не удалось загрузить маршрут.",
        );

        setLoading(false);
      }
    }

    void loadRoute();

    return () => {
      effectCancelled = true;
      abortController.abort();
    };
  }, [geojsonUrl, routeName]);

  return (
    <div className="relative mt-8 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-terrain)] shadow-[var(--shadow-control)]">
      <div
        ref={containerRef}
        role="region"
        aria-label={`Карта маршрута «${routeName}»`}
        className="h-[clamp(360px,58vh,520px)] w-full"
      />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface)]/90 p-4">
          <div className="border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-5 py-3 text-sm font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-control)]">
            Загружаю маршрут…
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface)]/95 p-6">
          <div className="max-w-md border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-5 text-center">
            <p className="font-bold text-[var(--color-danger)]">
              Не удалось показать маршрут
            </p>

            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {errorMessage}
            </p>
          </div>
        </div>
      )}

      {!loading && !errorMessage && (
        <div className="pointer-events-none absolute bottom-3 left-3 border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 py-2 [font-family:var(--font-technical)] text-[var(--font-size-caption)] font-semibold text-[var(--color-text-secondary)] shadow-[var(--shadow-control)] sm:bottom-4 sm:left-4">
          <span className="font-bold text-[var(--color-route)]">
            S
          </span>{" "}
          — старт ·{" "}
          <span className="font-bold text-[var(--color-danger)]">
            F
          </span>{" "}
          — финиш
        </div>
      )}
    </div>
  );
}
