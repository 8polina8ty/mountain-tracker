"use client";

import { ArrowRight, CalendarDays, Mountain, NotebookPen, Plus } from "lucide-react";
import Image from "next/image";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { MetricRow, PageHero, PrimaryButton, SectionHeading, StatusPill } from "@/components/ui-v2";

type ProjectsClientProps = {
  orderedProjects: Array<{
    id: string;
    name: string;
    status: string;
    coverImageUrl?: string | null;
    mountains: Array<{ nameDe?: string | null; name?: string | null }>;
    dayCount: number;
    journalEntryCount: number;
    startDate: string | null;
    endDate: string | null;
    updatedAt: string;
  }>;
  invitations: Array<unknown>;
  sharedProjects: Array<{
    projectId: string;
    projectName: string;
    projectStatus: string;
    coverImageUrl?: string | null;
    startDate: string | null;
    endDate: string | null;
    updatedAt: string;
  }>;
  statusTone: Record<string, "success" | "warning" | "info" | "neutral" | "danger">;
};

export default function ProjectsClient({ orderedProjects, invitations, sharedProjects, statusTone }: ProjectsClientProps) {
  const t = useTranslations("Projects");
  const format = useFormatter();

  return (
    <main className="min-h-[calc(100dvh-64px)] bg-[var(--color-bg)] px-4 py-8 lg:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl space-y-10">
        <PageHero
          eyebrow={t("List.eyebrow")}
          title={t("List.title")}
          subtitle={t("List.description")}
        >
          <PrimaryButton icon={Plus} size="large">{t("List.create")}</PrimaryButton>
        </PageHero>

        {/* Project Invitations */}
        {invitations.length > 0 && (
          <div className="rounded-[var(--radius-card)] border-l-4 border-[var(--color-info)] bg-[var(--color-info-soft)] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-info)]">
                  {t("Invitations.title")}
                </p>
                <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">
                  {t("Invitations.description")}
                </p>
              </div>
              <Link href="/projects?tab=invitations">
                <PrimaryButton size="small">{t("Invitations.view")}</PrimaryButton>
              </Link>
            </div>
          </div>
        )}

        {/* Shared Projects */}
        {sharedProjects.length > 0 && (
          <section>
            <SectionHeading
              eyebrow={t("Shared.eyebrow")}
              title={t("Shared.title")}
              description={t("Shared.description")}
              action={<Link href="/projects?tab=shared"><PrimaryButton size="small">{t("Shared.viewAll")}</PrimaryButton></Link>}
            />
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sharedProjects.map((project) => (
                <article
                  key={project.projectId}
                  className="ui-pressable overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)]"
                >
                  <div className="relative h-36 overflow-hidden">
                    {project.coverImageUrl ? (
                      <Image src={project.coverImageUrl} alt={project.projectName} fill className="object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center bg-[var(--color-bg-terrain)]">
                        <Mountain size={36} className="text-[var(--color-pine)]" strokeWidth={1.5} />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                    <div className="absolute bottom-3 left-4">
                      <StatusPill tone={statusTone[project.projectStatus] ?? "neutral"} size="small">
                        {t(`Status.${project.projectStatus}`)}
                      </StatusPill>
                    </div>
                  </div>
                  <div className="p-5">
                    <h3 className="text-[16px] font-bold">{project.projectName}</h3>
                    <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">
                      {t("Shared.noDetails")}
                    </p>
                    <Link
                      href={`/projects/${project.projectId}`}
                      className="ui-pressable mt-4 inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-pine)] hover:underline"
                    >
                      {t("List.open")}
                      <ArrowRight size={16} strokeWidth={2} />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* My Projects */}
        <SectionHeading
          eyebrow={t("Team.myExpeditions")}
          title={t("Team.myExpeditions")}
          action={<Link href="/projects/new"><PrimaryButton icon={Plus} size="small">{t("List.create")}</PrimaryButton></Link>}
        />

        {orderedProjects.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-10 text-center sm:p-14">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-pine)]">
              <Mountain size={28} strokeWidth={1.5} />
            </div>
            <h3 className="mt-5 text-[20px] font-bold">{t("List.emptyTitle")}</h3>
            <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-text-muted)]">
              {t("List.emptyDescription")}
            </p>
            <div className="mt-6">
              <Link href="/projects/new">
                <PrimaryButton icon={Plus}>{t("List.createFirst")}</PrimaryButton>
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {orderedProjects.map((project) => {
              const mountainNames = project.mountains
                .slice(0, 3)
                .map((mountain) => mountain.nameDe ?? mountain.name ?? t("Common.unnamedMountain"));
              return (
                <article
                  key={project.id}
                  data-lifecycle-group={project.status === "active" || project.status === "ready" ? "active" : project.status}
                  className="ui-pressable group overflow-hidden rounded-[var(--radius-card)] border bg-[var(--color-surface)] shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)]"
                  style={{ borderColor: project.status === "archived" ? "var(--color-border-soft)" : "var(--color-border-soft)" }}
                >
                  <div className="relative h-36 overflow-hidden">
                    {project.coverImageUrl ? (
                      <Image src={project.coverImageUrl} alt={project.name} fill className="object-cover transition-transform duration-500 group-hover:scale-105" />
                    ) : (
                      <div className="flex h-full items-center justify-center bg-[var(--color-bg-terrain)]">
                        <Mountain size={36} className="text-[var(--color-pine)]" strokeWidth={1.5} />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                    <div className="absolute bottom-3 left-4">
                      <StatusPill tone={statusTone[project.status] ?? "neutral"} size="small">
                        {t(`Status.${project.status}`)}
                      </StatusPill>
                    </div>
                  </div>

                  <div className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="technical text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                          {t("List.projectLabel")}
                        </p>
                        <h3 className="mt-1 break-words text-[18px] font-bold">{project.name}</h3>
                      </div>
                    </div>

                    <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                      {project.startDate && project.endDate
                        ? t("Common.dateRange", {
                            start: format.dateTime(new Date(`${project.startDate}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                            end: format.dateTime(new Date(`${project.endDate}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                          })
                        : t("Common.datesOpen")}
                    </p>

                    <MetricRow
                      metrics={[
                        { label: t("Common.mountains"), value: String(project.mountains.length), icon: Mountain },
                        { label: t("Common.days"), value: String(project.dayCount), icon: CalendarDays },
                        { label: t("Common.journal"), value: String(project.journalEntryCount), icon: NotebookPen },
                      ]}
                    />

                    <p className="mt-4 min-h-6 text-sm text-[var(--color-text-secondary)]">
                      {mountainNames.length > 0 ? mountainNames.join(" · ") : t("List.noMountains")}
                    </p>

                    <div className="mt-auto flex items-center justify-between gap-4 pt-5">
                      <p className="technical text-[11px] text-[var(--color-text-muted)]">
                        {t("List.updated", { date: format.dateTime(new Date(project.updatedAt), { dateStyle: "medium" }) })}
                      </p>
                      <Link
                        href={`/projects/${project.id}`}
                        className="ui-pressable inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-pine)] hover:underline"
                      >
                        {t("List.open")}
                        <ArrowRight size={16} strokeWidth={2} />
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
