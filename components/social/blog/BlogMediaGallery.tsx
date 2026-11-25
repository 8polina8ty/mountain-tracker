"use client";
import Image from "next/image";
import { useState, useEffect } from "react";
import type { SocialPostMedia } from "@/Lib/socialFeed/types";

type EditorGalleryProps = {
  media: SocialPostMedia[];
  onRemove: (id: string) => void;
  onPreview?: (id: string) => void;
  busy?: boolean;
  published?: boolean;
  pendingCoverFile?: File | null;
  pendingFiles?: File[];
  onRemovePendingFile?: (index: number) => void;
  t: (key: string) => string;
};

function PendingThumb({ file, onRemove, label }: { file: File; onRemove?: () => void; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL lifecycle belongs to effect
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return null;
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-sm">
      <Image src={url} alt={label} width={240} height={160} unoptimized className="h-[96px] w-full object-cover sm:h-[104px]" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="absolute right-1.5 top-1.5 flex gap-1.5">
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={label}
            className="ui-pressable inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-text)]/80 text-white shadow-md backdrop-blur-sm hover:bg-black/90 focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] active:scale-[0.96] active:shadow-sm"
          >
            <span aria-hidden className="text-[14px] leading-none">×</span>
          </button>
        )}
      </div>
      <span className="absolute bottom-1 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white backdrop-blur-sm">NEW</span>
    </div>
  );
}

export function BlogEditorGallery({ media, onRemove, onPreview, busy, published, pendingCoverFile, pendingFiles = [], onRemovePendingFile, t }: EditorGalleryProps) {
  const cover = media.find((m) => m.position === 0) ?? null;
  const thumbs = media.filter((m) => m.position !== 0).sort((a, b) => a.position - b.position);
  const hasMedia = media.length > 0 || pendingCoverFile || pendingFiles.length > 0;

  if (!hasMedia) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 text-center text-sm text-[var(--color-text-muted)]">
        {t("emptyGallery")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Cover */}
      {(cover || pendingCoverFile) && (
        <div className="relative overflow-hidden rounded-[18px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-sm">
          {pendingCoverFile ? (
            <PendingCover file={pendingCoverFile} t={t} />
          ) : cover ? (
            <Image
              src={`/api/social/posts/${cover.postId}/media/${cover.id}`}
              alt={t("cover")}
              width={800}
              height={400}
              unoptimized
              className="h-[200px] w-full object-cover sm:h-[260px]"
            />
          ) : null}
          <div className="pointer-events-none absolute inset-0 ring-1 ring-black/5 rounded-[18px]" />
          <span className="absolute left-3 top-3 rounded-full bg-[var(--color-forest)] px-3 py-1 text-xs font-bold tracking-wide text-white shadow-md">
            {t("coverBadge")}
          </span>
          <div className="absolute right-3 top-3 flex gap-2">
            {cover && onPreview && (
              <button
                type="button"
                onClick={() => onPreview(cover.id)}
                aria-label={t("preview")}
                className="ui-pressable inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-surface-overlay)] text-[var(--color-text)] shadow-md ring-1 ring-black/5 backdrop-blur-md hover:bg-white active:scale-[0.96] active:shadow-sm disabled:opacity-50"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            )}
            {cover && (
              <button
                type="button"
                disabled={Boolean(published) || busy}
                onClick={() => onRemove(cover.id)}
                aria-label={t("remove")}
                className="ui-pressable inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-danger)] text-white shadow-md hover:bg-[#b94a42] active:scale-[0.96] active:bg-[#a8433c] active:shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                  <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Thumbnails */}
      {(thumbs.length > 0 || pendingFiles.length > 0) && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3">
          {thumbs.map((m) => (
            <div
              key={m.id}
              className="group relative overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-sm transition-shadow hover:shadow-md"
            >
              <Image
                src={`/api/social/posts/${m.postId}/media/${m.id}`}
                alt={t("photos")}
                width={240}
                height={160}
                unoptimized
                className="h-[96px] w-full object-cover sm:h-[108px]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="absolute right-1.5 top-1.5 flex gap-1">
                {onPreview && (
                  <button
                    type="button"
                    onClick={() => onPreview(m.id)}
                    className="ui-pressable hidden h-7 w-7 items-center justify-center rounded-full bg-white/90 text-[var(--color-text)] shadow-sm backdrop-blur-sm hover:bg-white group-hover:inline-flex active:scale-95 sm:inline-flex"
                    aria-label={t("preview")}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemove(m.id)}
                  className="ui-pressable inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-danger)] text-white shadow-sm hover:bg-[#b94a42] active:scale-95 active:bg-[#a8433c] disabled:opacity-40"
                  aria-label={t("remove")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
          {pendingFiles.map((file, idx) => (
            <PendingThumb key={`${file.name}-${idx}`} file={file} label={t("photos")} onRemove={onRemovePendingFile ? () => onRemovePendingFile(idx) : undefined} />
          ))}
        </div>
      )}

      {/* Pending cover extra when cover exists and pendingCoverFile shown – already handled */}
    </div>
  );
}

function PendingCover({ file, t }: { file: File; t: (k: string) => string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL lifecycle belongs to effect
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return <div className="h-[200px] sm:h-[260px] bg-[var(--color-surface-muted)]" />;
  return (
    <Image src={url} alt={t("cover")} width={800} height={400} unoptimized className="h-[200px] w-full object-cover sm:h-[260px]" />
  );
}

// Public article gallery – compact editorial hero + grid
export function BlogArticleGallery({ media, postId, title, t }: { media: SocialPostMedia[]; postId: string; title: string | null; t: (k: string) => string }) {
  const cover = media.find((m) => m.position === 0) ?? null;
  const rest = media.filter((m) => m.position !== 0).sort((a, b) => a.position - b.position);
  if (!media.length) return null;
  return (
    <div className="space-y-4">
      {cover && (
        <figure className="overflow-hidden rounded-[18px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-sm">
          <div className="relative">
            <Image
              src={`/api/social/posts/${postId}/media/${cover.id}`}
              alt={title ?? t("cover")}
              width={1000}
              height={560}
              unoptimized
              className="h-[220px] w-full object-cover sm:h-[360px] lg:h-[380px]"
            />
            <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold tracking-wide text-white backdrop-blur-md">{t("coverBadge")}</span>
          </div>
        </figure>
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {rest.map((m) => (
            <figure key={m.id} className="overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-sm">
              <Image
                src={`/api/social/posts/${postId}/media/${m.id}`}
                alt={t("photos")}
                width={400}
                height={300}
                unoptimized
                className="aspect-[4/3] w-full object-cover"
              />
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
