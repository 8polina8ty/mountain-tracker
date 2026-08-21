import { ArrowLeft, CalendarDays, FileText, Mountain } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import ProjectActivity from "@/components/projects/ProjectActivity";
import ProjectDayEditor, { AddProjectDayButton } from "@/components/projects/ProjectDayEditor";
import ProjectDayTrackEvidenceSection from "@/components/projects/ProjectDayTrackEvidence";
import ProjectDayWeather from "@/components/projects/ProjectDayWeather";
import ProjectJournal from "@/components/projects/ProjectJournal";
import ProjectMountainActions from "@/components/projects/ProjectMountainActions";
import ProjectSharingControl from "@/components/projects/ProjectSharingControl";
import ProjectStatusControl from "@/components/projects/ProjectStatusControl";
import ProjectTeamSection from "@/components/projects/ProjectTeam";
import ProjectWeatherSummary from "@/components/projects/ProjectWeatherSummary";
import { buildProjectCompletionSummary } from "@/Lib/projects/completion";
import type { ProjectAccessRole, ProjectTeam } from "@/Lib/projects/collaboration";
import type {
  ExpeditionProject,
  MountainId,
  ProjectActivityPage,
  ProjectDayTrackEvidence,
  ProjectJournalEntry,
  ProjectJournalMediaDelivery,
  ProjectTrackPickerOption,
} from "@/Lib/projects/types";
import { summarizeProjectWeather } from "@/Lib/projects/weather";
import type { SummitWeather } from "@/Lib/weather/types";
import type { Locale } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";

type Props = {
  locale: Locale;
  userId: string;
  role: ProjectAccessRole;
  project: ExpeditionProject;
  editable: boolean;
  initialShare: { slug: string; enabled: boolean } | null;
  trackEvidence: ProjectDayTrackEvidence[];
  trackPickerOptions: ProjectTrackPickerOption[];
  signedTrackUrls: Record<string, string>;
  activityPage: ProjectActivityPage;
  weatherByMountain: ReadonlyMap<MountainId, SummitWeather | null>;
  mediaDeliveries: ProjectJournalMediaDelivery[];
  team: ProjectTeam | null;
};

