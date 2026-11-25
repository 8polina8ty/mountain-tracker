"use client";

/* eslint-disable react-hooks/set-state-in-effect -- lazy GeoJSON fetch intentionally syncs loading/error with selection */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LngLatBounds, NavigationControl, type GeoJSONSource, type Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { RouteIndexEntry } from "@/app/[locale]/routes/page";
import { Download, ExternalLink, Mountain, Search, X } from "lucide-react";
import { createMapLibreMap } from "@/Lib/maplibre";

type Props = {
  locale: string;
  routes: RouteIndexEntry[];
};

const CLUSTER_SOURCE_ID = "routes-index";
const CLUSTER_LAYER_ID = "routes-clusters";
const CLUSTER_COUNT_ID = "routes-cluster-count";
const POINTS_LAYER_ID = "routes-points";
const SELECTED_SOURCE_ID = "routes-selected";
const SELECTED_LAYER_ID = "routes-selected-line";
const SELECTED_BORDER_ID = "routes-selected-border";

function getMountainName(m: RouteIndexEntry["mountain"], fallback: string): string {
  return m.name_de ?? m.name ?? fallback;
}

export default function RouteExplorerClient({ locale, routes }: Props) {
  const t = useTranslations("Routes");
  const [search, setSearch] = useState("");
  const [heightMin, setHeightMin] = useState("");
  const [heightMax, setHeightMax] = useState("");
  const [distMin, setDistMin] = useState("");
  const [distMax, setDistMax] = useState("");
  const [elevMin, setElevMin] = useState("");
  const [elevMax, setElevMax] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [geojsonLoading, setGeojsonLoading] = useState(false);
  const [geojsonError, setGeojsonError] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const selectedAbortRef = useRef<AbortController | null>(null);

  const selectedRoute = useMemo(
    () => routes.find((r) => r.id === selectedId) ?? null,
    [routes, selectedId],
  );

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const hm = heightMin ? Number(heightMin) : null;
    const hx = heightMax ? Number(heightMax) : null;
    const dm = distMin ? Number(distMin) : null;
    const dx = distMax ? Number(distMax) : null;
    const em = elevMin ? Number(elevMin) : null;
    const ex = elevMax ? Number(elevMax) : null;
    return routes.filter((r) => {
      if (s) {
        const name = getMountainName(r.mountain, "").toLowerCase();
        const routeName = r.name.toLowerCase();
        if (!name.includes(s) && !routeName.includes(s)) return false;
      }
      if (typeFilter !== "all" && r.route_type !== typeFilter) return false;
      if (hm !== null && Number.isFinite(hm) && r.mountain.height < hm) return false;
      if (hx !== null && Number.isFinite(hx) && r.mountain.height > hx) return false;
      if (dm !== null && Number.isFinite(dm) && (r.distance_km ?? 0) < dm) return false;
      if (dx !== null && Number.isFinite(dx) && (r.distance_km ?? Infinity) > dx) return false;
      if (em !== null && Number.isFinite(em) && (r.elevation_gain_m ?? 0) < em) return false;
      if (ex !== null && Number.isFinite(ex) && (r.elevation_gain_m ?? Infinity) > ex) return false;
      return true;
    });
  }, [routes, search, typeFilter, heightMin, heightMax, distMin, distMax, elevMin, elevMax]);

  const clearFilters = useCallback(() => {
    setSearch("");
    setHeightMin("");
    setHeightMax("");
    setDistMin("");
    setDistMax("");
    setElevMin("");
    setElevMax("");
    setTypeFilter("all");
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = createMapLibreMap({
      container: mapContainerRef.current,
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
            attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)",
          },
        },
        layers: [{ id: "opentopomap", type: "raster", source: "opentopomap" }],
      },
      center: [11.5, 47.2],
      zoom: 6,
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;
    return () => {
      selectedAbortRef.current?.abort();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update index source when filtered changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const geojson: GeoJSON.FeatureCollection<GeoJSON.Point, { routeId: number; mountainId: number; name: string }> = {
      type: "FeatureCollection",
      features: filtered.map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.mountain.longitude!, r.mountain.latitude!] },
        properties: { routeId: r.id, mountainId: r.mountain_id, name: getMountainName(r.mountain, r.name) },
      })),
    };
    const ensure = () => {
      const existing = map.getSource(CLUSTER_SOURCE_ID) as GeoJSONSource | undefined;
      if (existing) {
        (existing as GeoJSONSource).setData(geojson as never);
      } else {
        map.addSource(CLUSTER_SOURCE_ID, {
          type: "geojson",
          data: geojson as never,
          cluster: true,
          clusterMaxZoom: 12,
          clusterRadius: 48,
        });
        map.addLayer({
          id: CLUSTER_LAYER_ID,
          type: "circle",
          source: CLUSTER_SOURCE_ID,
          filter: ["has", "point_count"],
          paint: {
            "circle-color": "#2D6B4F",
            "circle-radius": ["step", ["get", "point_count"], 18, 40, 26, 100, 34],
            "circle-opacity": 0.92,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
        map.addLayer({
          id: CLUSTER_COUNT_ID,
          type: "symbol",
          source: CLUSTER_SOURCE_ID,
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-font": ["Open Sans Regular"],
            "text-size": 12,
          },
          paint: { "text-color": "#ffffff" },
        });
        map.addLayer({
          id: POINTS_LAYER_ID,
          type: "circle",
          source: CLUSTER_SOURCE_ID,
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": ["case", ["==", ["get", "routeId"], selectedId ?? -1], "#C4893A", "#3A8A5F"],
            "circle-radius": 7,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });

        map.on("click", CLUSTER_LAYER_ID, async (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: [CLUSTER_LAYER_ID] });
          const clusterId = (features[0]?.properties as { cluster_id: number } | undefined)?.cluster_id;
          if (clusterId === undefined) return;
          const source = map.getSource(CLUSTER_SOURCE_ID) as GeoJSONSource & {
            getClusterExpansionZoom: (id: number, cb: (err: unknown, zoom: number) => void) => void;
          };
          source.getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            const center = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
            map.easeTo({ center, zoom, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400 });
          });
        });
        map.on("click", POINTS_LAYER_ID, (e) => {
          const f = e.features?.[0];
          const rid = (f?.properties as { routeId?: number } | undefined)?.routeId;
          if (rid) setSelectedId(rid);
        });
        map.on("mouseenter", CLUSTER_LAYER_ID, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", CLUSTER_LAYER_ID, () => (map.getCanvas().style.cursor = ""));
        map.on("mouseenter", POINTS_LAYER_ID, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", POINTS_LAYER_ID, () => (map.getCanvas().style.cursor = ""));
      }
      // fit to filtered if not too many
      if (filtered.length > 0 && filtered.length < 80) {
        const b = new LngLatBounds();
        filtered.forEach((r) => b.extend([r.mountain.longitude!, r.mountain.latitude!]));
        map.fitBounds(b, {
          padding: 40,
          maxZoom: 11,
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600,
        });
      }
    };
    if (map.isStyleLoaded()) ensure();
    else map.once("load", ensure);
  }, [filtered, selectedId]);

  // Selected route visual highlight: update point paint via setPaintProperty
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(POINTS_LAYER_ID)) return;
    map.setPaintProperty(POINTS_LAYER_ID, "circle-color", [
      "case",
      ["==", ["get", "routeId"], selectedId ?? -1],
      "#C4893A",
      "#3A8A5F",
    ]);
  }, [selectedId]);

  // Lazy GeoJSON load for selected route
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selectedRoute == null) {
      // cleanup selected source
      if (map?.getLayer(SELECTED_LAYER_ID)) map.removeLayer(SELECTED_LAYER_ID);
      if (map?.getLayer(SELECTED_BORDER_ID)) map.removeLayer(SELECTED_BORDER_ID);
      if (map?.getSource(SELECTED_SOURCE_ID)) map.removeSource(SELECTED_SOURCE_ID);
      setGeojsonError(null);
      setGeojsonLoading(false);
      selectedAbortRef.current?.abort();
      return;
    }
    if (!selectedRoute.geojson_url) {
      setGeojsonError(t("details.geojsonUnavailable"));
      setGeojsonLoading(false);
      return;
    }
    const url = selectedRoute.geojson_url;
    const abort = new AbortController();
    selectedAbortRef.current?.abort();
    selectedAbortRef.current = abort;
    let cancelled = false;
    setGeojsonLoading(true);
    setGeojsonError(null);

    (async () => {
      try {
        const res = await fetch(url, { signal: abort.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status}`);
        const json = (await res.json()) as GeoJSON.FeatureCollection;
        if (cancelled || abort.signal.aborted) return;
        if (json.type !== "FeatureCollection" || !Array.isArray((json as { features?: unknown[] }).features)) {
          throw new Error(t("map.loadFailed"));
        }
        const coords: [number, number][] = [];
        for (const f of (json as GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString>).features) {
          if (f.geometry.type === "LineString") f.geometry.coordinates.forEach((c) => coords.push(c as [number, number]));
          else if (f.geometry.type === "MultiLineString") f.geometry.coordinates.forEach((line) => line.forEach((c) => coords.push(c as [number, number])));
        }
        if (coords.length < 2) throw new Error(t("map.noGeometry"));
        if (!map.getSource(SELECTED_SOURCE_ID)) {
          map.addSource(SELECTED_SOURCE_ID, { type: "geojson", data: json as never });
          map.addLayer({
            id: SELECTED_BORDER_ID,
            type: "line",
            source: SELECTED_SOURCE_ID,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
          });
          map.addLayer({
            id: SELECTED_LAYER_ID,
            type: "line",
            source: SELECTED_SOURCE_ID,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#16a34a", "line-width": 5 },
          });
        } else {
          (map.getSource(SELECTED_SOURCE_ID) as GeoJSONSource).setData(json as never);
        }
        const bounds = new LngLatBounds();
        coords.forEach((c) => bounds.extend(c));
        map.fitBounds(bounds, {
          padding: { top: 60, right: 60, bottom: 60, left: 60 },
          maxZoom: 14,
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700,
        });
        setGeojsonLoading(false);
      } catch (e) {
        if (abort.signal.aborted || cancelled) return;
        setGeojsonError(e instanceof Error ? e.message : t("map.loadFailed"));
        // remove stale geometry
        if (map.getLayer(SELECTED_LAYER_ID)) map.removeLayer(SELECTED_LAYER_ID);
        if (map.getLayer(SELECTED_BORDER_ID)) map.removeLayer(SELECTED_BORDER_ID);
        if (map.getSource(SELECTED_SOURCE_ID)) map.removeSource(SELECTED_SOURCE_ID);
        setGeojsonLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [selectedRoute, t]);

  // Keyboard: Escape dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedId !== null) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const visibleCount = filtered.length;
  const totalCount = routes.length;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)] xl:grid-cols-[420px_minmax(0,1fr)]">
      {/* List panel */}
      <div className="order-2 flex max-h-[70vh] flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] lg:order-1 lg:max-h-[78vh]">
        <div className="border-b border-[var(--color-border-soft)] p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              {t("filters.results", { count: visibleCount })}
            </p>
            <span className="text-xs text-[var(--color-text-muted)]">{t("list.showing", { visible: visibleCount, total: totalCount })}</span>
          </div>

          <label className="mt-3 flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 focus-within:border-[var(--color-focus)]">
            <Search aria-hidden size={16} className="text-[var(--color-text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
              aria-label={t("searchPlaceholder")}
            />
            {search && (
              <button onClick={() => setSearch("")} aria-label="clear search" className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <X size={14} />
              </button>
            )}
          </label>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{t("filters.routeType")}</span>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="h-11 w-full border border-[var(--color-border)] bg-white px-2 text-sm"
              >
                <option value="all">{t("filters.allTypes")}</option>
                <option value="hiking">{t("routeTypes.hiking")}</option>
                <option value="mountaineering">{t("routeTypes.mountaineering")}</option>
                <option value="via_ferrata">{t("routeTypes.viaFerrata")}</option>
                <option value="climbing">{t("routeTypes.climbing")}</option>
                <option value="ski_touring">{t("routeTypes.skiTouring")}</option>
              </select>
            </label>
            <button
              onClick={clearFilters}
              className="self-end h-11 border border-[var(--color-border)] px-3 text-xs font-bold uppercase tracking-wide text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
              style={{ minHeight: 44 }}
            >
              {t("filters.clear")}
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{t("filters.height")} min</span>
              <input value={heightMin} onChange={(e) => setHeightMin(e.target.value)} inputMode="numeric" placeholder={t("filters.min")} className="h-11 w-full border border-[var(--color-border)] px-2 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{t("filters.height")} max</span>
              <input value={heightMax} onChange={(e) => setHeightMax(e.target.value)} inputMode="numeric" placeholder={t("filters.max")} className="h-11 w-full border border-[var(--color-border)] px-2 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{t("filters.distance")} min</span>
              <input value={distMin} onChange={(e) => setDistMin(e.target.value)} inputMode="numeric" placeholder={t("filters.min")} className="h-11 w-full border border-[var(--color-border)] px-2 text-sm" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{t("filters.distance")} max</span>
              <input value={distMax} onChange={(e) => setDistMax(e.target.value)} inputMode="numeric" placeholder={t("filters.max")} className="h-11 w-full border border-[var(--color-border)] px-2 text-sm" />
            </label>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="p-8 text-center">
              <Mountain aria-hidden className="mx-auto text-[var(--color-text-subtle)]" size={36} />
              <p className="mt-3 font-bold">{t("list.empty")}</p>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("empty.description")}</p>
            </div>
          ) : (
            <ul role="list" className="divide-y divide-[var(--color-border-soft)]">
              {filtered.map((r) => {
                const mName = getMountainName(r.mountain, r.name);
                const isSel = r.id === selectedId;
                return (
                  <li
                    key={r.id}
                    tabIndex={0}
                    role="button"
                    aria-pressed={isSel}
                    aria-label={mName}
                    onClick={() => setSelectedId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(r.id);
                      }
                    }}
                    className={`group flex cursor-pointer flex-col gap-2 p-4 text-left outline-none hover:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-inset ${isSel ? "bg-[var(--color-surface-muted)] ring-1 ring-inset ring-[var(--color-forest)]" : ""}`}
                    style={{ minHeight: 44 }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold leading-tight">{mName}</p>
                        <p className="truncate text-xs text-[var(--color-text-muted)]">{r.name}</p>
                      </div>
                      <span className="shrink-0 rounded-full border border-[var(--color-border)] bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-wide">{r.route_type}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-[var(--color-text-secondary)]">
                      <span>{r.mountain.height} {t("units.meter")}</span>
                      <span>·</span>
                      <span>{r.distance_km != null ? `${r.distance_km} ${t("units.kilometer")}` : "–"}</span>
                      {r.elevation_gain_m != null && (
                        <>
                          <span>·</span>
                          <span>+{r.elevation_gain_m} {t("units.meter")}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(r.id);
                        }}
                        className="min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-3 text-xs font-bold text-white hover:bg-[var(--color-forest-hover)]"
                      >
                        {t("list.viewRoute")}
                      </button>
                      <Link
                        href={`/mountain/${r.mountain_id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3 text-xs font-bold hover:bg-[var(--color-surface-muted)]"
                      >
                        {t("list.openMountain")} <ExternalLink size={12} aria-hidden />
                      </Link>
                      {r.gpx_url ? (
                        <a
                          href={`/${locale}/mountain/${r.mountain_id}/route/${r.id}/gpx`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3 text-xs font-bold hover:bg-[var(--color-surface-muted)]"
                          aria-label={`${t("list.downloadGpx")} ${mName}`}
                        >
                          <Download size={12} aria-hidden /> {t("list.downloadGpx")}
                        </a>
                      ) : (
                        <span className="inline-flex min-h-11 items-center px-3 text-xs text-[var(--color-text-muted)]">{t("details.downloadUnavailable")}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Map */}
      <div className="order-1 lg:order-2">
        <div className="overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-terrain)]">
          <div ref={mapContainerRef} role="region" aria-label={t("map.accessibleLabel", { count: String(filtered.length) })} aria-busy={geojsonLoading} className="h-[52vh] w-full lg:h-[78vh]" />
        </div>

        {/* Selected details */}
        <div className="mt-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {!selectedRoute ? (
            <p className="text-sm text-[var(--color-text-muted)]">{t("map.instruction")}</p>
          ) : geojsonLoading ? (
            <p role="status" className="text-sm font-semibold">{t("map.loading")}</p>
          ) : geojsonError ? (
            <div role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm">
              <p className="font-bold text-[var(--color-danger)]">{t("map.loadFailed")}</p>
              <p className="text-[var(--color-text-secondary)]">{geojsonError}</p>
              <button onClick={() => setSelectedId(null)} className="mt-2 text-xs font-bold underline">{t("details.close")}</button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-forest)]">{t("map.selected", { name: getMountainName(selectedRoute.mountain, selectedRoute.name) })}</p>
                  <h3 className="text-lg font-bold leading-tight">{selectedRoute.name}</h3>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    {selectedRoute.mountain.height} {t("units.meter")} · {selectedRoute.distance_km ?? "–"} {t("units.kilometer")}
                  </p>
                </div>
                <button onClick={() => setSelectedId(null)} aria-label={t("details.close")} className="inline-flex h-11 w-9 items-center justify-center border border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]">
                  <X size={16} />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/mountain/${selectedRoute.mountain_id}`} className="min-h-11 inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-white px-3 text-xs font-bold">
                  {t("list.openMountain")} <ExternalLink size={12} aria-hidden />
                </Link>
                {selectedRoute.gpx_url ? (
                  <a href={`/${locale}/mountain/${selectedRoute.mountain_id}/route/${selectedRoute.id}/gpx`} className="min-h-11 inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-3 text-xs font-bold text-white">
                    <Download size={12} aria-hidden /> {t("list.downloadGpx")}
                  </a>
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)]">{t("details.downloadUnavailable")}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
