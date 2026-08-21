import { ArrowRight, CalendarDays, MapPinned, Mountain, NotebookPen, Plus } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { requireProjectUser } from "@/Lib/projects/auth";
import { listUserProjects } from "@/Lib/projects/queries";
import { listIncomingProjectInvitations, listSharedProjects } from "@/Lib/projects/collaboration";
import type { Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import ProjectInvitations from "@/components/projects/ProjectInvitations";
import SharedProjects from "@/components/projects/SharedProjects";

export default async function ProjectsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  const { supabase, user } = await requireProjectUser(locale, "/projects");
  const [t, format, projects, invitations, sharedProjects] = await Promise.all([
    getTranslations({ locale, namespace: "Projects" }),
    getFormatter({ locale }),
    listUserProjects(supabase, user.id),
    listIncomingProjectInvitations(supabase),
    listSharedProjects(supabase),
  ]);
  const lifecycleOrder = { active: 0, ready: 0, planning: 1, completed: 2, archived: 3 } as const;
  const orderedProjects = [...projects].sort((a, b) => lifecycleOrder[a.status] - lifecycleOrder[b.status]);

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-9">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-5 border-b border-[var(--color-border-strong)] pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.12em] text-[var(--color-forest)]">
              {t("List.eyebrow")}
            </p>
            <h1 className="mt-2 text-4xl font-bold text-[var(--color-text)] sm:text-5xl">
              {t("List.title")}
            </h1>
            <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
              {t("List.description")}
            </p>
          </div>
          <Link href="/projects/new" className="ui-pressable inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]">
            <Plus aria-hidden="true" size={18} />
            {t("List.create")}
          </Link>
        </header>

        <ProjectInvitations invitations={invitations} />
        <SharedProjects projects={sharedProjects} />

        <h2 className="mt-8 text-2xl font-bold text-[var(--color-text)]">{t("Team.myExpeditions")}</h2>
        {projects.length === 0 ? (
          <section className="py-16 text-center" aria-labelledby="projects-empty-title">
            <MapPinned aria-hidden="true" className="mx-auto h-11 w-11 text-[var(--color-forest)]" />
            <h2 id="projects-empty-title" className="mt-5 text-2xl font-bold text-[var(--color-text)]">
              {t("List.emptyTitle")}
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-[var(--color-text-muted)]">
              {t("List.emptyDescription")}
            </p>
            <Link href="/projects/new" className="ui-pressable mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-forest)] px-5 font-bold text-[var(--color-forest)] hover:bg-[var(--color-surface-muted)]">
              <Plus aria-hidden="true" size={18} />
              {t("List.createFirst")}
            </Link>
          </section>
        ) : (
          <section className="mt-7 grid gap-4 lg:grid-cols-2" aria-label={t("Accessibility.projectList")}>
            {orderedProjects.map((project) => {
              const mountainNames = project.mountains
                .slice(0, 3)
                .map((mountain) => mountain.nameDe ?? mountain.name ?? t("Common.unnamedMountain"));
              return (
                <article key={project.id} data-lifecycle-group={project.status === "active" || project.status === "ready" ? "active" : project.status} className={`flex min-w-0 flex-col border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)] sm:p-6 ${project.status === "archived" ? "opacity-75" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                        {t("List.projectLabel")}
                      </p>
                      <h2 className="mt-1 break-words text-2xl font-bold text-[var(--color-text)]">
                        {project.name}
                      </h2>
                    </div>
                    <span className="rounded-[var(--radius-pill)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-bold text-[var(--color-text-secondary)]">
                      {t(`Status.${project.status}`)}
                    </span>
                  </div>

                  <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                    {project.startDate && project.endDate
                      ? t("Common.dateRange", {
                          start: format.dateTime(new Date(`${project.startDate}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                          end: format.dateTime(new Date(`${project.endDate}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                        })
                      : t("Common.datesOpen")}
                  </p>

                  <dl className="mt-5 grid grid-cols-3 border-y border-[var(--color-border-soft)] py-4">
                    <ProjectMetric icon={Mountain} label={t("Common.mountains")} value={project.mountains.length} />
                    <ProjectMetric icon={CalendarDays} label={t("Common.days")} value={project.dayCount} />
                    <ProjectMetric icon={NotebookPen} label={t("Common.journal")} value={project.journalEntryCount} />
                  </dl>

                  <p className="mt-4 min-h-6 text-sm text-[var(--color-text-secondary)]">
                    {mountainNames.length > 0
                      ? mountainNames.join(" · ")
                      : t("List.noMountains")}
                  </p>

                  <div className="mt-auto flex items-center justify-between gap-4 pt-5">
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {t("List.updated", { date: format.dateTime(new Date(project.updatedAt), { dateStyle: "medium" }) })}
                    </p>
                    <Link href={`/projects/${project.id}`} className="ui-pressable inline-flex min-h-11 items-center gap-2 font-bold text-[var(--color-forest)] hover:text-[var(--color-forest-hover)] hover:underline">
                      {t("List.open")}
                      <ArrowRight aria-hidden="true" size={17} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}

function ProjectMetric({ icon: Icon, label, value }: { icon: typeof Mountain; label: string; value: number }) {
  return (
    <div className="border-l border-[var(--color-border-soft)] px-3 first:border-l-0 first:pl-0 last:pr-0">
      <dt className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
        <Icon aria-hidden="true" size={14} /> {label}
      </dt>
      <dd className="mt-1 [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-text)]">{value}</dd>
    </div>
  );
}
