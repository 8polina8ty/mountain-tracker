"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map,
  type Marker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type ActivityTrackMapProps = {
  signedGeoJsonUrl: string;
  activityTitle: string;
};

type ActivityGeoJson = GeoJSON.FeatureCollection<
  GeoJSON.LineString | GeoJSON.MultiLineString
>;

const SOURCE_ID = "activity-track";
const BORDER_LAYER_ID = "activity-track-border";
const LINE_LAYER_ID = "activity-track-line";

export default function ActivityTrackMap({
  signedGeoJsonUrl,
  activityTitle,
}: ActivityTrackMapProps) {
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
   * Создаём карту только один раз.
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

      center: [10.5, 47.5],
      zoom: 7,
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
   * Загружаем приватный GeoJSON через подписанную ссылку.
   */
  useEffect(() => {
    const currentMap = mapRef.current;

    if (!currentMap || !signedGeoJsonUrl) {
      return;
    }

    const map: Map = currentMap;

    const abortController = new AbortController();
    let cancelled = false;

    setLoading(true);
    setErrorMessage("");

    function getCoordinates(
      geojson: ActivityGeoJson,
    ): [number, number][] {
      const result: [number, number][] = [];

      geojson.features.forEach((feature) => {
        if (feature.geometry.type === "LineString") {
          feature.geometry.coordinates.forEach(
            (coordinate) => {
              const longitude = coordinate[0];
              const latitude = coordinate[1];

              if (
                Number.isFinite(longitude) &&
                Number.isFinite(latitude)
              ) {
                result.push([
                  longitude,
                  latitude,
                ]);
              }
            },
          );
        }

        if (
          feature.geometry.type ===
          "MultiLineString"
        ) {
          feature.geometry.coordinates.forEach(
            (line) => {
              line.forEach((coordinate) => {
                const longitude = coordinate[0];
                const latitude = coordinate[1];

                if (
                  Number.isFinite(longitude) &&
                  Number.isFinite(latitude)
                ) {
                  result.push([
                    longitude,
                    latitude,
                  ]);
                }
              });
            },
          );
        }
      });

      return result;
    }

    function createMarkerElement(
      text: string,
      backgroundColor: string,
    ) {
      const element = document.createElement("div");

      element.style.width = "42px";
      element.style.height = "42px";
      element.style.display = "flex";
      element.style.alignItems = "center";
      element.style.justifyContent = "center";
      element.style.borderRadius = "9999px";
      element.style.border = "4px solid white";
      element.style.backgroundColor =
        backgroundColor;
      element.style.color = "white";
      element.style.fontSize = "13px";
      element.style.fontWeight = "700";
      element.style.boxShadow =
        "0 4px 12px rgba(0, 0, 0, 0.25)";

      element.textContent = text;

      return element;
    }

    function displayTrack(
      geojson: ActivityGeoJson,
      coordinates: [number, number][],
    ) {
      if (cancelled || mapRef.current !== map) {
        return;
      }

      const existingSource = map.getSource(
        SOURCE_ID,
      ) as GeoJSONSource | undefined;

      if (existingSource) {
        existingSource.setData(geojson);
      } else {
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: geojson,
        });

        map.addLayer({
          id: BORDER_LAYER_ID,
          type: "line",
          source: SOURCE_ID,

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
          id: LINE_LAYER_ID,
          type: "line",
          source: SOURCE_ID,

          layout: {
            "line-cap": "round",
            "line-join": "round",
          },

          paint: {
            "line-color": "#2563eb",
            "line-width": 5,
            "line-opacity": 1,
          },
        });
      }

      startMarkerRef.current?.remove();
      finishMarkerRef.current?.remove();

      const startCoordinate = coordinates[0];

      const finishCoordinate =
        coordinates[coordinates.length - 1];

      startMarkerRef.current = new maplibregl.Marker({
        element: createMarkerElement(
          "S",
          "#16a34a",
        ),
        anchor: "center",
      })
        .setLngLat(startCoordinate)
        .setPopup(
          new maplibregl.Popup({
            offset: 25,
          }).setText(
            `Старт: ${activityTitle}`,
          ),
        )
        .addTo(map);

      finishMarkerRef.current =
        new maplibregl.Marker({
          element: createMarkerElement(
            "F",
            "#dc2626",
          ),
          anchor: "center",
        })
          .setLngLat(finishCoordinate)
          .setPopup(
            new maplibregl.Popup({
              offset: 25,
            }).setText(
              `Финиш: ${activityTitle}`,
            ),
          )
          .addTo(map);

      const bounds =
        new maplibregl.LngLatBounds();

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

        maxZoom: 15,
        duration: 800,
      });
    }

    async function loadTrack() {
      try {
        const response = await fetch(
          signedGeoJsonUrl,
          {
            signal: abortController.signal,
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error(
            `Storage вернул ошибку ${response.status}.`,
          );
        }

        const geojson =
          (await response.json()) as ActivityGeoJson;

        if (
          geojson.type !== "FeatureCollection" ||
          !Array.isArray(geojson.features)
        ) {
          throw new Error(
            "Файл имеет неправильный формат GeoJSON.",
          );
        }

        const coordinates =
          getCoordinates(geojson);

        if (coordinates.length < 2) {
          throw new Error(
            "В треке недостаточно координат.",
          );
        }

        function showTrack() {
          displayTrack(
            geojson,
            coordinates,
          );

          if (!cancelled) {
            setLoading(false);
          }
        }

        if (map.isStyleLoaded()) {
          showTrack();
        } else {
          map.once("load", showTrack);
        }
      } catch (error) {
        if (
          cancelled ||
          abortController.signal.aborted
        ) {
          return;
        }

        console.error(
          "Ошибка отображения GPS-трека:",
          error,
        );

        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Не удалось загрузить трек.",
        );

        setLoading(false);
      }
    }

    void loadTrack();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [signedGeoJsonUrl, activityTitle]);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-gray-200 bg-gray-100">
      <div
        ref={containerRef}
        className="h-[560px] w-full"
      />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-3 font-medium text-gray-600 shadow-sm">
            Загружаю GPS-трек…
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-6">
          <div className="max-w-md rounded-2xl border border-red-200 bg-red-50 p-5 text-center">
            <p className="font-bold text-red-800">
              Не удалось показать GPS-трек
            </p>

            <p className="mt-2 text-sm text-red-700">
              {errorMessage}
            </p>
          </div>
        </div>
      )}

      {!loading && !errorMessage && (
        <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl bg-white/90 px-3 py-2 text-xs text-gray-700 shadow-sm backdrop-blur">
          <strong className="text-green-700">
            S
          </strong>{" "}
          — старт ·{" "}
          <strong className="text-red-700">
            F
          </strong>{" "}
          — финиш · синяя линия — записанный трек
        </div>
      )}
    </div>
  );
}