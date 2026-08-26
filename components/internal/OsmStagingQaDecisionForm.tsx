"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Save, SkipForward, TriangleAlert } from "lucide-react";

import {
  QA_REVIEWER_NOTE_MAX_LENGTH,
  type PreviewQaDecision,
  type PreviewQaStatus,
} from "@/Lib/osmStagingPreview/core";
import { saveOsmStagingQaDecision } from "@/app/[locale]/internal/osm-staging/actions";
import { useRouter } from "@/i18n/navigation";

const STATUS_LABELS: Record<PreviewQaStatus, string> = {
  PENDING: "Pending",
  VISUALLY_APPROVED: "Visually approved",
  NEEDS_REVIEW: "Needs review",
  REJECTED: "Rejected",
};

export default function OsmStagingQaDecisionForm({
  stagingRouteId,
  currentDecision,
  writesAvailable,
  nextRouteId,
  nextPendingId,
}: {
  stagingRouteId: string;
  currentDecision: PreviewQaDecision | null;
  writesAvailable: boolean;
  nextRouteId: string | null;
  nextPendingId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<PreviewQaStatus>(currentDecision?.status ?? "PENDING");
  const [note, setNote] = useState(currentDecision?.reviewerNote ?? "");
  const [savedDecision, setSavedDecision] = useState<PreviewQaDecision | null>(currentDecision);
  const [message, setMessage] = useState<string | null>(null);

  function save(destination: "STAY" | "NEXT" | "NEXT_PENDING") {
    if (status === "REJECTED" && !window.confirm("Reject this staging route? This records a QA decision but does not delete or publish anything.")) {
      return;
    }
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await saveOsmStagingQaDecision({
          stagingRouteId,
          status,
          reviewerNote: note,
          expectedVersion: savedDecision?.version ?? null,
        });
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        const decision = result.status === "PENDING" || result.version === null || !result.reviewedAt
          ? null
          : {
              status: result.status,
              reviewerNote: result.reviewerNote,
              reviewedAt: result.reviewedAt,
              version: result.version,
            } as PreviewQaDecision;
        setSavedDecision(decision);
        setNote(decision?.reviewerNote ?? "");
        setMessage(result.changed ? "Decision saved." : "Already pending; nothing changed.");
        const destinationId = destination === "NEXT_PENDING" ? nextPendingId : destination === "NEXT" ? nextRouteId : null;
        if (destinationId) router.push(`/internal/osm-staging/${destinationId}`);
        else router.refresh();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Decision could not be saved.",
        );
      }
    });
  }

  const currentStatus = savedDecision?.status ?? "PENDING";
  return (
    <section className="mt-8 border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Visual QA decision</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Current status: <strong>{STATUS_LABELS[currentStatus]}</strong>
            {savedDecision?.reviewedAt ? ` · ${new Date(savedDecision.reviewedAt).toLocaleString()}` : " · not yet reviewed"}
          </p>
        </div>
        {currentStatus === "VISUALLY_APPROVED" && (
          <span className="inline-flex items-center gap-2 text-sm font-bold text-[var(--color-success)]"><CheckCircle2 aria-hidden="true" size={18} /> Reviewed</span>
        )}
      </div>

      {!writesAvailable && (
        <p className="mt-4 flex items-center gap-2 bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning)]">
          <TriangleAlert aria-hidden="true" size={18} /> Phase 9B SQL is not applied; decision writes remain disabled.
        </p>
      )}

      <fieldset disabled={!writesAvailable || isPending} className="mt-5 grid gap-4 disabled:opacity-60">
        <legend className="text-sm font-bold">Decision</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(STATUS_LABELS) as PreviewQaStatus[]).map((value) => (
            <label key={value} className={`ui-pressable inline-flex min-h-11 cursor-pointer items-center rounded-[var(--radius-control)] border px-4 text-sm font-bold ${status === value ? "border-[var(--color-pine)] bg-[var(--color-pine)] text-white" : "border-[var(--color-border)]"}`}>
              <input className="sr-only" type="radio" name="qa-status" value={value} checked={status === value} onChange={() => setStatus(value)} />
              {STATUS_LABELS[value]}
            </label>
          ))}
        </div>
        <label className="grid gap-2 text-sm font-bold">
          Reviewer note (plain text, optional)
          <textarea
            value={note}
            maxLength={QA_REVIEWER_NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-normal"
          />
          <span className="text-xs font-normal text-[var(--color-text-muted)]">{note.length}/{QA_REVIEWER_NOTE_MAX_LENGTH}</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => save("STAY")} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 text-sm font-bold text-white"><Save aria-hidden="true" size={17} /> Save</button>
          <button type="button" onClick={() => save("NEXT")} disabled={!nextRouteId} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40">Save &amp; next <SkipForward aria-hidden="true" size={17} /></button>
          <button type="button" onClick={() => save("NEXT_PENDING")} disabled={!nextPendingId} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40">Save &amp; next pending <SkipForward aria-hidden="true" size={17} /></button>
        </div>
      </fieldset>
      {message && <p aria-live="polite" className="mt-3 text-sm font-semibold text-[var(--color-text-secondary)]">{message}</p>}
      <p className="mt-4 text-xs text-[var(--color-text-muted)]">A visual approval remains an internal QA state. It does not publish this route.</p>
    </section>
  );
}
