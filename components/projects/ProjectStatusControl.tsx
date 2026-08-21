"use client";

import { useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { updateProjectStatus } from "@/Lib/projects/mutations";
import { PROJECT_STATUSES, type ProjectCompletionSummary, type ProjectStatus } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";

export default function ProjectStatusControl({ projectId, userId, status, summary, allowArchive = true }: { projectId: string; userId: string; status: ProjectStatus; summary: ProjectCompletionSummary; allowArchive?: boolean }) {
  const t = useTranslations("Projects.Mutations");
  const statusT = useTranslations("Projects.Status");
  const lifeT = useTranslations("Projects.Lifecycle");
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<"success" | "error" | null>(null);
  const [pending, setPending] = useState<ProjectStatus | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  async function change(next: ProjectStatus) {
    if (saving || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    setMessage(null);
    const result = await updateProjectStatus(createClient(), userId, projectId, next);
    setSaving(false);
    if (!result.ok) {
      setValue(previous);
      setMessage("error");
      return;
    }
    setMessage("success");
    router.refresh();
  }

  function requestChange(next: ProjectStatus) {
    if (next === value || saving) return;
    if (next === "completed" || next === "archived") {
      setPending(next);
      dialogRef.current?.showModal();
      return;
    }
    void change(next);
  }

  return (
    <div className="min-w-48">
      <label htmlFor="project-status" className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-subtle)]">{t("statusLabel")}</label>
      <div className="relative">
        <select id="project-status" value={value} disabled={saving} onChange={(event) => requestChange(event.target.value as ProjectStatus)} className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-white/25 bg-white/10 px-3 pr-9 text-sm font-bold text-[var(--color-text-inverse)] disabled:cursor-wait disabled:opacity-65">
          {PROJECT_STATUSES.filter((option) => allowArchive || option !== "archived").map((option) => <option key={option} value={option} className="text-[var(--color-text)]">{statusT(option)}</option>)}
        </select>
        {saving && <LoaderCircle aria-hidden="true" className="absolute right-3 top-3 animate-spin" size={17} />}
      </div>
      <p aria-live="polite" className={`mt-1 text-xs ${message === "error" ? "text-red-200" : "text-[var(--color-text-subtle)]"}`}>
        {saving ? t("saving") : message ? t(message === "success" ? "statusSaved" : "statusError") : ""}
      </p>
      <dialog ref={dialogRef} aria-labelledby="project-status-confirm-title" className="m-auto w-[min(34rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-card)] backdrop:bg-black/55">
        <div className="p-5"><h2 id="project-status-confirm-title" className="text-xl font-bold">{lifeT(pending === "archived" ? "archiveProject" : "completeProject")}</h2><p className="mt-2 text-sm text-[var(--color-text-muted)]">{lifeT(pending === "archived" ? "archiveProjectConfirm" : "completeProjectConfirm")}</p>{pending === "completed" && <><dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3"><SummaryMetric label={lifeT("summaryDays")} value={summary.totalDays}/><SummaryMetric label={lifeT("summaryMountains")} value={summary.plannedMountainCount}/><SummaryMetric label={lifeT("daysWithEvidence")} value={summary.daysWithGpsEvidence}/><SummaryMetric label={lifeT("verifiedMountains")} value={summary.verifiedMountainCount}/><SummaryMetric label={lifeT("photos")} value={summary.photoCount}/><SummaryMetric label={lifeT("videos")} value={summary.videoCount}/></dl>{!summary.readyToComplete || summary.noEvidenceMountainCount > 0 ? <p className="mt-4 border-l-2 border-[var(--color-warning)] pl-3 text-sm" role="status">{lifeT("completionEvidenceMissing")}</p> : <p className="mt-4 text-sm font-bold text-[var(--color-forest)]">{lifeT("readyToComplete")}</p>}</>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => { setPending(null); dialogRef.current?.close(); }} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold">{t("cancel")}</button><button type="button" onClick={() => { const next = pending; setPending(null); dialogRef.current?.close(); if (next) void change(next); }} className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-[var(--color-text-inverse)]">{lifeT(pending === "archived" ? "archiveProject" : "completeProject")}</button></div></div>
      </dialog>
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) { return <div><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd className="mt-1 text-lg font-bold tabular-nums">{value}</dd></div>; }
