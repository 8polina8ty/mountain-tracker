"use client";

import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";

export default function StartConversationButton({ userId }: { userId: string }) {
  const t = useTranslations("Social.Messages"); const router = useRouter(); const [busy,setBusy]=useState(false); const [error,setError]=useState(false);
  async function start(){setBusy(true);setError(false);const result=await createClient().rpc("get_or_create_direct_conversation",{requested_user_id:userId});setBusy(false);if(result.error||typeof result.data!=="string"){setError(true);return;}router.push(`/messages/${result.data}`);}
  return <span className="inline-flex flex-col"><button type="button" disabled={busy} onClick={start} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 text-sm font-semibold disabled:opacity-60"><MessageCircle aria-hidden="true" className="h-4 w-4"/>{busy?t("opening"):t("message")}</button>{error&&<span role="alert" className="mt-1 text-xs text-[var(--color-danger)]">{t("openError")}</span>}</span>;
}
