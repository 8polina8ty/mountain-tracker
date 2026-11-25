"use client";
import { useState } from "react";
import { Share2 } from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { createSocialAchievementPost } from "@/Lib/socialFeed/mutations";
import ShareToProfileDialog from "./ShareToProfileDialog";

export default function AchievementShareButton({ achievementId, icon }: { achievementId: string; icon: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function handleShare(body: string, visibility: string){
    setBusy(true);
    const supabase=createClient();
    await createSocialAchievementPost(supabase, achievementId, body, visibility);
    setBusy(false); setOpen(false);
  }
  return (
    <>
      <button onClick={()=>setOpen(true)} aria-label="Share achievement to profile" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold"><Share2 size={14} />Share to profile</button>
      {open && <ShareToProfileDialog title="Share achievement to profile" preview={<div>{icon} {achievementId}</div>} onShare={handleShare} onClose={()=>setOpen(false)} busy={busy} />}
    </>
  );
}
