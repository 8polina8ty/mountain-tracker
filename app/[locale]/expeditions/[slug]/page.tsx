import type { Metadata } from "next";
import Image from "next/image";
import { ImageOff, Video } from "lucide-react";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { loadPublicExpeditionReport } from "@/Lib/projects/publicReport";
import type { Locale } from "@/i18n/locales";

export const metadata: Metadata = { robots: { index: true, follow: true } };

export default async function PublicExpeditionPage({ params }: { params: Promise<{ locale: Locale; slug: string }> }) {
  const { locale, slug } = await params;
  const [report, t, format] = await Promise.all([loadPublicExpeditionReport(slug), getTranslations({ locale, namespace: "Projects.Sharing" }), getFormatter({ locale })]);
  if (!report) notFound();
  const duration = (seconds: number | null) => seconds === null ? t("unavailable") : `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")} h`;
  const stats = [[t("days"), report.summary.totalDays], [t("daysWithEvidence"), report.summary.daysWithGpsEvidence], [t("tracks"), report.summary.uniqueTrackCount], [t("distance"), `${format.number(report.summary.totalDistanceM / 1000, { maximumFractionDigits: 1 })} km`], [t("elevation"), `${format.number(report.summary.totalElevationGainM)} m`], [t("duration"), duration(report.summary.totalDurationSeconds)], [t("photos"), report.summary.photoCount], [t("videos"), report.summary.videoCount]] as const;
  return <main className="min-h-screen bg-[var(--color-bg)] px-4 py-8"><article className="mx-auto max-w-5xl bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)] sm:p-8">
    <header className="border-b-2 border-[var(--color-text)] pb-6"><p className="text-xs font-bold uppercase tracking-[0.12em]">Mountain Tracker · {t("publicExpedition")}</p><h1 className="mt-3 break-words text-4xl font-bold">{report.name}</h1><p className="mt-2 text-sm text-[var(--color-text-muted)]">{t(report.status)}{report.startDate && report.endDate ? ` · ${report.startDate} – ${report.endDate}` : ""}</p></header>
    <section className="mt-6" aria-labelledby="public-summary"><h2 id="public-summary" className="text-2xl font-bold">{t("summary")}</h2><dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">{stats.map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--color-text-muted)]">{label}</dt><dd className="mt-1 text-xl font-bold">{value}</dd></div>)}</dl></section>
    <section className="mt-8" aria-labelledby="public-mountains"><h2 id="public-mountains" className="text-2xl font-bold">{t("mountains")}</h2><ul className="mt-3 grid gap-2 sm:grid-cols-2">{report.mountains.map((mountain, index) => <li key={`${mountain.name}-${index}`} className="flex justify-between gap-3 border p-3"><span className="font-bold">{mountain.name}</span><span>{t(mountain.state)}</span></li>)}</ul></section>
    <section className="mt-8" aria-labelledby="public-timeline"><h2 id="public-timeline" className="text-2xl font-bold">{t("timeline")}</h2><div className="mt-4 space-y-8">{report.days.map((day) => <section key={day.number} className="border-t-2 pt-4"><h3 className="text-xl font-bold">{t("day", { number: day.number })}{day.title ? ` · ${day.title}` : ""}</h3>{day.date && <p className="text-sm text-[var(--color-text-muted)]">{day.date}</p>}<p className="mt-3 text-sm"><strong>{t("planned")}:</strong> {day.plannedMountains.join(" · ") || t("none")}</p>
      {day.tracks.length > 0 && <ul className="mt-3 grid gap-2 sm:grid-cols-2">{day.tracks.map((track, index) => <li key={`${track.title ?? "track"}-${index}`} className="border p-3 text-sm"><p className="font-bold">{track.title ?? t("track")} · {t(track.verification)}</p><p>{track.distanceM === null ? t("unavailable") : `${format.number(track.distanceM / 1000, { maximumFractionDigits: 1 })} km`} · {duration(track.durationSeconds)} · {track.elevationGainM === null ? t("unavailable") : `+${format.number(track.elevationGainM)} m`}</p></li>)}</ul>}
      {day.journal.map((entry, entryIndex) => <div key={`${entry.date}-${entryIndex}`} className="mt-4"><div className="border-l-2 pl-3">{entry.title && <h4 className="font-bold">{entry.title}</h4>}{entry.body.trim() && <p className="whitespace-pre-wrap text-sm">{entry.body}</p>}</div>{entry.media.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">{entry.media.map((media) => media.type === "photo" ? <figure key={media.handle} className="relative aspect-[4/3] overflow-hidden border bg-[var(--color-surface-muted)]"><Image unoptimized fill loading="lazy" sizes="(max-width: 640px) 33vw, 180px" src={`/api/public-expeditions/${encodeURIComponent(slug)}/media/${media.handle}?variant=thumb`} alt={t("journalPhoto")} className="object-contain"/></figure> : <figure key={media.handle} className="flex aspect-[4/3] flex-col items-center justify-center border bg-[var(--color-surface-muted)] p-2 text-center text-xs"><Video aria-hidden="true" size={22}/><span>{t("videoUnavailable")}</span></figure>)}</div>}</div>)}
      {day.journal.length === 0 && day.tracks.length === 0 && <p className="mt-3 flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><ImageOff aria-hidden="true" size={16}/>{t("none")}</p>}</section>)}</div></section>
    <footer className="mt-10 border-t pt-4 text-xs text-[var(--color-text-muted)]">{t("publicNotice")}</footer>
  </article></main>;
}
