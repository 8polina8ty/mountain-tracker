"use client";
import { useState } from "react";
import { Share2 } from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { createSocialExpeditionPost } from "@/Lib/socialFeed/mutations";
import ShareToProfileDialog from "./ShareToProfileDialog";

export default function ExpeditionShareButton({ projectId, projectName, enabled, hasEvidence }: { projectId: string; projectName: string; enabled: boolean; hasEvidence: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canShare = enabled && hasEvidence;
  async function handleShare(body: string, visibility: string){
    setBusy(true);
    const supabase=createClient();
    await createSocialExpeditionPost(supabase, projectId, body, visibility);
    setBusy(false); setOpen(false);
  }
  if (!canShare) return <div className="rounded-xl border p-3 text-sm text-[var(--color-text-muted)]">Enable public sharing first</div>;
  return (
    <>
      <button onClick={()=>setOpen(true)} aria-label="Share expedition to profile" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold"><Share2 size={14} />Share to profile</button>
      {open && <ShareToProfileDialog title="Share expedition to profile" preview={<div>{projectName}</div>} onShare={handleShare} onClose={()=>setOpen(false)} busy={busy} />}
    </>
  );
}
