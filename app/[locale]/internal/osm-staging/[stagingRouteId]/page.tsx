import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, ExternalLink, Mountain, TriangleAlert, BadgeCheck, AlertCircle, Circle } from "lucide-react";
import { notFound } from "next/navigation";

import { requireOsmStagingPreviewAccess } from "@/Lib/osmStagingPreview/access";
import {
  createPreviewNavigation,
  createPreviewQueueState,
  osmRelationUrl,
} from "@/Lib/osmStagingPreview/core";
import {
  parsePreviewQueueId,
  previewQueueHref,
  type PreviewQueueId,
} from "@/Lib/osmStagingPreview/queue-core";
import { createPhase11hMapViewModel } from "@/Lib/osmStagingPreview/phase11h-visual-qa";
import { loadApprovedStagingRouteDetail } from "@/Lib/osmStagingPreview/server";
import { getAutoQaRecommendation } from "@/app/[locale]/internal/osm-staging/actions";
import OsmStagingQaDecisionForm from "@/components/internal/OsmStagingQaDecisionForm";
import OsmStagingRouteMap from "@/components/internal/OsmStagingRouteMap";
import { isLocale, type Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";

export const metadata: Metadata = {
  title: "OSM staging route inspection",
  robots: { index: false, follow: false, nocache: true },
};

function coordinate(value: [number, number] | null): string {
  return value ? `${value[1].toFixed(7)}, ${value[0].toFixed(7)}` : "—";
}

function navigationLink(
  id: string | null,
  label: string,
  icon: "left" | "right",
  queueId: PreviewQueueId | null,
) {
  if (!id) return <span className="text-sm text-[var(--color-text-subtle)]">{label}: —</span>;
  return (
    <Link href={previewQueueHref(`/internal/osm-staging/${id}`, queueId)} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-sm font-bold">
      {icon === "left" && <ArrowLeft aria-hidden="true" size={16} />}{label}{icon === "right" && <ArrowRight aria-hidden="true" size={16} />}
    </Link>
  );
}

export default async function OsmStagingRoutePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale; stagingRouteId: string }>;
  searchParams: Promise<{ queue?: string | string[] }>;
}) {
  const { locale, stagingRouteId } = await params;
  if (!isLocale(locale)) notFound();
  await requireOsmStagingPreviewAccess();
  let queueId: PreviewQueueId | null;
  try {
    queueId = parsePreviewQueueId((await searchParams).queue);
  } catch {
    notFound();
  }
  let result: Awaited<ReturnType<typeof loadApprovedStagingRouteDetail>>;
  try {
    result = await loadApprovedStagingRouteDetail(stagingRouteId, queueId);
  } catch {
    notFound();
  }
  const { detail } = result;
  const phase11hMap = result.phase11hContext
    ? createPhase11hMapViewModel(result.phase11hContext)
    : null;
  const navigation = createPreviewNavigation(result.navigationRoutes, stagingRouteId);
  const queueState = createPreviewQueueState(result.navigationRoutes, stagingRouteId);
  const routeName =
    phase11hMap?.routeName ??
    detail.routeName ??
    `OSM relation ${detail.sourceRelationId}`;
  if (!detail.mountain.coordinates) notFound();

  // Fetch auto-QA recommendation
  const autoQa = await getAutoQaRecommendation(stagingRouteId, queueId);
  const autoQaDisplay = {
    color: autoQa.recommendation === "GREEN" ? "success" : autoQa.recommendation === "YELLOW" ? "warning" : "danger",
    label: autoQa.recommendation === "GREEN" ? "GREEN — Recommended" : autoQa.recommendation === "YELLOW" ? "YELLOW — Review carefully" : "RED — Not recommended",
    description: autoQa.explanation,
    score: autoQa.score,
  };

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8">
      <nav aria-label="Preview navigation" className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-4">
        <Link href={previewQueueHref("/internal/osm-staging", queueId)} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 text-sm font-bold"><ArrowLeft aria-hidden="true" size={16} /> Back to QA list</Link>
        {navigationLink(navigation.previousId, "Previous route", "left", queueId)}
        {navigationLink(navigation.nextId, "Next route", "right", queueId)}
        {navigationLink(navigation.previousPendingId, "Previous pending", "left", queueId)}
        {navigationLink(navigation.nextPendingId, "Next pending", "right", queueId)}
        {navigationLink(navigation.previousWarningId, "Previous warning", "left", queueId)}
        {navigationLink(navigation.nextWarningId, "Next warning", "right", queueId)}
      </nav>

      <header className="grid gap-5 border-b border-[var(--color-border-strong)] py-7 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="technical text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-pine)]">{detail.qaStatus.replaceAll("_", " ")} · staging only</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-5xl">{routeName}</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Relation {detail.sourceRelationId} · staging ID {detail.stagingRouteId}</p>
          {queueId && (
            <p className="mt-2 text-sm font-semibold text-[var(--color-text-secondary)]">
              Route {queueState.position} / {queueState.total} · Reviewed {queueState.reviewed} · Remaining {queueState.remaining}
            </p>
          )}
          {detail.auditCategories && detail.auditCategories.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {detail.auditCategories.map((category) => (
                <span key={category} className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 font-bold uppercase tracking-[0.08em] text-[var(--color-pine)]">{category}</span>
              ))}
              <span className="font-semibold text-[var(--color-text-secondary)]">
                GREEN {detail.qualificationScore ?? detail.qualityScore}/100 · {detail.recoveredByPhase11e ? "recovered" : "stable"} · road safety {detail.roadSafetyStatus ?? "unknown"}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={osmRelationUrl(detail.sourceRelationId)} target="_blank" rel="noreferrer" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold">Open OSM relation <ExternalLink aria-hidden="true" size={16} /></a>
          <Link href={`/mountain/${detail.mountain.id}`} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 font-bold text-white"><Mountain aria-hidden="true" size={17} /> Mountain page</Link>
        </div>
      </header>

      {detail.qualificationReasonCodes && detail.qualificationReasonCodes.length > 0 && (
        <section aria-label="Phase 11F qualification evidence" className="mt-6 border-l-4 border-[var(--color-pine)] bg-[var(--color-surface-muted)] p-4">
          <h2 className="font-bold">Phase 11F GREEN evidence</h2>
          <div className="mt-2 flex flex-wrap gap-1">
            {detail.qualificationReasonCodes.map((reasonCode) => (
              <span key={reasonCode} className="rounded-full bg-[var(--color-surface)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-secondary)]">{reasonCode}</span>
            ))}
          </div>
        </section>
      )}

      {/* Auto-QA Recommendation */}
      <section className="mt-4 p-4 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Auto-QA Recommendation</h2>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Deterministic score: <strong>{autoQaDisplay.score}/100</strong></p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{autoQaDisplay.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {autoQa.reasonCodes.map((code) => (
                <span key={code} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-secondary)]">
                  {code}
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`inline-flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-bold ${autoQaDisplay.color === "success" ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : autoQaDisplay.color === "warning" ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]" : "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"}`}>
              {autoQaDisplay.color === "success" && <BadgeCheck aria-hidden="true" size={16} />}
              {autoQaDisplay.color === "warning" && <Circle aria-hidden="true" size={16} />}
              {autoQaDisplay.color === "danger" && <AlertCircle aria-hidden="true" size={16} />}
              <span>{autoQaDisplay.label}</span>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">Score: {autoQaDisplay.score}/100</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">Auto-QA is a recommendation only. Human decision required; automatic approval is disabled.</p>
      </section>

      {(detail.warnings.length > 0 || detail.performance.unusuallyLarge) && (
        <section aria-label="Warnings" className="mt-6 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4">
          <h2 className="flex items-center gap-2 font-bold text-[var(--color-warning)]"><TriangleAlert aria-hidden="true" size={18} /> Visual inspection warnings</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-secondary)]">
            {detail.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            {detail.performance.unusuallyLarge && <li>Unusually large map input; inspect rendering performance.</li>}
          </ul>
        </section>
      )}

      {result.phase11hContext && phase11hMap && (
        <section
          aria-label="Phase 11H human calibration questions and start evidence"
          className="mt-6 grid gap-5 rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,1fr)]"
        >
          <div>
            <h2 className="text-lg font-bold">Phase 11H human QA questions</h2>
            <ol className="mt-3 grid gap-2 text-sm text-[var(--color-text-secondary)] sm:grid-cols-2">
              {result.phase11hContext.questions.map((question) => (
                <li key={question.id} className="flex gap-2">
                  <span className="font-bold text-[var(--color-pine)]">{question.id}</span>
                  <span>{question.prompt}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h2 className="text-lg font-bold">Start context</h2>
            <p className="mt-2 text-sm font-semibold text-[var(--color-text-secondary)]">
              {phase11hMap.start.label}
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]">
              {phase11hMap.start.evidence.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <OsmStagingRouteMap
        geometry={detail.geometry}
        routeName={routeName}
        summit={
          phase11hMap
            ? {
                coordinates: phase11hMap.summit.coordinates,
                name: `${phase11hMap.summit.name} · OSM ${phase11hMap.summit.osmId}`,
              }
            : {
                coordinates: detail.summit.peakCoordinates,
                name: detail.summit.peakName ?? detail.summit.peakOsmId,
              }
        }
        mountain={{ coordinates: detail.mountain.coordinates, name: detail.mountain.nameDe ?? detail.mountain.name ?? String(detail.mountain.id) }}
        startContext={phase11hMap?.start ?? null}
      />
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">Map input {(detail.performance.mapInputBytes / 1024).toFixed(1)} KiB · {detail.performance.geometryPointCount} points · {detail.componentCount} topology-aware component{detail.componentCount === 1 ? "" : "s"}</p>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <section className="border-t-2 border-[var(--color-pine)] pt-4"><h2 className="text-xl font-bold">Route</h2><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-[var(--color-text-muted)]">Source / canonical ID</dt><dd>{detail.sourceRelationId} / {detail.canonicalRouteSourceId}</dd></div><div><dt className="text-[var(--color-text-muted)]">Semantic type</dt><dd>{detail.semanticType}</dd></div><div><dt className="text-[var(--color-text-muted)]">Distance</dt><dd>{(detail.distanceMeters / 1000).toFixed(2)} km</dd></div><div><dt className="text-[var(--color-text-muted)]">Components</dt><dd>{detail.componentCount}</dd></div><div><dt className="text-[var(--color-text-muted)]">Quality</dt><dd>{detail.qualityScore}/100</dd></div><div><dt className="text-[var(--color-text-muted)]">QA status</dt><dd>{detail.qaStatus}</dd></div></dl></section>

        <section className="border-t-2 border-[var(--color-pine)] pt-4"><h2 className="text-xl font-bold">Summit</h2><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-[var(--color-text-muted)]">OSM peak</dt><dd>{detail.summit.peakName ?? "—"} · {detail.summit.peakOsmId}</dd></div><div><dt className="text-[var(--color-text-muted)]">Elevation</dt><dd>{detail.summit.peakElevationMeters ?? "—"} m</dd></div><div><dt className="text-[var(--color-text-muted)]">Confidence</dt><dd>{detail.summit.finalConfidence}</dd></div><div><dt className="text-[var(--color-text-muted)]">Geometry distance</dt><dd>{detail.summit.minimumGeometryDistanceMeters} m</dd></div><div><dt className="text-[var(--color-text-muted)]">Endpoint distance</dt><dd>{detail.summit.endpointDistanceMeters} m</dd></div><div><dt className="text-[var(--color-text-muted)]">Coordinates</dt><dd>{coordinate(detail.summit.peakCoordinates)}</dd></div></dl></section>

        <section className="border-t-2 border-[var(--color-pine)] pt-4"><h2 className="text-xl font-bold">Mountain Tracker match</h2><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-[var(--color-text-muted)]">Mountain</dt><dd>#{detail.mountain.id} · {detail.mountain.nameDe ?? detail.mountain.name ?? "—"}</dd></div><div><dt className="text-[var(--color-text-muted)]">Classification</dt><dd>{detail.mountainComparison.classification}</dd></div><div><dt className="text-[var(--color-text-muted)]">Coordinates</dt><dd>{coordinate(detail.mountain.coordinates)}</dd></div><div><dt className="text-[var(--color-text-muted)]">Coordinate difference</dt><dd>{detail.mountainComparison.coordinateDifferenceMeters ?? "—"} m</dd></div><div><dt className="text-[var(--color-text-muted)]">Elevation</dt><dd>{detail.mountain.elevationMeters ?? "—"} m</dd></div><div><dt className="text-[var(--color-text-muted)]">Elevation difference</dt><dd>{detail.mountainComparison.elevationDifferenceMeters ?? "—"} m</dd></div><div className="col-span-2"><dt className="text-[var(--color-text-muted)]">Normalized names</dt><dd>{detail.mountainComparison.normalizedPeakName} / {detail.mountainComparison.normalizedMountainNames.join(", ")}</dd></div></dl></section>

        <section className="border-t-2 border-[var(--color-pine)] pt-4"><h2 className="text-xl font-bold">Geometry diagnostics</h2><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-[var(--color-text-muted)]">Component lengths</dt><dd>{detail.diagnostics.componentLengthsMeters.map((value) => `${(value / 1000).toFixed(2)} km`).join(" · ")}</dd></div><div><dt className="text-[var(--color-text-muted)]">Bounding box</dt><dd>{JSON.stringify(detail.diagnostics.boundingBox)}</dd></div><div><dt className="text-[var(--color-text-muted)]">Start / end</dt><dd>{coordinate(detail.diagnostics.startCoordinate)} / {coordinate(detail.diagnostics.endCoordinate)}</dd></div><div><dt className="text-[var(--color-text-muted)]">Topology</dt><dd>{detail.diagnostics.topologyClassification} · {detail.diagnostics.connectedGroupCount} group(s) · {detail.diagnostics.physicalEndpointCount} endpoint(s)</dd></div><div><dt className="text-[var(--color-text-muted)]">Orientation</dt><dd>{detail.diagnostics.endpointOrientationReason}</dd></div><div><dt className="text-[var(--color-text-muted)]">Endpoint straight line</dt><dd>{detail.diagnostics.straightLineDistanceMeters === null ? detail.diagnostics.routeToStraightLineStatus : `${detail.diagnostics.straightLineDistanceMeters} m`}</dd></div><div><dt className="text-[var(--color-text-muted)]">Route / straight ratio</dt><dd>{detail.diagnostics.routeToStraightLineRatio ?? detail.diagnostics.routeToStraightLineStatus}</dd></div><div><dt className="text-[var(--color-text-muted)]">Point count</dt><dd>{detail.diagnostics.geometryPointCount}</dd></div></dl></section>

        <section className="border-t-2 border-[var(--color-pine)] pt-4"><h2 className="text-xl font-bold">Provenance</h2><dl className="mt-4 space-y-3 text-sm"><div><dt className="text-[var(--color-text-muted)]">Source</dt><dd>OpenStreetMap · {detail.provenance.attribution} · {detail.provenance.license}</dd></div><div><dt className="text-[var(--color-text-muted)]">Dataset fingerprint</dt><dd className="break-all font-mono text-xs">{detail.provenance.datasetFingerprint}</dd></div><div><dt className="text-[var(--color-text-muted)]">Contract</dt><dd>{detail.provenance.contractVersion}</dd></div><div><dt className="text-[var(--color-text-muted)]">Administrative boundary</dt><dd><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] p-3 text-xs">{JSON.stringify(detail.provenance.boundary, null, 2)}</pre></dd></div></dl></section>

        <section className="border-t-2 border-[var(--color-pine)] pt-4"><h2 className="text-xl font-bold">Evidence and flags</h2><ul className="mt-4 list-disc space-y-2 pl-5 text-sm">{[...detail.auditFlags, ...detail.evidence].map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul></section>
      </div>

      <OsmStagingQaDecisionForm
        stagingRouteId={detail.stagingRouteId}
        currentDecision={detail.qaDecision}
        writesAvailable={result.qaSchemaAvailable}
        previousRouteId={navigation.previousId}
        nextRouteId={navigation.nextId}
        nextPendingId={navigation.nextPendingId}
        queueId={queueId}
      />

      <footer className="mt-8 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-text-muted)]">Server query {detail.performance.serverQueryMilliseconds.toFixed(1)} ms · serialized detail {(detail.performance.serializedPayloadBytes / 1024).toFixed(1)} KiB · staging QA only · no publication</footer>
    </main>
  );
}
