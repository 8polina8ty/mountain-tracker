"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ImagePlus, LoaderCircle, Pause, Play, RefreshCw, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { uploadProjectJournalMedia } from "@/Lib/projects/media";
import { ProjectMediaUploadController, selectProjectMediaUploadTransport } from "@/Lib/projects/mediaUploadTransport";
import { inspectProjectJournalMediaFile, PROJECT_JOURNAL_MEDIA_MAX_ITEMS, type InspectedProjectJournalMedia } from "@/Lib/projects/mediaValidation";
import { runBoundedMediaUploads } from "@/Lib/projects/photoUploadQueue";
import { createJournalEntry, updateJournalEntry } from "@/Lib/projects/mutations";
import type { ProjectJournalEntry, ProjectJournalMediaDelivery, ProjectJournalMediaFailureReason, ProjectJournalMediaValidationReason } from "@/Lib/projects/types";
import { PROJECT_JOURNAL_BODY_MAX_LENGTH, PROJECT_JOURNAL_TITLE_MAX_LENGTH, validateJournalEntry } from "@/Lib/projects/validation";
import { createClient } from "@/Lib/supabase/client";
import ProjectPhotoGallery from "./ProjectPhotoGallery";
import ProjectVideoThumbnail from "./ProjectVideoThumbnail";
import ProjectConflictNotice from "./ProjectConflictNotice";
import { useRouter } from "@/i18n/navigation";

type DraftStatus = "pending" | "uploading" | "paused" | "resuming" | "success" | "error" | "invalid";
type PhotoDraft = {
  id: string;
  file: File;
  previewUrl: string | null;
  inspected: InspectedProjectJournalMedia | null;
  status: DraftStatus;
  validationReason: ProjectJournalMediaValidationReason | null;
  failureReason: ProjectJournalMediaFailureReason | null;
  progress: number;
};

