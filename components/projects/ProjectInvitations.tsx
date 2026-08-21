"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { acceptProjectInvitation, declineProjectInvitation, type IncomingProjectInvitation } from "@/Lib/projects/collaboration";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";

export default function ProjectInvitations({ invitations }: { invitations: IncomingProjectInvitation[] }) {
  const t = useTranslations("Projects.Team"); const router = useRouter(); const [busy, setBusy] = useState(""); const [message, setMessage] = useState("");
  async function respond(item: IncomingProjectInvitation, accept: boolean) { if (busy) return; setBusy(item.id); const result = await (accept ? acceptProjectInvitation(createClient(), item.id) : declineProjectInvitation(createClient(), item.id)); setBusy(""); setMessage(result.ok ? t(accept ? "invitationAccepted" : "invitationDeclined") : t("invitationFailed")); if (result.ok) router.refresh(); }
  if (invitations.length === 0) return null;
  return <section className="mt-7 border border-[var(--color-border)] bg-[var(--color-surface)] p-5" aria-labelledby="expedition-invitations-title"><h2 id="expedition-invitations-title" className="flex items-center gap-2 text-2xl font-bold"><Mail aria-hidden="true" size={20}/>{t("expeditionInvitations")}</h2><div className="mt-4 space-y-3">{invitations.map((item) => <article key={item.id} className="flex flex-col gap-3 border-t border-[var(--color-border-soft)] pt-3 first:border-0 first:pt-0 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><h3 className="truncate font-bold">{item.projectName}</h3><p className="text-sm text-[var(--color-text-muted)]">{t("invitedByAs", { name: item.displayName ?? item.username, role: t(item.role) })}</p></div><div className="flex gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => void respond(item, true)} className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-white">{t("acceptInvitation")}</button><button type="button" disabled={Boolean(busy)} onClick={() => void respond(item, false)} className="ui-pressable min-h-11 border border-[var(--color-border)] px-4 font-bold">{t("declineInvitation")}</button></div></article>)}</div><p aria-live="polite" className="mt-3 text-sm text-[var(--color-text-muted)]">{message}</p></section>;
}
