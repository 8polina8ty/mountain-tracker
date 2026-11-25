"use client";
import { useEffect, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";
import { uploadSocialMedia, removeSocialMedia } from "@/Lib/socialFeed/media";
import type { SocialPost } from "@/Lib/socialFeed/types";
import { BlogEditorGallery } from "./BlogMediaGallery";
import Image from "next/image";

export default function BlogEditor({ initial, currentUserId }: { initial?: SocialPost; currentUserId: string }) {
  const t = useTranslations("Social.Blog");
  const router = useRouter();
  const [postId, setPostId] = useState(initial?.id ?? null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [mountain, setMountain] = useState(String(initial?.mountainAttachment?.mountainId ?? ""));
  const [expedition, setExpedition] = useState(initial?.expeditionAttachment?.slug ?? "");
  const [media, setMedia] = useState(initial?.media ?? []);
  const [files, setFiles] = useState<File[]>([]);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const photosInputRef = useRef<HTMLInputElement>(null);
  const published = Boolean(initial?.publishedAt);

  function choose(list: FileList | null) {
    const selected = [...files, ...Array.from(list ?? [])];
    if (selected.length + media.length > 10 || selected.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size < 1 || f.size > 10 * 1024 * 1024)) { setError(t("photoError")); return; }
    setFiles(selected); setError("");
  }
  function chooseCover(file: File | null) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) { setError(t("photoError")); return; }
    setCoverFile(file); setError("");
  }
  async function save(publish: boolean) {
    if (busy) return;
    if (!title.trim() || [...title.trim()].length > 160 || !body.trim() || [...body.trim()].length > 20000 || (mountain && (!Number.isSafeInteger(Number(mountain)) || Number(mountain) <= 0))) { setError(t("validation")); return; }
    if (publish && !media.some(m => m.position === 0) && !coverFile) { setError(t("coverRequired")); return; }
    setBusy(true); setError(""); setSaved(false);
    const supabase = createClient();
    const args = { requested_title: title.trim(), requested_body: body.trim(), requested_mountain_id: mountain ? Number(mountain) : null, requested_expedition_slug: expedition.trim() || null };
    try {
      let id = postId;
      if (!id) {
        const { data, error } = await supabase.rpc("save_social_blog", { ...args, requested_post_id: null, publish: false });
        if (error || typeof data !== "string") throw error ?? new Error("Draft unavailable");
        id = data; setPostId(id);
      }
      let uploaded = [...media];
      if (coverFile) {
        const previousCover = uploaded.find(m => m.position === 0);
        const next = await uploadSocialMedia(supabase, currentUserId, id, coverFile, 0);
        if (previousCover) {
          uploaded = uploaded.filter(m => m.id !== previousCover.id);
          const { buildSocialPostMediaPath, extForMime } = await import("@/Lib/socialFeed/mutations");
          const ext = extForMime(previousCover.mimeType);
          if (ext) await supabase.storage.from("social-post-media").remove([buildSocialPostMediaPath(currentUserId, id, previousCover.id, ext)]);
        }
        uploaded = [...uploaded, next]; setMedia([...uploaded].sort((a, b) => a.position - b.position)); setCoverFile(null);
      }
      for (let i = 0; i < files.length; i++) {
        const position = Array.from({ length: 10 }, (_, n) => n).find(n => !uploaded.some(m => m.position === n));
        if (position === undefined) throw new Error("Photo limit");
        const next = await uploadSocialMedia(supabase, currentUserId, id, files[i], position);
        uploaded = [...uploaded, next]; setMedia([...uploaded].sort((a, b) => a.position - b.position)); setFiles(files.slice(i + 1));
      }
      const { error } = await supabase.rpc("save_social_blog", { ...args, requested_post_id: id, publish });
      if (error) throw error;
      if (publish || published) { router.push(`/community/blog/${id}`); router.refresh(); }
      else setSaved(true);
    } catch { setError(t("saveError")); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    const item = media.find(m => m.id === id);
    if (!item || busy) return;
    setBusy(true); setError("");
    try { await removeSocialMedia(createClient(), item); setMedia(prev => prev.filter(m => m.id !== id)); }
    catch { setError(t("saveError")); }
    finally { setBusy(false); }
  }
  async function deleteArticle() {
    if (!postId || busy || !window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_social_post", { requested_post_id: postId });
      if (error) throw error;
      const { buildSocialPostMediaPath, extForMime } = await import("@/Lib/socialFeed/mutations");
      const paths = media.flatMap(m => { const ext = extForMime(m.mimeType); return ext ? [buildSocialPostMediaPath(currentUserId, postId, m.id, ext)] : []; });
      if (paths.length) await supabase.storage.from("social-post-media").remove(paths);
      router.push("/community/blog"); router.refresh();
    } catch { setError(t("saveError")); setBusy(false); }
  }

  return (
    <section className="space-y-6 rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 sm:p-6 shadow-sm">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-[1.7rem]">{initial ? t("edit") : t("write")}</h1>
        <p className="text-sm leading-5 text-[var(--color-text-muted)]">{t("notice")}</p>
      </header>

      <fieldset disabled={busy} className="space-y-5">
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-[var(--color-text-secondary)]">{t("title")}</span>
          <input className="ui-field w-full p-3 text-sm" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} required placeholder="Alpine sunrise over Zugspitze" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-[var(--color-text-secondary)]">{t("body")}</span>
          <textarea className="ui-field min-h-56 w-full p-3 text-sm leading-6" value={body} onChange={e => setBody(e.target.value)} maxLength={20000} required placeholder="Share your story..." />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-[var(--color-text-secondary)]">{t("mountain")}</span>
            <input className="ui-field w-full p-3 text-sm" inputMode="numeric" value={mountain} onChange={e => setMountain(e.target.value)} placeholder="e.g. 12345" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-[var(--color-text-secondary)]">{t("expedition")}</span>
            <input className="ui-field w-full p-3 text-sm" maxLength={128} value={expedition} onChange={e => setExpedition(e.target.value)} placeholder="public slug" />
          </label>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[var(--color-text-secondary)]">{t("coverHint")}</p>
            <span className="rounded-full bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)]">{media.length + files.length + (coverFile ? 1 : 0)}/10</span>
          </div>

          <BlogEditorGallery
            media={media}
            onRemove={remove}
            onPreview={setLightbox}
            busy={busy}
            published={published}
            pendingCoverFile={coverFile}
            pendingFiles={files}
            onRemovePendingFile={idx => setFiles(prev => prev.filter((_, i) => i !== idx))}
            t={(k: string) => t(k as never) as string}
          />

          {/* Subtle pending-cover indicator already in gallery; no raw filenames */}
          <div className="flex flex-wrap gap-2">
            <input ref={coverInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e => { chooseCover(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <button type="button" disabled={busy} onClick={() => coverInputRef.current?.click()} className="ui-pressable inline-flex min-h-10 items-center gap-2 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 text-sm font-semibold text-[var(--color-text)] shadow-sm hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-secondary)] active:translate-y-[1px] active:scale-[0.98] active:shadow-none">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
              {coverFile ? t("cover") + " • " + t("preview") : t("cover")}
            </button>
            <input ref={photosInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={e => { choose(e.target.files); e.target.value = ""; }} />
            <button type="button" disabled={busy} onClick={() => photosInputRef.current?.click()} className="ui-pressable inline-flex min-h-10 items-center gap-2 rounded-[12px] border border-[var(--color-border)] bg-white px-4 text-sm font-semibold text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface-muted)] active:translate-y-[1px] active:scale-[0.98] active:shadow-none">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M4 16l4-4 4 4 6-6 4 4V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8Z" /><circle cx="9" cy="9" r="2" /></svg>
              {t("photos")}
            </button>
            {coverFile && (
              <button type="button" onClick={() => setCoverFile(null)} className="ui-pressable inline-flex min-h-10 items-center rounded-full bg-[var(--color-danger-soft)] px-4 text-sm font-semibold text-[var(--color-danger)] ring-1 ring-[var(--color-danger-border)] hover:bg-[var(--color-danger)] hover:text-white active:scale-[0.98]">
                {t("remove")}
              </button>
            )}
          </div>
        </div>
      </fieldset>

      {preview && (
        <article className="space-y-4 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] p-4">
          <h2 className="break-words text-xl font-bold">{title || t("title")}</h2>
          {coverFile && <LocalPhoto file={coverFile} alt={t("cover")} />}
          <p className="whitespace-pre-wrap break-words text-sm leading-7">{body || "—"}</p>
          {files.map((file, index) => <LocalPhoto key={`${file.name}-${index}`} file={file} alt={t("photos")} />)}
        </article>
      )}

      {error && <p role="alert" className="rounded-xl bg-[var(--color-danger-soft)] px-4 py-3 text-sm font-medium text-[var(--color-danger)] ring-1 ring-[var(--color-danger-border)]">{error}</p>}
      {saved && <p role="status" className="rounded-xl bg-[var(--color-success-soft)] px-4 py-3 text-sm font-medium text-[var(--color-success)] ring-1 ring-[var(--color-success-border)]">{t("saved")}</p>}

      <div className="flex flex-wrap gap-3 border-t border-[var(--color-border-soft)] pt-5">
        <button type="button" className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[14px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-5 text-sm font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] active:translate-y-[1px] active:scale-[0.98] active:shadow-none" aria-pressed={preview} onClick={() => setPreview(v => !v)}>{t("preview")}</button>
        {!published && <button type="button" className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[14px] border border-[var(--color-border)] bg-white px-5 text-sm font-semibold text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface-muted)] active:translate-y-[1px] active:scale-[0.98] disabled:opacity-40" disabled={busy} onClick={() => void save(false)}>{t("saveDraft")}</button>}
        <button type="button" disabled={busy} className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[14px] bg-[var(--color-forest)] px-6 text-sm font-bold text-white shadow-[var(--shadow-control)] hover:bg-[var(--color-forest-hover)] hover:shadow-md active:translate-y-[1px] active:scale-[0.98] active:bg-[var(--color-forest-active)] active:shadow-none disabled:opacity-50" onClick={() => void save(true)}>{busy ? t("saving") : published ? t("save") : t("publish")}</button>
        {postId && <button type="button" disabled={busy} onClick={() => void deleteArticle()} className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[14px] bg-[var(--color-danger)] px-5 text-sm font-bold text-white shadow-sm hover:bg-[#b94a42] active:bg-[#a8433c] active:translate-y-[1px] active:scale-[0.98] disabled:opacity-40">{t("delete")}</button>}
      </div>

      {lightbox && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setLightbox(null)}>
          <div className="relative max-h-[86vh] max-w-[92vw] overflow-hidden rounded-2xl bg-white p-2 shadow-2xl" onClick={e => e.stopPropagation()}>
            <Image src={`/api/social/posts/${media.find(m=>m.id===lightbox)?.postId ?? postId}/media/${lightbox}`} alt={t("preview")} width={1000} height={700} unoptimized className="max-h-[80vh] w-auto rounded-xl object-contain" />
            <button type="button" onClick={() => setLightbox(null)} className="ui-pressable absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-md hover:bg-black active:scale-95">×</button>
          </div>
        </div>
      )}
    </section>
  );
}

function LocalPhoto({ file, alt }: { file: File; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL lifecycle belongs to effect
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <Image src={url} alt={alt} width={720} height={480} unoptimized className="h-auto w-full rounded-2xl border border-[var(--color-border-soft)] object-cover" /> : null;
}
