import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireOsmStagingPreviewAccess } from "@/Lib/osmStagingPreview/access";
import {
  isCalibrationQueue,
  parsePreviewQueueId,
  type PreviewQueueId,
} from "@/Lib/osmStagingPreview/queue-core";
import {
  loadApprovedStagingRouteList,
  loadPhase11hCalibrationPreview,
} from "@/Lib/osmStagingPreview/server";
import OsmStagingRouteList from "@/components/internal/OsmStagingRouteList";
import Phase11hCalibrationQueue from "@/components/internal/Phase11hCalibrationQueue";
import { isLocale, type Locale } from "@/i18n/locales";

export const metadata: Metadata = {
  title: "OSM staging visual QA",
  robots: { index: false, follow: false, nocache: true },
};

export default async function OsmStagingPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ queue?: string | string[] }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireOsmStagingPreviewAccess();
  let queueId: PreviewQueueId | null;
  try {
    queueId = parsePreviewQueueId((await searchParams).queue);
  } catch {
    notFound();
  }
  if (isCalibrationQueue(queueId)) {
    const [calibration, staged] = await Promise.all([
      loadPhase11hCalibrationPreview(queueId),
      loadApprovedStagingRouteList(queueId),
    ]);
    return (
      <main className="mx-auto min-h-screen max-w-[1500px] px-4 py-10 sm:px-6 lg:px-8">
        <Phase11hCalibrationQueue
          calibration={calibration}
          routes={staged.routes}
          qaWritesAvailable={staged.qaSchemaAvailable}
        />
      </main>
    );
  }
  const result = await loadApprovedStagingRouteList(queueId);

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] px-4 py-10 sm:px-6 lg:px-8">
      <header className="border-b border-[var(--color-border-strong)] pb-7">
        <p className="technical text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-pine)]">
          Internal · Persistent QA · {result.queue?.label ?? "Phase 9B"}
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-[var(--color-text)] sm:text-5xl">
          {result.queue?.label ?? "OSM staging visual QA"}
        </h1>
        <p className="mt-3 max-w-3xl text-[var(--color-text-secondary)]">
          {result.queue
            ? `Manifest-locked review of ${result.queue.total} staging routes. Decisions remain isolated from route publication.`
            : "Manifest-locked review of the 46 approved staging routes. Decisions remain isolated from route publication."}
        </p>
        {result.queue && (
          <div className="mt-4 flex flex-wrap gap-4 text-sm font-semibold text-[var(--color-text-secondary)]">
            <span>Reviewed {result.queue.reviewed} / {result.queue.total}</span>
            <span>Remaining {result.queue.remaining}</span>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-3 text-xs text-[var(--color-text-muted)]">
          <span>Server query: {result.performance.serverQueryMilliseconds.toFixed(1)} ms</span>
          <span>·</span>
          <span>Staging: {result.performance.stagingMetadataQueryMilliseconds.toFixed(1)} ms</span>
          <span>·</span>
          <span>QA: {result.performance.qaDecisionQueryMilliseconds.toFixed(1)} ms</span>
          <span>·</span>
          <span>Browser list payload: {(result.performance.serializedPayloadBytes / 1024).toFixed(1)} KiB</span>
          <span>·</span>
          <span>Full geometries sent: 0</span>
        </div>
      </header>

      {!result.qaSchemaAvailable && (
        <p className="mt-5 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
          Phase 9B SQL has not been applied. All routes display as pending and decision writes are disabled.
        </p>
      )}

      <OsmStagingRouteList routes={result.routes} queue={result.queue} />
    </main>
  );
}