export default async function ProjectDetailView({
  locale,
  userId,
  role,
  project,
  editable,
  initialShare,
  trackEvidence,
  trackPickerOptions,
  signedTrackUrls,
  activityPage,
  weatherByMountain,
  mediaDeliveries,
  team,
}: Props) {
  const [t, format] = await Promise.all([
    getTranslations({ locale, namespace: "Projects" }),
    getFormatter({ locale }),
  ]);

  const days = project.days.map((day) => ({
    ...day,
    trackEvidence: trackEvidence.filter((track) => track.projectDayId === day.id),
  }));
  const projectWithEvidence: ExpeditionProject = { ...project, days };
  const dayJournalEntriesById = new Map(projectWithEvidence.days.map((day) => [
    day.id,
    projectWithEvidence.journalEntries.filter((entry) => entry.projectDayId === day.id),
  ] as const));
  const completionSummary = buildProjectCompletionSummary(projectWithEvidence);
  const weatherSummary = summarizeProjectWeather(projectWithEvidence.days, weatherByMountain);
  const projectJournalEntries = projectWithEvidence.journalEntries.filter((entry) => entry.projectDayId === null);
  const dateRange = projectWithEvidence.startDate && projectWithEvidence.endDate
    ? t("Common.dateRange", {
        start: format.dateTime(new Date(`${projectWithEvidence.startDate}T00:00:00Z`), { dateStyle: "long", timeZone: "UTC" }),
        end: format.dateTime(new Date(`${projectWithEvidence.endDate}T00:00:00Z`), { dateStyle: "long", timeZone: "UTC" }),
      })
    : t("Common.datesOpen");

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-5 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <Link href="/projects" className="ui-pressable inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]">
          <ArrowLeft aria-hidden="true" size={17} />
          {t("Detail.back")}
        </Link>

        <header className="mt-4 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-inverse)] text-[var(--color-text-inverse)] shadow-[var(--shadow-card)]">
          <div className="px-5 py-7 sm:px-8 sm:py-9 lg:px-10">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">
                {t("Detail.eyebrow")}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full border border-white/25 px-3 py-1 text-xs font-bold">{t(`Team.${role}`)}</span>
                <Link href={`/projects/${projectWithEvidence.id}/report`} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-white/25 px-3 text-sm font-bold">
                  <FileText aria-hidden="true" size={16}/>{t("Report.viewReport")}
                </Link>
                {role !== "viewer" && (role === "owner" || projectWithEvidence.status !== "archived") && (
                  <ProjectStatusControl
                    projectId={projectWithEvidence.id}
                    userId={userId}
                    status={projectWithEvidence.status}
                    summary={completionSummary}
                    allowArchive={role === "owner"}
                  />
                )}
              </div>
            </div>
            <h1 className="mt-5 max-w-4xl break-words text-4xl font-bold leading-[0.95] sm:text-6xl">{projectWithEvidence.name}</h1>
            <p className="mt-5 [font-family:var(--font-technical)] text-sm font-semibold tabular-nums text-[var(--color-text-subtle)]">{dateRange}</p>
            {projectWithEvidence.description && (
              <p className="mt-6 max-w-3xl whitespace-pre-wrap border-t border-white/15 pt-5 leading-7 text-[var(--color-text-subtle)]">{projectWithEvidence.description}</p>
            )}
          </div>
          <dl className="grid grid-cols-3 border-t border-white/15 bg-white/[0.04]">
            <HeaderMetric label={t("Common.mountains")} value={projectWithEvidence.mountains.length} />
            <HeaderMetric label={t("Common.days")} value={projectWithEvidence.days.length} />
            <HeaderMetric label={t("Common.journal")} value={projectWithEvidence.journalEntries.length} />
          </dl>
        </header>

        {projectWithEvidence.status === "active" && (
          <p className="mt-4 border-l-4 border-[var(--color-forest)] bg-[var(--color-forest-soft)] px-4 py-3 text-sm font-bold text-[var(--color-forest)]">{t("Lifecycle.currentExpedition")}</p>
        )}
        {role === "owner" && (
          <ProjectSharingControl
            projectId={projectWithEvidence.id}
            eligible={projectWithEvidence.status === "completed" || projectWithEvidence.status === "archived"}
            initialShare={initialShare}
          />
        )}
        {projectWithEvidence.status === "completed" && <CompletionReport summary={completionSummary} t={t} format={format} />}

        <div className="mt-8 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0">
            <ProjectSection
              title={t("Detail.itineraryTitle")}
              description={t("Detail.itineraryDescription")}
              action={editable ? (
                <AddProjectDayButton
                  projectId={projectWithEvidence.id}
                  dayCount={projectWithEvidence.days.length}
                  hasFixedDateRange={Boolean(projectWithEvidence.startDate && projectWithEvidence.endDate)}
                />
              ) : undefined}
            >
              {projectWithEvidence.days.length === 0 ? (
                <EmptyState icon={CalendarDays} text={t("Detail.noDays")} />
              ) : (
                <ol className="space-y-6">
                  {projectWithEvidence.days.map((day) => {
                    const dayJournalEntries = dayJournalEntriesById.get(day.id) ?? [];
                    const daySignedTrackUrls = Object.fromEntries(
                      day.trackEvidence.flatMap((track) => signedTrackUrls[String(track.activityId)]
                        ? [[String(track.activityId), signedTrackUrls[String(track.activityId)]]]
                        : []),
                    );
                    return (
                      <li key={day.id} className="relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 before:absolute before:bottom-[-1.5rem] before:left-[1.34rem] before:top-11 before:w-px before:bg-[var(--color-border)] last:before:hidden sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-5 sm:before:left-[1.72rem]">
                        <div className="relative z-10 flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-inverse)] [font-family:var(--font-technical)] text-sm font-bold text-[var(--color-text-inverse)] sm:h-14 sm:w-14">{String(day.dayNumber).padStart(2, "0")}</div>
                        <ProjectDayEditor
                          projectId={projectWithEvidence.id}
                          day={day}
                          days={projectWithEvidence.days}
                          projectMountains={projectWithEvidence.mountains}
                          editable={editable}
                          dateLabel={day.date ? format.dateTime(new Date(`${day.date}T00:00:00Z`), { dateStyle: "full", timeZone: "UTC" }) : t("Detail.dateOpen")}
                          weatherContent={<ProjectDayWeather key={`day-weather-${day.id}`} locale={locale} day={day} weatherByMountain={weatherByMountain} />}
                          evidenceContent={(
                            <>
                              <DayProgress evidenceCount={day.trackEvidence.length} journalEntries={dayJournalEntries} t={t}/>
                              <ProjectDayTrackEvidenceSection
                                projectId={projectWithEvidence.id}
                                projectDayId={day.id}
                                assignedMountains={day.mountains}
                                evidence={day.trackEvidence}
                                pickerOptions={trackPickerOptions}
                                signedGeoJsonUrls={daySignedTrackUrls}
                                editable={editable}
                                currentUserId={userId}
                              />
                            </>
                          )}
                          journalContent={(
                            <section key={`day-journal-${day.id}`} className="mt-6 border-t border-[var(--color-border-soft)] pt-5" aria-labelledby={`day-journal-${day.id}`}>
                              <h4 id={`day-journal-${day.id}`} className="[font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("Detail.dayJournalTitle")}</h4>
                              <div className="mt-3">
                                <ProjectJournal
                                  projectId={projectWithEvidence.id}
                                  projectDayId={day.id}
                                  entries={dayJournalEntries}
                                  deliveries={mediaDeliveries}
                                  emptyText={t("Detail.noDayJournalEntries")}
                                  compact
                                  editable={editable}
                                  currentUserId={userId}
                                  owner={role === "owner"}
                                />
                              </div>
                            </section>
                          )}
                        />
                      </li>
                    );
                  })}
                </ol>
              )}
            </ProjectSection>
          </div>

          <aside className="min-w-0 space-y-8" aria-label={t("Weather.expeditionSummary")}>
            {team && <ProjectTeamSection projectId={projectWithEvidence.id} team={team} canInvite={projectWithEvidence.status !== "archived"} />}
            <ProjectActivity projectId={projectWithEvidence.id} initialPage={activityPage} />
            <ProjectWeatherSummary locale={locale} summary={weatherSummary} />
            <ProjectSection title={t("Detail.mountainsTitle")} description={t("Detail.mountainsDescription")}>
              {projectWithEvidence.mountains.length === 0 ? (
                <EmptyState icon={Mountain} text={t("Detail.noMountains")} />
              ) : (
                <div className="space-y-3">
                  {projectWithEvidence.mountains.map((mountain, index) => {
                    const assignedDays = projectWithEvidence.days
                      .filter((day) => day.mountains.some((assigned) => assigned.id === mountain.id))
                      .map((day) => day.dayNumber);
                    const name = mountain.nameDe ?? mountain.name ?? t("Common.unnamedMountain");
                    return (
                      <article key={mountain.id} className="border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-control)]">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 [font-family:var(--font-technical)] text-xs font-bold text-[var(--color-text-muted)]">{String(index + 1).padStart(2, "0")}</span>
                          <Link href={`/mountain/${mountain.id}`} className="ui-pressable min-w-0 flex-1 hover:text-[var(--color-forest)]">
                            <span className="block break-words font-bold">{name}</span>
                            <span className="mt-1 block [font-family:var(--font-technical)] text-xs font-semibold tabular-nums text-[var(--color-text-muted)]">{format.number(mountain.heightM)} m</span>
                          </Link>
                          {editable && <ProjectMountainActions projectId={projectWithEvidence.id} mountainId={mountain.id} mountainName={name} />}
                        </div>
                        {assignedDays.length > 0 && (
                          <p className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-xs text-[var(--color-text-muted)]">{t("Detail.assignedDays", { days: assignedDays.join(", ") })}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </ProjectSection>
          </aside>
        </div>

        <div className="mt-10 border-t border-[var(--color-border)] pt-8">
          <ProjectSection title={t("Detail.projectJournalTitle")} description={t("Detail.projectJournalDescription")}>
            <ProjectJournal
              projectId={projectWithEvidence.id}
              entries={projectJournalEntries}
              deliveries={mediaDeliveries}
              emptyText={t("Detail.noProjectJournalEntries")}
              editable={editable}
              currentUserId={userId}
              owner={role === "owner"}
            />
          </ProjectSection>
        </div>
      </div>
    </main>
  );
}

function CompletionReport({ summary, t, format }: {
  summary: ReturnType<typeof buildProjectCompletionSummary>;
  t: Awaited<ReturnType<typeof getTranslations>>;
  format: Awaited<ReturnType<typeof getFormatter>>;
}) {
  const duration = `${Math.floor(summary.totalDurationSeconds / 3600)}:${String(Math.floor((summary.totalDurationSeconds % 3600) / 60)).padStart(2, "0")} h`;
  const metrics = [
    [t("Lifecycle.daysWithEvidence"), `${summary.daysWithGpsEvidence}/${summary.totalDays}`],
    [t("Lifecycle.totalDistance"), `${format.number(summary.totalDistanceM / 1000, { maximumFractionDigits: 1 })} km`],
    [t("Lifecycle.totalElevationGain"), `${format.number(summary.totalElevationGainM)} m`],
    [t("Lifecycle.totalDuration"), duration],
    [t("Lifecycle.verifiedMountains"), summary.verifiedMountainCount],
    [t("Lifecycle.likelyMountains"), summary.likelyMountainCount],
    [t("Lifecycle.journalEntries"), summary.journalEntryCount],
    [t("Lifecycle.photos"), summary.photoCount],
    [t("Lifecycle.videos"), summary.videoCount],
  ];
  return (
    <section className="mt-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-control)] sm:p-5" aria-labelledby="expedition-report-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="expedition-report-title" className="text-xl font-bold">{t("Lifecycle.expeditionReport")}</h2>
        <span className="rounded-full bg-[var(--color-forest-soft)] px-3 py-1 text-xs font-bold text-[var(--color-forest)]">{t("Lifecycle.projectCompleted")}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        {metrics.map(([label, value]) => (
          <div key={String(label)}>
            <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
            <dd className="mt-1 font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function DayProgress({ evidenceCount, journalEntries, t }: {
  evidenceCount: number;
  journalEntries: ProjectJournalEntry[];
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  const media = journalEntries.flatMap((entry) => entry.media);
  return (
    <p className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border-soft)] pt-4 text-xs font-semibold text-[var(--color-text-muted)]">
      <span>{evidenceCount > 0 ? t("Lifecycle.evidenceAdded") : t("Lifecycle.planned")}</span>
      <span>{t("Lifecycle.journalCount", { count: journalEntries.length })}</span>
      <span>{t("Lifecycle.mediaCount", { count: media.length })}</span>
    </p>
  );
}

function HeaderMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-l border-white/15 px-3 py-4 first:border-l-0 sm:px-6">
      <dt className="text-xs text-[var(--color-text-subtle)]">{label}</dt>
      <dd className="mt-1 [font-family:var(--font-technical)] text-2xl font-bold tabular-nums">{String(value).padStart(2, "0")}</dd>
    </div>
  );
}

function ProjectSection({ title, description, action, children }: {
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-[var(--color-text)]">{title}</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Mountain; text: string }) {
  return (
    <div className="border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-8 text-center">
      <Icon aria-hidden="true" className="mx-auto text-[var(--color-text-muted)]" size={25} />
      <p className="mx-auto mt-3 max-w-md text-sm text-[var(--color-text-muted)]">{text}</p>
    </div>
  );
}
