"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Image as ImageIcon, X } from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { createSocialPost, updateSocialPost, buildSocialPostMediaPath, extForMime } from "@/Lib/socialFeed/mutations";
import type { SocialPostMedia } from "@/Lib/socialFeed/types";

import { uploadSocialMedia } from "@/Lib/socialFeed/media";

export default function PostComposer({ onCreated }: { onCreated?: () => void }) {
  const t = useTranslations("Social.Feed");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"public"|"friends"|"private">("public");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { previews.forEach(url => URL.revokeObjectURL(url)); }, [previews]);

  function onFilesSelected(list: FileList | null){
    if(!list) return;
    const next=[...files];
    for(const f of Array.from(list)){
      if(!["image/jpeg","image/png","image/webp"].includes(f.type)){ setError(t("unsupportedPhoto")); continue; }
      if(f.size<1 || f.size>10*1024*1024){ setError(t("photoTooLarge")); continue; }
      if(next.length>=10){ setError(t("photoLimit")); break; }
      next.push(f);
    }
    setFiles(next);
    setPreviews(next.map(f=>URL.createObjectURL(f)));
  }
  function removeAt(i:number){ const n=[...files]; n.splice(i,1); setFiles(n); setPreviews(n.map(f=>URL.createObjectURL(f))); }

  const canPost = (body.trim().length>0 || files.length>0) && body.length<=5000 && !busy;

  async function submit(){
    if(!canPost) return;
    setBusy(true); setError("");
    const supabase=createClient();
    let draftId: string | null = null;
    const uploaded: SocialPostMedia[] = [];
    try{
      const { data: { user } } = await supabase.auth.getUser();
      if(!user) throw new Error("Auth");
      const postType = files.length>0 ? "photo" : "note";
      const postId = await createSocialPost(supabase, body.trim(), "private", postType) as string;
      draftId = postId;
      // upload media
      for(let i=0;i<files.length;i++){
        const f=files[i];
        uploaded.push(await uploadSocialMedia(supabase, user.id, postId, f, i));
      }
      await updateSocialPost(supabase, postId, body.trim(), visibility);
      setBody(""); setFiles([]); setPreviews([]); onCreated?.();
    }catch{
      if (draftId) {
        await supabase.rpc("delete_social_post", { requested_post_id: draftId });
        const paths = uploaded.flatMap(m => { const ext = extForMime(m.mimeType); return ext ? [buildSocialPostMediaPath(m.authorId, m.postId, m.id, ext)] : []; });
        if (paths.length) await supabase.storage.from("social-post-media").remove(paths);
      }
      setError(t("postFailed"));
    }
    setBusy(false);
  }

  return (
    <section className="rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
      <div className="flex gap-3">
        <div className="h-10 w-10 shrink-0 rounded-full bg-[var(--color-surface-muted)]" />
        <textarea value={body} onChange={(e)=>setBody(e.target.value)} maxLength={5000} placeholder={t("postPlaceholder")} aria-label={t("createPost")} disabled={busy} className="min-h-[80px] min-w-0 flex-1 resize-none rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-sm outline-none focus:border-[var(--color-forest)] focus:ring-2 focus:ring-[var(--color-focus-halo)]" />
      </div>
      <div className="mt-2 text-right text-xs text-[var(--color-text-muted)]">{body.length} / 5000</div>
      {previews.length>0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {previews.map((src,i)=>(
            <div key={i} className="relative aspect-square overflow-hidden rounded-xl border">
              <Image src={src} alt={t("preview")} fill unoptimized className="object-cover" />
              <button disabled={busy} onClick={()=>removeAt(i)} aria-label={t("removePhoto")} className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white"><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <label className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold">
          <ImageIcon size={16} />{t("addPhotos")}
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} className="sr-only" onChange={(e)=>onFilesSelected(e.target.files)} />
        </label>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold">{t("visibility")}</label>
          <select value={visibility} disabled={busy} onChange={(e)=>setVisibility(e.target.value as never)} aria-label={t("visibility")} className="ui-field min-h-11 px-3 py-2 text-sm">
            <option value="public">{t("public")}</option>
            <option value="friends">{t("friends")}</option>
            <option value="private">{t("private")}</option>
          </select>
          <button onClick={submit} disabled={!canPost} className="ui-pressable min-h-11 rounded-full bg-[var(--color-forest)] px-6 py-2.5 text-sm font-bold text-white disabled:opacity-50">{busy ? t("publishing") : t("publish")}</button>
        </div>
      </div>
    </section>
  );
}
