"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ExternalLink, FileUp, LoaderCircle, Map, Plus, Trash2, Unlink, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import ActivityTrackMap from "@/components/account/ActivityTrackMap";
import { linkExistingTrackToProjectDay, unlinkTrackFromProjectDay } from "@/Lib/projects/mutations";
import type { ProjectDayTrackEvidence, ProjectMountain, ProjectTrackPickerOption } from "@/Lib/projects/types";
import { deriveProjectTrackVerification } from "@/Lib/projects/tracks";
import { createClient } from "@/Lib/supabase/client";
import { importGpxActivity } from "@/Lib/tracks/importGpxActivity";
import { Link, useRouter } from "@/i18n/navigation";

type Props = {
  projectId: string;
  projectDayId: string;
  assignedMountains: ProjectMountain[];
  evidence: ProjectDayTrackEvidence[];
  pickerOptions: ProjectTrackPickerOption[];
  signedGeoJsonUrls: Record<string, string>;
  editable?: boolean;
  currentUserId: string;
};

export default function ProjectDayTrackEvidenceSection({ projectId, projectDayId, assignedMountains, evidence, pickerOptions, signedGeoJsonUrls, editable = true, currentUserId }: Props) {
  const t = useTranslations("Projects.Tracks");
  const format = useFormatter();
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const uploadDialogRef = useRef<HTMLDialogElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const submissionLockRef = useRef(false);
  const [busyId, setBusyId] = useState<number | string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<"idle" | "importing" | "linking" | "link-failed">("idle");
  const [importedActivityId, setImportedActivityId] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const linkedIds = new Set(evidence.map((track) => track.activityId));

  useEffect(() => {
    const dialog = dialogRef.current;
    const restoreFocus = () => openButtonRef.current?.focus();
    const uploadDialog = uploadDialogRef.current;
    const restoreUploadFocus = () => uploadButtonRef.current?.focus();
    dialog?.addEventListener("close", restoreFocus);
    uploadDialog?.addEventListener("close", restoreUploadFocus);
    return () => { dialog?.removeEventListener("close", restoreFocus); uploadDialog?.removeEventListener("close", restoreUploadFocus); };
  }, []);

  async function linkImportedTrack(activityId: number) {
    setUploadState("linking");
    const result = await linkExistingTrackToProjectDay(createClient(), { projectId, projectDayId, gpsActivityId: activityId, imported: true });
    if (!result.ok && result.reason !== "conflict") {
      setUploadState("link-failed");
      setUploadMessage(t("trackImportedLinkFailed"));
      return false;
    }
    setUploadState("idle"); setUploadMessage(t("trackImportedAndLinked")); setImportedActivityId(null); setUploadFile(null);
    uploadDialogRef.current?.close();
    router.refresh();
    return true;
  }

  async function importAndLink() {
    if (!uploadFile || submissionLockRef.current) return;
    submissionLockRef.current = true;
    setUploadState("importing"); setUploadMessage("");
    const result = await importGpxActivity({ supabase: createClient(), file: uploadFile, source: "other" });
    if (!result.ok) {
      setUploadState("idle");
      setUploadMessage(t(result.reason === "validation" ? "invalidGpx" : result.reason === "cleanup-required" ? "gpxCleanupRequired" : "gpxImportFailed"));
      submissionLockRef.current = false;
      return;
    }
    setImportedActivityId(result.gpsActivityId);
    setUploadMessage(t("trackImported"));
    await linkImportedTrack(result.gpsActivityId);
    submissionLockRef.current = false;
  }

  async function retryImportedLink() {
    if (importedActivityId === null || submissionLockRef.current) return;
    submissionLockRef.current = true;
    await linkImportedTrack(importedActivityId);
    submissionLockRef.current = false;
  }

  function closeUploadDialog() {
    if (uploadState === "importing" || uploadState === "linking") return;
    uploadDialogRef.current?.close();
  }

  async function linkTrack(track: ProjectTrackPickerOption) {
    if (busyId !== null || linkedIds.has(track.activityId)) return;
    setBusyId(track.activityId); setMessage("");
    const result = await linkExistingTrackToProjectDay(createClient(), { projectId, projectDayId, gpsActivityId: track.activityId });
    setBusyId(null);
    if (!result.ok) { setMessage(result.reason === "conflict" ? t("alreadyLinked") : t("trackLinkFailed")); return; }
    dialogRef.current?.close();
    router.refresh();
  }

  async function unlinkTrack(track: ProjectDayTrackEvidence) {
    if (busyId !== null || !window.confirm(t("unlinkTrackConfirm", { title: track.title ?? t("fallbackTitle", { id: track.activityId }) }))) return;
    setBusyId(track.relationId); setMessage("");
    const result = await unlinkTrackFromProjectDay(createClient(), track.relationId);
    setBusyId(null);
    if (!result.ok) { setMessage(t("trackLinkFailed")); return; }
    router.refresh();
  }

  const metric = (value: number | null, suffix: string) => value === null ? t("unavailable") : `${format.number(value)} ${suffix}`;
  const duration = (seconds: number | null) => seconds === null ? t("unavailable") : `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")} h`;

  return <section className="mt-5 border-t border-[var(--color-border-soft)] pt-5" aria-labelledby={`gps-evidence-${projectDayId}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h4 id={`gps-evidence-${projectDayId}`} className="[font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("actualAscent")}</h4><p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("gpsEvidence")}</p></div>
      {editable && <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"><button ref={uploadButtonRef} type="button" onClick={() => uploadDialogRef.current?.showModal()} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-3 text-sm font-bold text-[var(--color-text-inverse)]"><FileUp aria-hidden="true" size={16}/>{t("uploadGpx")}</button><button ref={openButtonRef} type="button" onClick={() => dialogRef.current?.showModal()} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 text-sm font-bold"><Plus aria-hidden="true" size={16}/>{t("linkExistingTrack")}</button></div>}
    </div>
    {evidence.length === 0 ? <p className="mt-3 text-sm text-[var(--color-text-muted)]">{t("noTrackLinked")}</p> : <ul className="mt-3 space-y-3">{evidence.map((track) => {
      const verification = deriveProjectTrackVerification(track);
      const matches = track.detectedMountainId !== null && assignedMountains.some((mountain) => mountain.id === track.detectedMountainId);
      const signedUrl = signedGeoJsonUrls[String(track.activityId)];
      const expanded = expandedId === track.activityId;
      return <li key={track.relationId} className="min-w-0 border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="break-words font-bold">{track.title ?? t("fallbackTitle", { id: track.activityId })}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{track.startedAt ? format.dateTime(new Date(track.startedAt), { dateStyle: "medium" }) : t("unavailable")} · {track.sourceType}</p></div><span className="w-fit rounded-full bg-[var(--color-surface)] px-2.5 py-1 text-xs font-bold">{t(verification)}</span></div>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm"><div><dt className="text-xs text-[var(--color-text-muted)]">{t("distance")}</dt><dd className="font-semibold">{track.processingStatus === "ready" && track.distanceM !== null ? metric(track.distanceM / 1000, "km") : t("unavailable")}</dd></div><div><dt className="text-xs text-[var(--color-text-muted)]">{t("duration")}</dt><dd className="font-semibold">{duration(track.durationSeconds)}</dd></div><div><dt className="text-xs text-[var(--color-text-muted)]">{t("elevationGain")}</dt><dd className="font-semibold">{metric(track.elevationGainM, "m")}</dd></div></dl>
        <p className="mt-3 text-sm"><span className="text-[var(--color-text-muted)]">{t("detectedMountain")}:</span> {track.detectedMountainId === null ? t("notDetected") : track.detectedMountainName ?? `#${track.detectedMountainId}`}{track.detectedMountainId !== null && <span className="ml-2 font-semibold">· {t(matches ? "matchesPlannedMountain" : "differentMountainDetected")}</span>}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {track.processingStatus === "ready" && signedUrl && <button type="button" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : track.activityId)} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-bold"><Map aria-hidden="true" size={16}/>{t(expanded ? "hideMap" : "showMap")}</button>}
          {track.userId === currentUserId && <Link href={`/account/tracks/${track.activityId}`} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-bold"><ExternalLink aria-hidden="true" size={16}/>{t("openFullTrack")}</Link>}
          {editable && <button type="button" disabled={busyId !== null} onClick={() => void unlinkTrack(track)} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-bold text-[var(--color-danger)] disabled:opacity-50">{busyId === track.relationId ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16}/> : <Unlink aria-hidden="true" size={16}/>} {t("unlinkTrack")}</button>}
        </div>
        {expanded && signedUrl && <div className="mt-3 overflow-hidden border border-[var(--color-border)]"><p className="sr-only">{t("mapFallback")}</p><ActivityTrackMap signedGeoJsonUrl={signedUrl} activityTitle={track.title ?? t("fallbackTitle", { id: track.activityId })}/></div>}
      </li>;
    })}</ul>}
    {message && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{message}</p>}
    <dialog ref={uploadDialogRef} onCancel={(event) => { if (uploadState === "importing" || uploadState === "linking") event.preventDefault(); }} aria-labelledby={`upload-gpx-${projectDayId}`} className="m-auto w-[min(34rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-card)] backdrop:bg-black/55">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4"><div><h3 id={`upload-gpx-${projectDayId}`} className="text-lg font-bold">{t("uploadGpx")}</h3><p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("uploadGpxDescription")}</p></div><button type="button" disabled={uploadState === "importing" || uploadState === "linking"} onClick={closeUploadDialog} aria-label={t("closeUpload")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center disabled:opacity-40"><X aria-hidden="true" size={20}/></button></div>
      <div className="space-y-4 p-4">
        <label className="block"><span className="mb-2 block text-sm font-bold">{t("chooseGpxFile")}</span><input type="file" accept=".gpx,application/gpx+xml" disabled={uploadState !== "idle" || importedActivityId !== null} onChange={(event) => { setUploadFile(event.target.files?.[0] ?? null); setUploadMessage(""); }} aria-describedby={`upload-status-${projectDayId}`} className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] p-2 file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-[var(--color-forest-soft)] file:px-3 file:py-2 file:font-bold"/></label>
        {uploadFile && <div className="flex min-w-0 flex-col gap-2 border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="break-all text-sm font-bold">{uploadFile.name}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{format.number(uploadFile.size / 1024 / 1024, { maximumFractionDigits: 2 })} MB</p></div>{uploadState === "idle" && importedActivityId === null && <button type="button" onClick={() => { setUploadFile(null); setUploadMessage(""); }} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 px-3 text-sm font-bold text-[var(--color-danger)]"><Trash2 aria-hidden="true" size={16}/>{t("removeFile")}</button>}</div>}
        <p id={`upload-status-${projectDayId}`} aria-live="polite" className="min-h-5 text-sm text-[var(--color-text-secondary)]">{uploadState === "importing" ? t("importingTrack") : uploadState === "linking" ? t("linkingImportedTrack") : uploadMessage || (uploadFile ? t("selectedGpx", { name: uploadFile.name }) : "")}</p>
        {uploadState === "link-failed" && <p className="text-sm text-[var(--color-text-muted)]">{t("trackAvailableInAccount")}</p>}
        <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:justify-end"><button type="button" disabled={uploadState === "importing" || uploadState === "linking"} onClick={closeUploadDialog} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold">{t("stayOnProject")}</button>{uploadState === "link-failed" ? <button type="button" onClick={() => void retryImportedLink()} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-[var(--color-text-inverse)]">{t("retryLink")}</button> : <button type="button" disabled={!uploadFile || uploadState !== "idle"} onClick={() => void importAndLink()} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-[var(--color-text-inverse)] disabled:opacity-50">{uploadState === "importing" ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16}/> : <FileUp aria-hidden="true" size={16}/>} {t("importTrack")}</button>}</div>
      </div>
    </dialog>
    <dialog ref={dialogRef} aria-labelledby={`choose-track-${projectDayId}`} className="m-auto w-[min(42rem,calc(100%-2rem))] max-h-[min(80dvh,42rem)] overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-card)] backdrop:bg-black/55">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4"><h3 id={`choose-track-${projectDayId}`} className="text-lg font-bold">{t("chooseTrack")}</h3><button type="button" onClick={() => dialogRef.current?.close()} aria-label={t("closePicker")} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center"><X aria-hidden="true" size={20}/></button></div>
      <ul className="space-y-2 p-4">{pickerOptions.map((track) => { const linked = linkedIds.has(track.activityId); return <li key={track.activityId}><button type="button" disabled={linked || busyId !== null} onClick={() => void linkTrack(track)} className="ui-pressable flex min-h-11 w-full min-w-0 flex-col items-start border border-[var(--color-border)] p-3 text-left disabled:opacity-55"><span className="flex w-full items-center justify-between gap-3"><span className="min-w-0 break-words font-bold">{track.title ?? t("fallbackTitle", { id: track.activityId })}</span>{busyId === track.activityId ? <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin" size={16}/> : <Activity aria-hidden="true" className="shrink-0" size={16}/>}</span><span className="mt-1 text-xs text-[var(--color-text-muted)]">{track.startedAt ? format.dateTime(new Date(track.startedAt), { dateStyle: "medium" }) : t("unavailable")} · {track.sourceType} · {track.processingStatus}{linked ? ` · ${t("alreadyLinked")}` : ""}</span></button></li>; })}</ul>
    </dialog>
  </section>;
}
