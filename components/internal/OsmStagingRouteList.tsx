"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, MapPinned, ShieldCheck } from "lucide-react";

import {
  filterPreviewRoutes,
  summarizeQaProgress,
  type ApprovedStagingRouteListItem,
  type PreviewQaStatus,
} from "@/Lib/osmStagingPreview/core";
import { previewQueueHref, type PreviewQueueId } from "@/Lib/osmStagingPreview/queue-core";
import { Link } from "@/i18n/navigation";

type SortKey = "queue" | "name" | "quality" | "distance" | "elevation";

function countryFilterValue(route: ApprovedStagingRouteListItem): string {
  return route.countryCode ?? route.administrationStatus;
}

export default function OsmStagingRouteList({
  routes,
  queue,
}: {
  routes: ApprovedStagingRouteListItem[];
  queue: {
    id: PreviewQueueId;
    total: number;
    reviewed: number;
    remaining: number;
  } | null;
}) {
  const [country, setCountry] = useState("ALL");
  const [quality, setQuality] = useState("ALL");
  const [warning, setWarning] = useState("ALL");
  const [status, setStatus] = useState<PreviewQaStatus | "ALL">("ALL");
  const [qualification, setQualification] = useState<"ALL" | "GREEN" | "YELLOW">("ALL");
  const [sort, setSort] = useState<SortKey>(queue ? "queue" : "name");
  const progress = useMemo(() => summarizeQaProgress(routes), [routes]);
  const countries = useMemo(
    () => [...new Set(routes.map(countryFilterValue))].sort(),
    [routes],
  );
  const hasQualifications = routes.some((route) => route.qualificationStatus !== undefined);
  const visibleRoutes = useMemo(() => {
    const filtered = filterPreviewRoutes(routes, {
      country,
      quality,
      warning: warning as "ALL" | "WITH" | "WITHOUT" | "WARNINGS_PENDING",
      status,
      qualification,
    });
    return filtered.sort((left, right) => {
      if (sort === "queue") return 0;
      if (sort === "quality") return right.qualityScore - left.qualityScore;
      if (sort === "distance") return right.distanceMeters - left.distanceMeters;
      if (sort === "elevation") {
        return (right.summit.peakElevationMeters ?? -1) - (left.summit.peakElevationMeters ?? -1);
      }
      return (left.routeName ?? "").localeCompare(right.routeName ?? "", "en", {
        numeric: true,
      });
    });
  }, [country, qualification, quality, routes, sort, status, warning]);

  const selectClass =
    "min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-semibold text-[var(--color-text)]";

  return (
    <>
      <section aria-label="Route list filters" className="grid gap-3 border-y border-[var(--color-border)] py-4 sm:grid-cols-2 xl:grid-cols-6">
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Country
          <select className={selectClass} value={country} onChange={(event) => setCountry(event.target.value)}>
            <option value="ALL">All countries</option>
            {countries.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Quality
          <select className={selectClass} value={quality} onChange={(event) => setQuality(event.target.value)}>
            <option value="ALL">All scores</option>
            <option value="90">90–100</option>
            <option value="80">80–89</option>
            <option value="70">70–79</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Warnings
          <select className={selectClass} value={warning} onChange={(event) => setWarning(event.target.value)}>
            <option value="ALL">All routes</option>
            <option value="WITH">Warnings only</option>
            <option value="WARNINGS_PENDING">Warnings + pending</option>
            <option value="WITHOUT">No warnings</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          QA status
          <select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as PreviewQaStatus | "ALL")}>
            <option value="ALL">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="VISUALLY_APPROVED">Visually approved</option>
            <option value="NEEDS_REVIEW">Needs review</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </label>
        {hasQualifications && (
          <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            Qualification
            <select className={selectClass} value={qualification} onChange={(event) => setQualification(event.target.value as "ALL" | "GREEN" | "YELLOW")}>
              <option value="ALL">All qualifications</option>
              <option value="GREEN">GREEN</option>
              <option value="YELLOW">YELLOW</option>
            </select>
          </label>
        )}
        <label className="grid gap-1 text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          Sort
          <select className={selectClass} value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {queue && <option value="queue">Queue order</option>}
            <option value="name">Route name</option>
            <option value="quality">Quality</option>
            <option value="distance">Distance</option>
            <option value="elevation">Elevation</option>
          </select>
        </label>
      </section>

      <div className="mt-4 grid gap-2 text-sm text-[var(--color-text-muted)] sm:grid-cols-2 xl:grid-cols-4">
        <p>
          {queue
            ? `${visibleRoutes.length} visible of ${queue.total} queue routes`
            : `${visibleRoutes.length} of ${routes.length} reviewed routes shown`}
        </p>
        <p>Reviewed {progress.decided} / {progress.total} · {progress.pending} pending</p>
        <p>{progress.visuallyApproved} approved · {progress.needsReview} needs review · {progress.rejected} rejected</p>
        <p>{progress.warnings} warnings · {progress.warningsPending} warnings pending</p>
      </div>

      <div className="mt-3 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">
        {visibleRoutes.map((route) => (
          <article key={route.stagingRouteId} className="grid gap-4 py-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                  {route.qaStatus}
                </span>
                {route.qualificationStatus && (
                  <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                    {route.qualificationStatus}
                  </span>
                )}
                {route.auditCategories?.map((category) => (
                  <span key={category} className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-pine)]">
                    {category}
                  </span>
                ))}
                {route.warnings.length > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warning-soft)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-warning)]">
                    <AlertTriangle aria-hidden="true" size={12} /> {route.warnings.length} warning{route.warnings.length === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-success)]">
                    <ShieldCheck aria-hidden="true" size={14} /> Clean pre-write audit
                  </span>
                )}
              </div>
              <h2 className="mt-2 truncate text-xl font-bold text-[var(--color-text)]">
                {route.routeName ?? `OSM relation ${route.sourceRelationId}`}
              </h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Relation {route.sourceRelationId} · {route.semanticType} · {route.componentCount} component{route.componentCount === 1 ? "" : "s"}
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm">
              <div><dt className="text-xs text-[var(--color-text-muted)]">Mountain Tracker</dt><dd className="font-semibold">{route.summit.mountainName ?? `#${route.summit.mountainId}`}</dd></div>
              <div><dt className="text-xs text-[var(--color-text-muted)]">OSM summit</dt><dd className="font-semibold">{route.summit.peakName ?? route.summit.peakOsmId}</dd></div>
              <div><dt className="text-xs text-[var(--color-text-muted)]">Country / ADM1</dt><dd>{route.countryCode ?? route.administrationStatus} · {route.admin1Name ?? "—"}</dd></div>
              <div><dt className="text-xs text-[var(--color-text-muted)]">Distance / elevation</dt><dd>{(route.distanceMeters / 1000).toFixed(1)} km · {route.summit.peakElevationMeters ?? "—"} m</dd></div>
              <div><dt className="text-xs text-[var(--color-text-muted)]">Quality</dt><dd>{route.qualityScore}/100</dd></div>
              {route.qualificationScore !== undefined && <div><dt className="text-xs text-[var(--color-text-muted)]">GREEN score</dt><dd>{route.qualificationScore}/100 · {route.recoveredByPhase11e ? "recovered" : "stable"}</dd></div>}
              <div><dt className="text-xs text-[var(--color-text-muted)]">Association</dt><dd>{route.summit.finalAssociation}</dd></div>
            </dl>

            <Link
              href={previewQueueHref(`/internal/osm-staging/${route.stagingRouteId}`, queue?.id ?? null)}
              aria-label={`Inspect ${route.routeName ?? route.sourceRelationId}`}
              className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 font-bold text-white"
            >
              <MapPinned aria-hidden="true" size={18} /> Inspect <ChevronRight aria-hidden="true" size={18} />
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