export default function ProjectJournalEditor({
  projectId,
  entry,
  existingPhotos,
  projectDayId,
  showExistingPhotos = true,
  onCancel,
  onComplete,
}: {
  projectId: string;
  entry?: ProjectJournalEntry;
  existingPhotos: ProjectJournalMediaDelivery[];
  projectDayId?: string | null;
  showExistingPhotos?: boolean;
  onCancel: () => void;
  onComplete: () => void;
}) {
  const t = useTranslations("Projects.Mutations");
  const mediaT = useTranslations("Projects.Media");
  const format = useFormatter();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const uploadControllersRef = useRef(new Map<string, ProjectMediaUploadController>());
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [drafts, setDrafts] = useState<PhotoDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [createdEntryId, setCreatedEntryId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<"journal" | "permission" | "archived" | null>(null);

  useEffect(() => () => {
    for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
    previewUrlsRef.current.clear();
    for (const controller of uploadControllersRef.current.values()) void controller.cancel();
    uploadControllersRef.current.clear();
  }, []);

  const validDraftCount = drafts.filter((draft) => draft.inspected !== null && draft.status !== "success").length;
  const totalMediaCount = (entry?.media.length ?? 0) + validDraftCount;
  const lockedAfterCreate = Boolean(createdEntryId);

  async function selectPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    setError("");
    const next: PhotoDraft[] = [];
    let accepted = totalMediaCount;
    for (const file of files) {
      const id = crypto.randomUUID();
      if (accepted >= PROJECT_JOURNAL_MEDIA_MAX_ITEMS) {
        next.push({ id, file, previewUrl: null, inspected: null, status: "invalid", validationReason: null, failureReason: "limit", progress: 0 });
        continue;
      }
      const inspected = await inspectProjectJournalMediaFile(file, accepted);
      if (!inspected.ok) {
        next.push({ id, file, previewUrl: null, inspected: null, status: "invalid", validationReason: inspected.reason, failureReason: null, progress: 0 });
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.add(previewUrl);
      next.push({ id, file, previewUrl, inspected: inspected.data, status: "pending", validationReason: null, failureReason: null, progress: 0 });
      accepted += 1;
    }
    setDrafts((current) => [...current, ...next]);
    setAnnouncement(mediaT("selectedMedia", { count: next.length }));
  }

  function removeDraft(id: string) {
    void uploadControllersRef.current.get(id)?.cancel();
    uploadControllersRef.current.delete(id);
    setDrafts((current) => current.filter((draft) => {
      if (draft.id !== id) return true;
      if (draft.previewUrl) {
        URL.revokeObjectURL(draft.previewUrl);
        previewUrlsRef.current.delete(draft.previewUrl);
      }
      return false;
    }));
  }

  function validationMessage() {
    const first = validateJournalEntry({ title, body, mediaCount: totalMediaCount })[0];
    return first === "journal-title-too-long" ? t("journalTitleTooLong")
      : first === "journal-body-too-long" ? t("journalBodyTooLong")
        : first ? t("journalBodyRequired") : "";
  }

  function draftError(draft: PhotoDraft): string {
    if (draft.failureReason === "limit") return mediaT("mediaLimitReached");
    if (draft.failureReason === "cleanup-required") return mediaT("cleanupRequired");
    if (draft.failureReason === "auth" || draft.failureReason === "ownership") return mediaT("authFailure");
    if (draft.failureReason === "metadata") return mediaT("metadataFailure");
    if (draft.failureReason) return mediaT("uploadFailed");
    switch (draft.validationReason) {
      case "invalid-mime": case "signature-mismatch": return draft.file.type.startsWith("video/") ? mediaT("unsupportedVideoType") : mediaT("invalidPhotoType");
      case "photo-too-large": return mediaT("photoTooLarge");
      case "photo-dimensions": case "photo-pixels": return mediaT("photoDimensionsTooLarge");
      case "decode-failed": case "decoding-unavailable": return draft.file.type.startsWith("video/") ? mediaT("videoDecodeFailed") : mediaT("photoDecodeFailed");
      case "video-too-large": return mediaT("videoTooLarge");
      case "video-duration": return mediaT("videoTooLong");
      case "video-dimensions": return mediaT("videoDimensionsTooLarge");
      default: return mediaT("uploadFailed");
    }
  }

  async function uploadDrafts(journalEntryId: string, candidates: PhotoDraft[]) {
    const results = await runBoundedMediaUploads(candidates, async (draft) => {
      const controller = new ProjectMediaUploadController();
      uploadControllersRef.current.set(draft.id, controller);
      setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, status: "uploading", failureReason: null, progress: 0 } : item));
      const result = await uploadProjectJournalMedia(createClient(), {
        mediaId: draft.id,
        projectId,
        journalEntryId,
        file: draft.file,
        width: draft.inspected!.width,
        height: draft.inspected!.height,
        durationSeconds: draft.inspected!.durationSeconds,
        sortOrder: draft.inspected!.sortOrder,
      }, { controller, onProgress: (progress) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, progress, status: item.status === "resuming" ? "uploading" : item.status } : item)) });
      uploadControllersRef.current.delete(draft.id);
      setDrafts((current) => current.map((item) => item.id === draft.id
        ? { ...item, status: result.ok ? "success" : "error", failureReason: result.ok ? null : result.reason }
        : item));
      return { draft, result };
    });
    const successfulIds = new Set(results.filter(({ result }) => result.ok).map(({ draft }) => draft.id));
    setDrafts((current) => current.filter((draft) => {
      if (!successfulIds.has(draft.id)) return true;
      if (draft.previewUrl) {
        URL.revokeObjectURL(draft.previewUrl);
        previewUrlsRef.current.delete(draft.previewUrl);
      }
      return false;
    }));
    return results;
  }

  async function pauseDraft(draft: PhotoDraft) {
    await uploadControllersRef.current.get(draft.id)?.pause();
    setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, status: "paused" } : item));
    setAnnouncement(mediaT("uploadPaused"));
  }

  function resumeDraft(draft: PhotoDraft) {
    setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, status: "resuming" } : item));
    setAnnouncement(mediaT("uploadResuming"));
    uploadControllersRef.current.get(draft.id)?.resume();
  }

  async function retryDraft(draft: PhotoDraft) {
    const targetEntryId = entry?.id ?? createdEntryId;
    if (!targetEntryId || !draft.inspected || busy) return;
    setBusy(true);
    const results = await uploadDrafts(targetEntryId, [draft]);
    setBusy(false);
    if (results[0]?.result.ok) {
      setAnnouncement(mediaT(draft.inspected.mediaType === "video" ? "videoUploadSucceeded" : "photoUploadSucceeded"));
      if (drafts.filter((item) => item.status === "error" && item.id !== draft.id).length === 0) onComplete();
    } else setAnnouncement(mediaT("uploadFailed"));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = validationMessage();
    if (invalid) { setError(invalid); return; }
    const candidates = drafts.filter((draft) => draft.inspected && (draft.status === "pending" || draft.status === "error"));
    setBusy(true);
    setError("");
    let journalEntryId = entry?.id ?? createdEntryId;
    if (!journalEntryId) {
      const result = await createJournalEntry(createClient(), projectId, { title: title || null, body, mediaCount: validDraftCount, projectDayId: projectDayId ?? null });
      if (!result.ok) { setBusy(false); setError(t("journalCreateError")); return; }
      journalEntryId = result.data;
      setCreatedEntryId(result.data);
    } else if (entry) {
      const result = await updateJournalEntry(createClient(), projectId, entry.id, { title: title || null, body, entryDate: entry.entryDate, projectDayId: projectDayId === undefined ? entry.projectDayId : projectDayId, expectedUpdatedAt: entry.updatedAt });
      if (!result.ok) { setBusy(false); if (["conflict", "permission", "archived"].includes(result.reason)) { setConflict(result.reason === "conflict" ? "journal" : result.reason as "permission" | "archived"); return; } setError(t("journalUpdateError")); return; }
    }
    if (candidates.length === 0) {
      setBusy(false);
      onComplete();
      return;
    }
    const results = await uploadDrafts(journalEntryId, candidates);
    setBusy(false);
    const failures = results.filter(({ result }) => !result.ok);
    if (failures.length > 0) {
      setError(failures.some(({ result }) => !result.ok && result.reason === "cleanup-required") ? mediaT("cleanupRequired") : mediaT("uploadPartialFailure"));
      setAnnouncement(mediaT("uploadPartialFailure"));
      return;
    }
    onComplete();
  }

  return (
    <form onSubmit={save} className="mb-4 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4" noValidate>
      {conflict && <ProjectConflictNotice kind={conflict} onReload={() => { setConflict(null); router.refresh(); }} />}
      {entry && showExistingPhotos && <ProjectPhotoGallery projectId={projectId} entryTitle={entry.title} photos={existingPhotos} managing />}
      <label className="block"><span className="mb-1 block text-sm font-bold">{t("journalTitleLabel")}</span><input disabled={lockedAfterCreate} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={PROJECT_JOURNAL_TITLE_MAX_LENGTH} className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 disabled:opacity-60" /></label>
      <label className="block"><span className="mb-1 block text-sm font-bold">{t("journalBodyLabel")}</span><textarea disabled={lockedAfterCreate} value={body} onChange={(event) => setBody(event.target.value)} maxLength={PROJECT_JOURNAL_BODY_MAX_LENGTH} aria-invalid={Boolean(error)} aria-describedby={error ? "journal-form-error" : undefined} className="ui-field min-h-40 w-full resize-y rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 disabled:opacity-60" /><span className="mt-1 block text-xs text-[var(--color-text-muted)]">{mediaT("mediaOnlyEntry")}</span></label>
      <div>
        <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" onChange={(event) => void selectPhotos(event)} className="sr-only" aria-label={mediaT("addMedia")} />
        <button type="button" disabled={busy || totalMediaCount >= PROJECT_JOURNAL_MEDIA_MAX_ITEMS} onClick={() => inputRef.current?.click()} className="ui-pressable inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-4 text-sm font-bold text-[var(--color-forest)] disabled:opacity-50 sm:w-auto"><ImagePlus aria-hidden="true" size={18} />{mediaT("addMedia")}</button>
      </div>
      {drafts.length > 0 && <div aria-label={mediaT("selectedMedia", { count: drafts.length })} className="grid gap-3 sm:grid-cols-2">
        {drafts.map((draft) => <article key={draft.id} aria-describedby={draft.status === "invalid" || draft.status === "error" ? `photo-error-${draft.id}` : undefined} className="min-w-0 border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2">
          {draft.previewUrl && <div className="aspect-[4/3] overflow-hidden bg-black/5">
            {/* Object URLs are local previews and cannot be handled by next/image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {draft.inspected?.mediaType === "video" ? <ProjectVideoThumbnail sourceUrl={draft.previewUrl} durationSeconds={draft.inspected.durationSeconds} lazy={false} showPlay={false} /> : <img src={draft.previewUrl} alt="" className="h-full w-full object-cover" />}
          </div>}
          <div className="mt-2 flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{draft.file.name}</p><p className="text-xs text-[var(--color-text-muted)]">{format.number(draft.file.size / 1024 / 1024, { maximumFractionDigits: 1 })} MB{draft.inspected?.durationSeconds ? ` · ${format.number(draft.inspected.durationSeconds, { maximumFractionDigits: 1 })} s` : ""} · {draft.status === "uploading" || draft.status === "resuming" ? mediaT("uploadProgress", { progress: Math.round(draft.progress) }) : draft.status === "paused" ? mediaT("uploadPaused") : draft.status === "error" ? mediaT("uploadFailed") : draft.status === "invalid" ? draftError(draft) : mediaT("readyToUpload")}</p></div>
            {draft.inspected?.mediaType === "video" && selectProjectMediaUploadTransport("video", draft.file.size) === "tus" && draft.status === "uploading" ? <button type="button" onClick={() => void pauseDraft(draft)} aria-label={mediaT("uploadPaused")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center"><Pause aria-hidden="true" size={17} /></button> : draft.status === "paused" ? <button type="button" onClick={() => resumeDraft(draft)} aria-label={mediaT("uploadResuming")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center"><Play aria-hidden="true" size={17} /></button> : draft.status === "uploading" || draft.status === "resuming" ? <span className="inline-flex min-h-11 min-w-11 items-center justify-center"><LoaderCircle aria-hidden="true" className="animate-spin" size={17} /></span> : <button type="button" onClick={() => removeDraft(draft.id)} aria-label={mediaT("removePhoto", { name: draft.file.name })} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface)]"><X aria-hidden="true" size={17} /></button>}
            {draft.inspected?.mediaType === "video" && ["uploading", "paused", "resuming"].includes(draft.status) && <button type="button" onClick={() => removeDraft(draft.id)} aria-label={mediaT("cancelVideoUpload")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center"><X aria-hidden="true" size={17} /></button>}
          </div>
          {(draft.status === "invalid" || draft.status === "error") && <p id={`photo-error-${draft.id}`} role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{draftError(draft)}</p>}
          {draft.status === "error" && <button type="button" disabled={busy} onClick={() => void retryDraft(draft)} className="ui-pressable mt-2 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-sm font-semibold"><RefreshCw aria-hidden="true" size={15} />{mediaT(draft.inspected?.mediaType === "video" ? "retryVideoUpload" : "retryUpload")}</button>}
        </article>)}
      </div>}
      {error && <p id="journal-form-error" role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{!createdEntryId && <button type="button" disabled={busy} onClick={onCancel} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-semibold">{t("cancel")}</button>}<button type="submit" disabled={busy} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-[var(--color-text-inverse)] disabled:opacity-60">{busy && <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />}{busy ? mediaT("uploading") : t("save")}</button></div>
    </form>
  );
}
