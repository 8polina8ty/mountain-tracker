"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { leaveProject, type SharedProjectSummary } from "@/Lib/projects/collaboration";
import { createClient } from "@/Lib/supabase/client";
import { Link, useRouter } from "@/i18n/navigation";

export default function SharedProjects({ projects }: { projects: SharedProjectSummary[] }) {
  const t = useTranslations("Projects.Team"); const shared = useTranslations("Projects.TeamShared"); const status = useTranslations("Projects.Status"); const router = useRouter(); const [busy, setBusy] = useState(""); const [message, setMessage] = useState("");
  if (projects.length === 0) return null;
  async function leave(project: SharedProjectSummary) { if (busy || !window.confirm(shared("leaveProjectConfirm", { name: project.projectName }))) return; setBusy(project.projectId); const result = await leaveProject(createClient(), project.projectId); setBusy(""); setMessage(result.ok ? shared("projectLeft") : t("invitationFailed")); if (result.ok) router.refresh(); }
  return <section className="mt-8" aria-labelledby="shared-projects-title"><h2 id="shared-projects-title" className="text-2xl font-bold">{t("sharedWithMe")}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">{shared("description")}</p><div className="mt-4 grid gap-4 lg:grid-cols-2">{projects.map((project) => <article key={project.projectId} className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-control)]"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-xl font-bold">{project.projectName}</h3><p className="mt-1 text-sm text-[var(--color-text-muted)]">{shared("ownedBy", { name: project.owner.displayName ?? project.owner.username })}</p></div><span className="rounded-full bg-[var(--color-forest-soft)] px-3 py-1 text-xs font-bold text-[var(--color-forest)]">{t(project.role)}</span></div><p className="mt-3 text-sm text-[var(--color-text-secondary)]">{status(project.projectStatus)}{project.startDate && project.endDate ? ` · ${project.startDate} – ${project.endDate}` : ""}</p><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><Link href={`/projects/${project.projectId}`} className="ui-pressable inline-flex min-h-11 items-center font-bold text-[var(--color-forest)]">{shared("openProject")}</Link><button type="button" disabled={Boolean(busy)} onClick={() => void leave(project)} className="ui-pressable min-h-11 font-bold text-[var(--color-danger)]">{shared("leaveProject")}</button></div></article>)}</div><p aria-live="polite" className="mt-3 text-sm text-[var(--color-text-muted)]">{message}</p></section>;
}
