"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { deleteJournalEntry } from "@/Lib/projects/mutations";
import { logProjectMediaDisplayDiagnostic } from "@/Lib/projects/mediaDiagnostics";
import type { ProjectJournalCursor, ProjectJournalEntry, ProjectJournalMediaDelivery } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";
import ProjectJournalEditor from "./ProjectJournalEditor";
import ProjectPhotoGallery from "./ProjectPhotoGallery";
import { buildDayJournalPresentation } from "./projectJournalPresentation";

type JournalPageResponse = {
  entries: ProjectJournalEntry[];
  deliveries: ProjectJournalMediaDelivery[];
  nextCursor: ProjectJournalCursor | null;
};

export default function ProjectJournal({
  projectId,
  projectDayId = null,
  entries,
  deliveries,
  initialCursor = null,
  totalCount = entries.length,
  emptyText,
  compact = false,
  editable = true,
  currentUserId,
  owner = false,
}: {
  projectId: string;
  projectDayId?: string | null;
  entries: ProjectJournalEntry[];
  deliveries: ProjectJournalMediaDelivery[];
  initialCursor?: ProjectJournalCursor | null;
  totalCount?: number;
  emptyText: string;
  compact?: boolean;
  editable?: boolean;
  currentUserId?: string;
  owner?: boolean;
}) {
  const t = useTranslations("Projects.Mutations");
  const mediaT = useTranslations("Projects.Media");
  const activityT = useTranslations("Projects.Activity");
  const pickerT = useTranslations("Projects.Picker");
  const format = useFormatter();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadedEntries, setLoadedEntries] = useState(entries);
  const [loadedDeliveries, setLoadedDeliveries] = useState(deliveries);
  const [cursor, setCursor] = useState<ProjectJournalCursor | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);

  useEffect(() => {
    setLoadedEntries(entries);
    setLoadedDeliveries(deliveries);
    setCursor(initialCursor);
    setLoadMoreFailed(false);
  }, [deliveries, entries, initialCursor]);

  useEffect(() => {
    const entryIds = new Set(loadedEntries.map((entry) => entry.id));
    const matchingDeliveries = loadedDeliveries.filter((media) => entryIds.has(media.journalEntryId) && media.mediaType === "photo");
    logProjectMediaDisplayDiagnostic("journal", {
      dayJournalEntryCount: projectDayId ? loadedEntries.length : 0,
      photoDeliveryMatchCount: matchingDeliveries.length,
      photoDeliveryAvailable: matchingDeliveries.some((media) => media.deliveryState === "ready"),
    });
  }, [loadedDeliveries, loadedEntries, projectDayId]);

  function reset() { setCreating(false); setEditingId(null); setError(""); }
  function complete() { reset(); router.refresh(); }
  async function remove(entry: ProjectJournalEntry) {
    if (busy || !window.confirm(t("journalDeleteConfirm"))) return;
    setBusy(true); setError("");
    const result = await deleteJournalEntry(createClient(), projectId, entry.id);
    setBusy(false);
    if (!result.ok) { setError(t("journalDeleteError")); return; }
    reset(); router.refresh();
  }
  function startEdit(entry: ProjectJournalEntry) { setCreating(false); setEditingId(entry.id); setError(""); }
  function entryMedia(entry: ProjectJournalEntry) { return loadedDeliveries.filter((media) => media.journalEntryId === entry.id); }
  function canEditEntry(entry: ProjectJournalEntry) { return editable && entry.userId === currentUserId; }
  function canDeleteEntry(entry: ProjectJournalEntry) { return editable && (owner || entry.userId === currentUserId); }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const params = new URLSearchParams({ cursorDate: cursor.entryDate, cursorId: cursor.id });
      if (projectDayId) params.set("day", projectDayId);
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/journal?${params.toString()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`journal-page-${response.status}`);
      const page = await response.json() as JournalPageResponse;
      setLoadedEntries((current) => {
        const ids = new Set(current.map((entry) => entry.id));
        return [...current, ...page.entries.filter((entry) => !ids.has(entry.id))]
          .sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.id.localeCompare(a.id));
      });
      setLoadedDeliveries((current) => {
        const ids = new Set(current.map((media) => media.id));
        return [...current, ...page.deliveries.filter((media) => !ids.has(media.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  const dayPresentation = compact ? buildDayJournalPresentation(loadedEntries, loadedDeliveries) : null;
  const visibleEntries = dayPresentation?.textEntries ?? loadedEntries;
  const dayMedia = dayPresentation?.media ?? [];
  const hasMore = cursor !== null && loadedEntries.length < totalCount;
  const addButton = editable && !creating && !editingId && <button type="button" onClick={() => setCreating(true)} className="ui-pressable inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 text-sm font-bold text-[var(--color-text-inverse)]"><Plus aria-hidden="true" size={17} />{t(projectDayId ? "newDayJournal" : "newJournal")}</button>;

  return <div>
    {!compact && <div className="mb-4">{addButton}</div>}
    {editable && creating && <ProjectJournalEditor projectId={projectId} projectDayId={projectDayId} existingPhotos={[]} onCancel={reset} onComplete={complete} />}
    {compact && dayMedia.length > 0 && <ProjectPhotoGallery projectId={projectId} entryTitle={null} photos={dayMedia} managing={editable} heading={mediaT("mediaFromThisDay")} />}
    {totalCount === 0 && visibleEntries.length === 0 && dayMedia.length === 0 && !creating && <p className="border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-5 text-sm leading-6 text-[var(--color-text-muted)]">{emptyText}</p>}
    <div className={compact ? "mt-4 space-y-3" : "grid gap-4 xl:grid-cols-2"}>{visibleEntries.map((entry) => editingId === entry.id && canEditEntry(entry) ? <div key={entry.id} className={compact ? "" : "xl:col-span-2"}><ProjectJournalEditor projectId={projectId} projectDayId={projectDayId} entry={entry} existingPhotos={entryMedia(entry)} showExistingPhotos={!compact} onCancel={reset} onComplete={complete} /></div> : <article key={entry.id} className="min-w-0 border border-[var(--color-border)] border-l-4 border-l-[var(--color-forest)] bg-[var(--color-surface)] px-4 py-4 shadow-[var(--shadow-control)]"><div className="flex items-start justify-between gap-2"><time className="[font-family:var(--font-technical)] text-xs font-semibold text-[var(--color-text-muted)]">{format.dateTime(new Date(entry.entryDate), compact ? { hour: "2-digit", minute: "2-digit" } : { dateStyle: "medium", timeStyle: "short" })}</time><span className="flex">{canEditEntry(entry) && <button type="button" disabled={busy} onClick={() => startEdit(entry)} aria-label={t("editJournalAria")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface-muted)]"><Pencil aria-hidden="true" size={16} /></button>}{canDeleteEntry(entry) && <button type="button" disabled={busy} onClick={() => void remove(entry)} aria-label={t("deleteJournalAria")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]">{busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <Trash2 aria-hidden="true" size={16} />}</button>}</span></div>{entry.title && <h3 className="mt-1 break-words text-lg font-bold text-[var(--color-text)]">{entry.title}</h3>}{entry.body && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-secondary)]">{entry.body}</p>}{!compact && <ProjectPhotoGallery projectId={projectId} entryTitle={entry.title} photos={entryMedia(entry)} />}</article>)}</div>
    {hasMore && <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="ui-pressable mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[var(--color-border)] px-3 text-sm font-bold disabled:opacity-50">{loadingMore && <LoaderCircle aria-hidden="true" className="animate-spin" size={16}/>} {loadMoreFailed ? pickerT("retry") : activityT(loadingMore ? "loading" : "showMore")}</button>}
    {compact && <div className="mt-4">{addButton}</div>}
    {error && !creating && !editingId && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}
  </div>;
}
