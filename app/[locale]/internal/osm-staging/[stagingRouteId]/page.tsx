import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, ExternalLink, Mountain, TriangleAlert } from "lucide-react";
import { notFound } from "next/navigation";

import { requireOsmStagingPreviewAccess } from "@/Lib/osmStagingPreview/access";
import { createPreviewNavigation, osmRelationUrl } from "@/Lib/osmStagingPreview/core";
import { loadApprovedStagingRouteDetail } from "@/Lib/osmStagingPreview/server";
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

function navigationLink(id: string | null, label: string, icon: "left" | "right") {
  if (!id) return <span className="text-sm text-[var(--color-text-subtle)]">{label}: —</span>;
  return (
    <Link href={`/internal/osm-staging/${id}`} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-sm font-bold">
      {icon === "left" && <ArrowLeft aria-hidden="true" size={16} />}{label}{icon === "right" && <ArrowRight aria-hidden="true" size={16} />}
    </Link>
  );
}

export default async function OsmStagingRoutePreviewPage({
  params,
}: {
  params: Promise<{ locale: Locale; stagingRouteId: string }>;
}) {
  const { locale, stagingRouteId } = await params;
  if (!isLocale(locale)) notFound();
  await requireOsmStagingPreviewAccess();
  let result: Awaited<ReturnType<typeof loadApprovedStagingRouteDetail>>;
  try {
    result = await loadApprovedStagingRouteDetail(stagingRouteId);
  } catch {
    notFound();
  }
  const { detail } = result;
  const navigation = createPreviewNavigation(result.navigationRoutes, stagingRouteId);
  const routeName = detail.routeName ?? `OSM relation ${detail.sourceRelationId}`;
  if (!detail.mountain.coordinates) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] px-4 py-8 sm:px-6 lg:px-8">
      <nav aria-label="Preview navigation" className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-4">
        <Link href="/internal/osm-staging" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 text-sm font-bold"><ArrowLeft aria-hidden="true" size={16} /> Back to QA list</Link>
        {navigationLink(navigation.previousId, "Previous route", "left")}
        {navigationLink(navigation.nextId, "Next route", "right")}
        {navigationLink(navigation.previousPendingId, "Previous pending", "left")}
        {navigationLink(navigation.nextPendingId, "Next pending", "right")}
        {navigationLink(navigation.previousWarningId, "Previous warning", "left")}
        {navigationLink(navigation.nextWarningId, "Next warning", "right")}
      </nav>

      <header className="grid gap-5 border-b border-[var(--color-border-strong)] py-7 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="technical text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-pine)]">{detail.qaStatus.replaceAll("_", " ")} · staging only</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-5xl">{routeName}</h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Relation {detail.sourceRelationId} · staging ID {detail.stagingRouteId}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={osmRelationUrl(detail.sourceRelationId)} target="_blank" rel="noreferrer" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold">Open OSM relation <ExternalLink aria-hidden="true" size={16} /></a>
          <Link href={`/mountain/${detail.mountain.id}`} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 font-bold text-white"><Mountain aria-hidden="true" size={17} /> Mountain page</Link>
        </div>
      </header>

      {(detail.warnings.length > 0 || detail.performance.unusuallyLarge) && (
        <section aria-label="Warnings" className="mt-6 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4">
          <h2 className="flex items-center gap-2 font-bold text-[var(--color-warning)]"><TriangleAlert aria-hidden="true" size={18} /> Visual inspection warnings</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-secondary)]">
            {detail.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            {detail.performance.unusuallyLarge && <li>Unusually large map input; inspect rendering performance.</li>}
          </ul>
        </section>
      )}

      <OsmStagingRouteMap
        geometry={detail.geometry}
        routeName={routeName}
        summit={{ coordinates: detail.summit.peakCoordinates, name: detail.summit.peakName ?? detail.summit.peakOsmId }}
        mountain={{ coordinates: detail.mountain.coordinates, name: detail.mountain.nameDe ?? detail.mountain.name ?? String(detail.mountain.id) }}
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
        nextRouteId={navigation.nextId}
        nextPendingId={navigation.nextPendingId}
      />

      <footer className="mt-8 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-text-muted)]">Server query {detail.performance.serverQueryMilliseconds.toFixed(1)} ms · serialized detail {(detail.performance.serializedPayloadBytes / 1024).toFixed(1)} KiB · staging QA only · no publication</footer>
    </main>
  );
}
