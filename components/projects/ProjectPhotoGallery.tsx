"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff, LoaderCircle, Trash2, VideoOff, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { deleteProjectJournalMedia } from "@/Lib/projects/media";
import type { ProjectJournalMediaDelivery } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";
import ProjectVideoThumbnail from "./ProjectVideoThumbnail";

export default function ProjectPhotoGallery({
  projectId,
  entryTitle,
  photos,
  managing = false,
  heading,
}: {
  projectId: string;
  entryTitle: string | null;
  photos: ProjectJournalMediaDelivery[];
  managing?: boolean;
  heading?: string;
}) {
  const t = useTranslations("Projects.Media");
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (activeIndex === null) {
      videoRef.current?.pause();
      if (dialog.open) dialog.close();
      returnFocusRef.current?.focus();
      return;
    }
    if (!dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [activeIndex]);

  if (photos.length === 0) return null;
  const activePhoto = activeIndex === null ? null : photos[activeIndex];
  const altText = (index: number) => entryTitle?.trim()
    ? t("photoAltWithTitle", { title: entryTitle, number: index + 1, count: photos.length })
    : t("photoAlt", { number: index + 1, count: photos.length });

  async function removePhoto(photo: ProjectJournalMediaDelivery) {
    if (deletingId || !window.confirm(t(photo.mediaType === "video" ? "deleteVideoConfirm" : "deletePhotoConfirm"))) return;
    setDeletingId(photo.id);
    setDeleteError("");
    const result = await deleteProjectJournalMedia(createClient(), projectId, photo.id);
    setDeletingId(null);
    if (!result.ok) {
      setDeleteError(result.reason === "cleanup-required" ? t("cleanupRequired") : t(photo.mediaType === "video" ? "videoUploadFailed" : "deletePhotoFailed"));
      return;
    }
    router.refresh();
  }

  function openPhoto(index: number, trigger: HTMLButtonElement) {
    returnFocusRef.current = trigger;
    setActiveIndex(index);
  }
  function markUnavailable(id: string) {
    setUnavailableIds((current) => new Set(current).add(id));
  }

  return (
    <div className="mt-4" aria-label={heading ?? t("gallery")}>
      <p className="mb-2 [font-family:var(--font-technical)] text-xs font-semibold text-[var(--color-text-muted)]">
        {heading && <>{heading}<span aria-hidden="true"> · </span></>}{t("mediaCount", { count: photos.length })}
      </p>
      <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,6rem),6rem))] gap-x-2.5 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(min(100%,8rem),8rem))]">
        {photos.map((photo, index) => (
          <div key={photo.id} className="group relative aspect-[4/3] min-w-0 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
            {photo.signedUrl && !unavailableIds.has(photo.id) ? (
              <button
                type="button"
                onClick={(event) => openPhoto(index, event.currentTarget)}
                aria-label={t(photo.mediaType === "video" ? "openVideo" : "openPhoto", { number: index + 1, count: photos.length })}
                className="ui-pressable block h-full w-full overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-forest)]"
              >
                {photo.mediaType === "photo" ? <>
                  {/* Private signed URLs are intentionally rendered directly. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.signedUrl} alt={altText(index)} loading="lazy" onError={() => markUnavailable(photo.id)} className="h-full w-full object-contain" />
                </> : <ProjectVideoThumbnail sourceUrl={photo.signedUrl} durationSeconds={photo.durationSeconds} />}
              </button>
            ) : (
              <div className="flex h-full w-full items-center justify-center p-3 text-center text-xs text-[var(--color-text-muted)]">
                <span>{photo.mediaType === "video" ? <VideoOff aria-hidden="true" className="mx-auto mb-2" size={22} /> : <ImageOff aria-hidden="true" className="mx-auto mb-2" size={22} />}{t(photo.mediaType === "video" ? "videoUnavailable" : "photoUnavailable")}</span>
              </div>
            )}
            {managing && (
              <button type="button" disabled={Boolean(deletingId)} onClick={() => void removePhoto(photo)} aria-label={t(photo.mediaType === "video" ? "deleteVideo" : "deletePhoto")}
                className="ui-pressable absolute right-0 top-0 inline-flex h-11 w-11 items-start justify-end p-1.5 text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white disabled:opacity-60">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-black/70 hover:bg-[var(--color-danger)]">{deletingId === photo.id ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : <Trash2 aria-hidden="true" size={16} />}</span>
              </button>
            )}
          </div>
        ))}
      </div>
      {deleteError && <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{deleteError}</p>}

      <dialog ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("gallery")} onCancel={(event) => { event.preventDefault(); setActiveIndex(null); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setActiveIndex(null); }
          if (event.key === "ArrowLeft" && photos.length > 1) setActiveIndex((current) => current === null ? 0 : (current - 1 + photos.length) % photos.length);
          if (event.key === "ArrowRight" && photos.length > 1) setActiveIndex((current) => current === null ? 0 : (current + 1) % photos.length);
        }}
        className="m-auto h-dvh max-h-none w-screen max-w-none border-0 bg-black/95 p-0 text-white backdrop:bg-black/70">
        {activePhoto && <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] p-3 sm:p-5">
          <div className="flex justify-end"><button type="button" autoFocus onClick={() => setActiveIndex(null)} aria-label={t(activePhoto.mediaType === "video" ? "closeVideo" : "closePhoto")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"><X aria-hidden="true" /></button></div>
          <div className="flex min-h-0 items-center justify-center overflow-hidden p-2">
            {activePhoto.signedUrl && !unavailableIds.has(activePhoto.id) ? activePhoto.mediaType === "video"
              ? <video ref={videoRef} src={activePhoto.signedUrl} controls playsInline preload="metadata" aria-label={t("openVideo", { number: (activeIndex ?? 0) + 1, count: photos.length })} onError={() => markUnavailable(activePhoto.id)} className="max-h-full max-w-full" />
              : <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={activePhoto.signedUrl} alt={altText(activeIndex ?? 0)} onError={() => markUnavailable(activePhoto.id)} className="max-h-full max-w-full object-contain" />
              </>
              : <div className="text-center text-white/75">{activePhoto.mediaType === "video" ? <VideoOff aria-hidden="true" className="mx-auto mb-3" /> : <ImageOff aria-hidden="true" className="mx-auto mb-3" />}{t(activePhoto.mediaType === "video" ? "videoUnavailable" : "photoUnavailable")}</div>}
          </div>
          <div className="flex items-center justify-between gap-3 pb-[env(safe-area-inset-bottom)]">
            <button type="button" disabled={photos.length < 2} onClick={() => setActiveIndex((current) => current === null ? 0 : (current - 1 + photos.length) % photos.length)} aria-label={t("previousPhoto")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/10 disabled:invisible"><ChevronLeft aria-hidden="true" /></button>
            <p className="text-sm tabular-nums">{t("photoPosition", { number: (activeIndex ?? 0) + 1, count: photos.length })}</p>
            <button type="button" disabled={photos.length < 2} onClick={() => setActiveIndex((current) => current === null ? 0 : (current + 1) % photos.length)} aria-label={t("nextPhoto")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/10 disabled:invisible"><ChevronRight aria-hidden="true" /></button>
          </div>
        </div>}
      </dialog>
    </div>
  );
}
