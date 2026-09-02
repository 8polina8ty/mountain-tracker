import {
  osmRelationUrl,
  type ApprovedStagingRouteListItem,
} from "@/Lib/osmStagingPreview/core";
import {
  type Phase11hCalibrationPreviewResult,
} from "@/Lib/osmStagingPreview/server";
import {
  createPhase11hCalibrationMemberRenderModel,
  formatPhase11hBadge,
} from "@/Lib/osmStagingPreview/phase11h-calibration-view";
import { previewQueueHref } from "@/Lib/osmStagingPreview/queue-core";
import { Link } from "@/i18n/navigation";

export default function Phase11hCalibrationQueue({
  calibration,
  routes,
  qaWritesAvailable,
}: {
  calibration: Phase11hCalibrationPreviewResult;
  routes: ApprovedStagingRouteListItem[];
  qaWritesAvailable: boolean;
}) {
  const { summary, members, questions } = calibration;
  const routesByRelation = new Map(
    routes.map((route) => [route.sourceRelationId, route]),
  );
  if (
    routes.length !== summary.staged ||
    members.some(
      (member) =>
        member.stagingStatus === "STAGED" &&
        !routesByRelation.has(member.canonicalRelationId),
    )
  ) {
    throw new Error("Phase 11H actionable staging routes do not match the queue.");
  }
  const decided = routes.filter((route) => route.qaStatus !== "PENDING").length;
  const pending = routes.length - decided;
  return (
    <div>
      <header className="border-b border-[var(--color-border-strong)] pb-7">
        <p className="technical text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-pine)]">
          Internal · Persistent QA · Phase 11H human calibration
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-[var(--color-text)] sm:text-5xl">
          Phase 11H human calibration queue
        </h1>
        <p className="mt-3 max-w-3xl text-[var(--color-text-secondary)]">
          Read-only human QA of {summary.staged} staged calibration routes and {" "}
          {summary.blocked} blocked queue member. Open a staged route to inspect its
          map and record an explicit human decision; publication remains separate.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm font-semibold text-[var(--color-text-secondary)]">
          <span>Total {summary.total}</span>
          <span>Actionable pending {pending}</span>
          <span>Decided {decided}</span>
          <span>Staged {summary.staged}</span>
          <span>Blocked {summary.blocked}</span>
        </div>
        <div className="mt-5 flex flex-wrap gap-3 text-xs text-[var(--color-text-muted)]">
          <span>Queue {calibration.queueVersion}</span>
          <span>·</span>
          <span>Queue SHA-256 {calibration.queueFileSha256.slice(0, 16)}…</span>
          <span>·</span>
          <span>Artifact {calibration.artifactType}</span>
          <span>·</span>
          <span>Read-only {String(calibration.readOnly)}</span>
          <span>·</span>
          <span>Server: {calibration.performance.serverQueryMilliseconds.toFixed(1)} ms</span>
          <span>·</span>
          <span>Payload: {(calibration.performance.serializedPayloadBytes / 1024).toFixed(1)} KiB</span>
        </div>
      </header>

      {!qaWritesAvailable && (
        <p className="mt-5 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
          QA storage is unavailable. Maps remain inspectable, but decision controls
          are disabled and fail closed.
        </p>
      )}

      <section aria-label="Calibration QA questions" className="mt-5 rounded-[var(--radius-panel)] border border-[var(--color-border)] p-4">
        <h2 className="text-sm font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
          QA questions ({questions.length})
        </h2>
        <ol className="mt-3 grid gap-2 text-sm text-[var(--color-text-secondary)] lg:grid-cols-2">
          {questions.map((question) => (
            <li key={question.id} className="flex gap-2">
              <span className="font-bold text-[var(--color-pine)]">{question.id}</span>
              <span>{question.prompt}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Calibration summary" className="mt-5 grid gap-4 text-sm text-[var(--color-text-secondary)] sm:grid-cols-2 xl:grid-cols-4">
        <dl className="rounded-[var(--radius-panel)] border border-[var(--color-border)] p-4">
          <dt className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Quality bands</dt>
          {Object.entries(summary.qualityBands).map(([value, count]) => (
            <dd key={value} className="font-semibold">{value}: {count}</dd>
          ))}
        </dl>
        <dl className="rounded-[var(--radius-panel)] border border-[var(--color-border)] p-4">
          <dt className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Selection tiers</dt>
          {Object.entries(summary.selectionTiers).map(([value, count]) => (
            <dd key={value} className="font-semibold">{formatPhase11hBadge(value)}: {count}</dd>
          ))}
        </dl>
        <dl className="rounded-[var(--radius-panel)] border border-[var(--color-border)] p-4">
          <dt className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Start contexts</dt>
          {Object.entries(summary.startContexts).map(([value, count]) => (
            <dd key={value} className="font-semibold">{formatPhase11hBadge(value)}: {count}</dd>
          ))}
        </dl>
        <dl className="rounded-[var(--radius-panel)] border border-[var(--color-border)] p-4">
          <dt className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Name statuses</dt>
          {Object.entries(summary.nameStatuses).map(([value, count]) => (
            <dd key={value} className="font-semibold">{formatPhase11hBadge(value)}: {count}</dd>
          ))}
        </dl>
      </section>

      <div className="mt-6 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">
        {members.map((member) => {
          const view = createPhase11hCalibrationMemberRenderModel(member);
          const route = routesByRelation.get(member.canonicalRelationId);
          return (
          <article key={member.canonicalRelationId} className="grid gap-4 py-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                  #{member.queuePosition} / {summary.total}
                </span>
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-pine)]">
                  {view.qualityBand}
                </span>
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-pine)]">
                  {view.selectionTier}
                </span>
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                  {view.startContext}
                </span>
                <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
                  {view.stagingLabel}
                </span>
              </div>
              <h2 className="mt-2 truncate text-xl font-bold text-[var(--color-text)]">
                {view.displayName}
              </h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Relation{" "}
                <a
                  href={osmRelationUrl(member.canonicalRelationId)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-[var(--color-pine)] underline"
                >
                  {member.canonicalRelationId}
                </a>{" "}
                · {view.nameStatus} · {view.nameOrigin}
              </p>
              {route ? (
                <Link
                  href={previewQueueHref(
                    `/internal/osm-staging/${route.stagingRouteId}`,
                    "phase11h",
                  )}
                  className="ui-pressable mt-4 inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 text-sm font-bold text-white"
                >
                  Open map &amp; visual QA
                </Link>
              ) : (
                <p className="mt-4 inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 text-sm font-bold text-[var(--color-warning)]">
                  Read-only · no staging identity · no QA controls
                </p>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-2 text-sm">
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">Selection reason</dt>
                <dd className="font-semibold">{view.selectionReason}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">Human decision</dt>
                <dd className="font-semibold text-[var(--color-text-secondary)]">
                  {route ? formatPhase11hBadge(route.qaStatus) : view.humanDecisionLabel}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">Staging blocker</dt>
                <dd className="font-semibold text-[var(--color-text-secondary)]">
                  {view.blockingReason}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-muted)]">Summit / mountain identity</dt>
                <dd className="font-semibold text-[var(--color-text-secondary)]">
                  {view.summitOsmId} · {view.mountainResolutionStatus} · {member.resolvedMountainId ?? "—"}
                </dd>
              </div>
              {view.resolutionEvidence.length > 0 && (
                <div>
                  <dt className="text-xs text-[var(--color-text-muted)]">Stageability evidence</dt>
                  <dd className="text-[var(--color-text-secondary)]">
                    <ul className="list-disc pl-5">
                      {view.resolutionEvidence.map((evidence) => (
                        <li key={evidence}>{evidence}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              <details className="text-xs text-[var(--color-text-muted)]">
                <summary className="cursor-pointer font-semibold">Frozen identity hashes</summary>
                <dl className="mt-2 grid gap-2">
                  <div>
                    <dt>Candidate hash</dt>
                    <dd className="break-all font-mono">{member.candidateHash}</dd>
                  </div>
                  <div>
                    <dt>Qualification hash</dt>
                    <dd className="break-all font-mono">{member.qualificationHash}</dd>
                  </div>
                </dl>
              </details>
            </dl>
          </article>
          );
        })}
      </div>
    </div>
  );
}
