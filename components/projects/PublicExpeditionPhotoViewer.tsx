"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, ImageOff, Maximize2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

const PhotoViewerContext = createContext<{
  slug: string;
  indexByHandle: Map<string, number>;
  openPhoto: (index: number, trigger: HTMLButtonElement) => void;
} | null>(null);

const controlClass = "ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]";

function photoUrl(slug: string, handle: string, variant: "thumb" | "display") {
  return `/api/public-expeditions/${encodeURIComponent(slug)}/media/${encodeURIComponent(handle)}?variant=${variant}`;
}

export function PublicExpeditionPhotoThumbnail({ handle }: { handle: string }) {
  const t = useTranslations("Projects.Media");
  const viewer = useContext(PhotoViewerContext);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const unavailableId = useId();
  const index = viewer?.indexByHandle.get(handle);
  if (!viewer || index === undefined) return null;

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={t("openPhoto", { number: index + 1, count: viewer.indexByHandle.size })}
      aria-describedby={status === "unavailable" ? unavailableId : undefined}
      onClick={(event) => viewer.openPhoto(index, event.currentTarget)}
      className="relative flex aspect-[4/3] min-w-0 cursor-pointer items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-muted)] focus-visible:outline-offset-2"
    >
      {status === "loading" && (
        <span aria-hidden="true" className="absolute inset-0 bg-[var(--color-border)] motion-safe:animate-pulse" />
      )}
      {status === "unavailable" ? (
        <>
          <ImageOff aria-hidden="true" className="text-[var(--color-text-muted)]" />
          <span id={unavailableId} className="sr-only">{t("thumbnailUnavailable")}</span>
        </>
      ) : (
        <Image unoptimized fill loading="lazy" sizes="(max-width: 640px) 33vw, 180px"
          src={photoUrl(viewer.slug, handle, "thumb")} alt="" onLoad={() => setStatus("ready")}
          onError={() => setStatus("unavailable")} className="object-contain" />
      )}
      <span className="absolute bottom-1 right-1 rounded-[var(--radius-control)] bg-[var(--color-surface-overlay)] p-1.5">
        <Maximize2 aria-hidden="true" size={15} />
      </span>
    </button>
  );
}

function DisplayPhoto({ src, alt }: { src: string; alt: string }) {
  const t = useTranslations("Projects.Sharing");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  return (
    <div className="relative grid min-h-0 place-items-center overflow-hidden bg-[var(--color-surface-muted)] p-4 text-center">
      {status === "loading" && <p role="status">{t("photoLoading")}</p>}
      {status === "error" ? (
        <div role="alert" className="text-[var(--color-text-secondary)]">
          <ImageOff aria-hidden="true" className="mx-auto mb-2" />
          <p>{t("photoLoadError")}</p>
        </div>
      ) : (
        <Image unoptimized fill loading="eager" sizes="(max-width: 640px) 100vw, 1024px" src={src} alt={alt}
          onLoad={() => setStatus("ready")} onError={() => setStatus("error")}
          className={status === "ready" ? "object-contain" : "invisible object-contain"} />
      )}
    </div>
  );
}

export default function PublicExpeditionPhotoViewer({ slug, handles, children }: { slug: string; handles: string[]; children: ReactNode }) {
  const t = useTranslations("Projects.Media");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isOpen = activeIndex !== null;

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isOpen]);

  const openPhoto = useCallback((index: number, trigger: HTMLButtonElement) => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    openerRef.current = trigger;
    setActiveIndex(index);
    dialog.showModal();
    closeButtonRef.current?.focus();
  }, []);

  const viewer = useMemo(() => ({
    slug,
    indexByHandle: new Map(handles.map((handle, index) => [handle, index])),
    openPhoto,
  }), [slug, handles, openPhoto]);

  function closePhoto() {
    dialogRef.current?.close();
    setActiveIndex(null);
    openerRef.current?.focus({ preventScroll: true });
    openerRef.current = null;
  }

  function movePhoto(offset: number) {
    setActiveIndex((index) => index === null ? null : (index + offset + handles.length) % handles.length);
  }

  if (handles.length === 0) return children;
  const activeHandle = activeIndex === null ? null : handles[activeIndex];
  const position = { number: (activeIndex ?? 0) + 1, count: handles.length };

  return (
    <PhotoViewerContext.Provider value={viewer}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(event) => { event.preventDefault(); closePhoto(); }}
        onKeyDown={(event) => {
          if (handles.length < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          movePhoto(event.key === "ArrowLeft" ? -1 : 1);
        }}
        className="m-auto h-dvh max-h-none w-screen max-w-none overflow-hidden bg-[var(--color-surface)] p-0 text-[var(--color-text)] backdrop:bg-black/70 sm:h-[min(88dvh,52rem)] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:rounded-[var(--radius-card)] sm:shadow-[var(--shadow-card)]"
      >
        <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <h2 id={titleId} className="text-sm font-bold sm:text-base">{t("gallery")}</h2>
            <button ref={closeButtonRef} type="button" onClick={closePhoto} aria-label={t("closePhoto")} className={controlClass}>
              <X aria-hidden="true" size={20} />
            </button>
          </div>
          {activeHandle && <DisplayPhoto key={activeHandle} src={photoUrl(slug, activeHandle, "display")} alt={t("photoAlt", position)} />}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-[var(--color-border)] px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {handles.length > 1 && <button type="button" onClick={() => movePhoto(-1)} aria-label={t("previousPhoto")} className={`${controlClass} justify-self-start`}>
              <ChevronLeft aria-hidden="true" size={20} />
            </button>}
            <p aria-live="polite" className="col-start-2 text-sm tabular-nums">{t("photoPosition", position)}</p>
            {handles.length > 1 && <button type="button" onClick={() => movePhoto(1)} aria-label={t("nextPhoto")} className={`${controlClass} justify-self-end`}>
              <ChevronRight aria-hidden="true" size={20} />
            </button>}
          </div>
        </div>
      </dialog>
    </PhotoViewerContext.Provider>
  );
}
