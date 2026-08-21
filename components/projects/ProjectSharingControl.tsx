"use client";

import { useState } from "react";
import { Copy, ExternalLink, Globe2, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { disableProjectSharing, enableProjectSharing, type ProjectShareState } from "@/Lib/projects/sharing";
import { createClient } from "@/Lib/supabase/client";
import { Link, useRouter } from "@/i18n/navigation";

export default function ProjectSharingControl({ projectId, eligible, initialShare }: { projectId: string; eligible: boolean; initialShare: ProjectShareState }) {
  const t = useTranslations("Projects.Sharing"); const router = useRouter();
  const [share, setShare] = useState(initialShare); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  if (!eligible) return null;
  async function enable() { if (busy || !window.confirm(t("shareWarning"))) return; setBusy(true); const result = await enableProjectSharing(createClient(), projectId); setBusy(false); if (!result.ok) { setMessage(t("sharingFailed")); return; } setShare({ slug: result.slug, enabled: true }); setMessage(t("sharingEnabled")); router.refresh(); }
  async function disable() { if (busy || !window.confirm(t("disableSharingConfirm"))) return; setBusy(true); const result = await disableProjectSharing(createClient(), projectId); setBusy(false); if (!result.ok) { setMessage(t("sharingFailed")); return; } setShare(share ? { ...share, enabled: false } : null); setMessage(t("sharingDisabled")); router.refresh(); }
  const path = share ? `/expeditions/${share.slug}` : "";
  return <section className="mt-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-4" aria-labelledby="public-sharing-title"><h2 id="public-sharing-title" className="flex items-center gap-2 font-bold"><Globe2 aria-hidden="true" size={18}/>{t("publicSharing")}</h2>{share?.enabled?<div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => { void navigator.clipboard.writeText(new URL(path, window.location.origin).toString()); setMessage(t("linkCopied")); }} className="ui-pressable inline-flex min-h-11 items-center gap-2 border px-3 font-bold"><Copy aria-hidden="true" size={16}/>{t("copyLink")}</button><Link href={path} target="_blank" className="ui-pressable inline-flex min-h-11 items-center gap-2 border px-3 font-bold"><ExternalLink aria-hidden="true" size={16}/>{t("openPublicPage")}</Link><button type="button" disabled={busy} onClick={() => void disable()} className="ui-pressable min-h-11 px-3 font-bold text-[var(--color-danger)]">{t("disableSharing")}</button></div>:<button type="button" disabled={busy} onClick={() => void enable()} className="ui-pressable mt-3 inline-flex min-h-11 items-center gap-2 bg-[var(--color-forest)] px-4 font-bold text-white">{busy&&<LoaderCircle aria-hidden="true" className="animate-spin" size={16}/>} {t("enableSharing")}</button>}<p aria-live="polite" className="mt-2 text-sm text-[var(--color-text-muted)]">{message}</p></section>;
}
