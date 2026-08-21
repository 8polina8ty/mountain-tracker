"use client";

import { useState } from "react";
import { Activity, LoaderCircle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { listProjectActivity } from "@/Lib/projects/activity";
import type { ProjectActivityItem, ProjectActivityPage } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/client";

const actionKeys: Record<ProjectActivityItem["actionType"], string> = {
  "project.status_changed":"projectStatusChanged", "project.archived":"projectArchived", "project.restored":"projectRestored",
  "mountain.added":"mountainAdded", "mountain.removed":"mountainRemoved", "mountain.assigned_to_day":"mountainAssigned", "mountain.unassigned_from_day":"mountainUnassigned",
  "day.created":"dayCreated", "day.updated":"dayUpdated", "day.deleted":"dayDeleted", "day.reordered":"dayReordered",
  "journal.created":"journalCreated", "journal.updated":"journalUpdated", "journal.deleted":"journalDeleted",
  "media.photo_uploaded":"photoUploaded", "media.video_uploaded":"videoUploaded", "media.deleted":"mediaDeleted",
  "track.linked":"trackLinked", "track.imported_and_linked":"trackImported", "track.unlinked":"trackUnlinked",
  "member.joined":"memberJoined", "member.role_changed":"memberRoleChanged", "member.removed":"memberRemoved", "member.left":"memberLeft",
  "sharing.enabled":"sharingEnabled", "sharing.disabled":"sharingDisabled",
};

export default function ProjectActivity({ projectId, initialPage }: { projectId: string; initialPage: ProjectActivityPage }) {
  const t = useTranslations("Projects.Activity");
  const format = useFormatter();
  const [items, setItems] = useState(initialPage.items);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  async function showMore() {
    if (!cursor || loading) return;
    setLoading(true); setFailed(false);
    try { const page = await listProjectActivity(createClient(), projectId, cursor); setItems((current) => [...current, ...page.items]); setCursor(page.nextCursor); }
    catch { setFailed(true); }
    finally { setLoading(false); }
  }
  return <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-control)]" aria-labelledby="project-activity-title">
    <h2 id="project-activity-title" className="flex items-center gap-2 text-lg font-bold"><Activity aria-hidden="true" size={18}/>{t("title")}</h2>
    <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("description")}</p>
    {items.length === 0 ? <p className="mt-4 text-sm text-[var(--color-text-muted)]">{t("empty")}</p> : <ol className="mt-4 divide-y divide-[var(--color-border-soft)]">{items.map((item) => {
      const actor = item.actorName ?? item.actorUsername ?? t("formerParticipant");
      const params = { from: String(item.metadata.from ?? ""), to: String(item.metadata.to ?? ""), count: Number(item.metadata.count ?? item.metadata.dayCount ?? 1) };
      return <li key={item.id} className="flex min-w-0 gap-3 py-3 first:pt-0 last:pb-0">
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-forest-soft)] text-xs font-bold text-[var(--color-forest)]">{actor.slice(0,1).toUpperCase()}</span>
        <div className="min-w-0"><p className="break-words text-sm"><span className="font-bold">{actor}</span> {t(actionKeys[item.actionType], params)}</p><time dateTime={item.createdAt} className="mt-1 block text-xs text-[var(--color-text-muted)]">{format.dateTime(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" })}</time></div>
      </li>;
    })}</ol>}
    {failed && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{t("loadFailed")}</p>}
    {cursor && <button type="button" disabled={loading} onClick={() => void showMore()} className="ui-pressable mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[var(--color-border)] px-3 text-sm font-bold disabled:opacity-50">{loading && <LoaderCircle aria-hidden="true" className="animate-spin" size={16}/>} {t(loading ? "loading" : "showMore")}</button>}
  </section>;
}
