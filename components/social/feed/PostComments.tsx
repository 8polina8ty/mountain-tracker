"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { createClient } from "@/Lib/supabase/client";
import { addComment, removeComment } from "@/Lib/socialFeed/mutations";
import { normalizeSocialComment } from "@/Lib/socialFeed/normalize";
import type { SocialComment } from "@/Lib/socialFeed/types";

export default function PostComments({ postId, currentUserId, postAuthorId }: { postId: string; currentUserId: string | null; postAuthorId: string }) {
  const t = useTranslations("Social.Feed");
  const [error, setError] = useState(false);
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload(){
    const supabase=createClient();
    const { data } = await supabase.rpc("list_social_post_comments",{requested_post_id:postId, result_limit:5});
    if(Array.isArray(data)){
      const normalized = (data as unknown[]).map(normalizeSocialComment).filter((c): c is SocialComment => c !== null);
      setComments(normalized);
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- initial comments load after mount
  useEffect(()=>{ void reload(); },[postId]);
  async function submit(){ if(!currentUserId || !body.trim() || busy) return; if(body.trim().length>2000) return; setBusy(true); setError(false); const supabase=createClient(); try{ await addComment(supabase,postId,body.trim()); await reload(); setBody(""); }catch{setError(true);} setBusy(false); }
  async function del(id:string){ if(!confirm(t("deleteComment"))) return; const supabase=createClient(); try{ await removeComment(supabase,id); setComments((c)=>c.filter(x=>x.id!==id)); }catch{setError(true);} }
  return (
    <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4">
      <div className="space-y-3">
        {comments.map((c)=>{
          if (!c.author) return null;
          return (
          <div key={c.id} className="flex gap-2">
            <div className="flex-1 rounded-[12px] bg-[var(--color-surface-muted)] px-3 py-2">
              <Link className="inline-flex min-h-11 items-center text-xs font-bold" href={`/users/${c.author.userId}`}>{c.author.username}</Link>
              <p className="text-sm">{c.body}</p>
            </div>
            {(c.author.userId===currentUserId || postAuthorId===currentUserId) && <button onClick={()=>del(c.id)} aria-label={t("deleteComment")} className="ui-pressable min-h-11 px-2 text-xs">{t("delete")}</button>}
          </div>
        );})}
      </div>
      {error && <p role="alert" className="text-[var(--color-danger)]">{t("commentFailed")}</p>}
      {currentUserId && (
        <div className="mt-3 flex gap-2">
          <input value={body} onChange={(e)=>setBody(e.target.value)} maxLength={2000} placeholder={t("writeComment")} className="ui-field min-h-11 min-w-0 flex-1 px-3 py-2 text-sm" aria-label={t("writeComment")} />
          <button onClick={submit} disabled={!body.trim() || busy} className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-white disabled:opacity-50">{t("comment")}</button>
        </div>
      )}
    </div>
  );
}
