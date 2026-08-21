"use client";

import { useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronUp, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { addProjectDay, assignMountainToDay, deleteProjectDay, reorderProjectDays, unassignMountainFromDay, updateProjectDay } from "@/Lib/projects/mutations";
import type { ProjectDay, ProjectMountain } from "@/Lib/projects/types";
import { PROJECT_DAY_NOTES_MAX_LENGTH, PROJECT_DAY_TITLE_MAX_LENGTH, PROJECT_MAX_DAYS, validateProjectDay } from "@/Lib/projects/validation";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";
import ProjectConflictNotice from "./ProjectConflictNotice";

type Props = { projectId: string; day: ProjectDay; days: ProjectDay[]; projectMountains: ProjectMountain[]; dateLabel: string; editable?: boolean; weatherContent?: React.ReactNode; evidenceContent?: React.ReactNode; journalContent?: React.ReactNode };

export function AddProjectDayButton({ projectId, dayCount, hasFixedDateRange }: { projectId: string; dayCount: number; hasFixedDateRange: boolean }) {
  const t = useTranslations("Projects.Mutations");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const atLimit = dayCount >= PROJECT_MAX_DAYS;
  async function add() {
    if (busy || atLimit || hasFixedDateRange) return;
    setBusy(true); setFailed(false);
    const result = await addProjectDay(createClient(), projectId);
    setBusy(false);
    if (!result.ok) { setFailed(true); return; }
    router.refresh();
  }
  return <div className="flex max-w-xs flex-col items-end"><button type="button" onClick={() => void add()} disabled={busy || atLimit || hasFixedDateRange} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 text-sm font-bold text-[var(--color-text-inverse)] disabled:cursor-not-allowed disabled:opacity-60">{busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : <Plus aria-hidden="true" size={17} />}{busy ? t("addingDay") : t("addDay")}</button>{atLimit && <span className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{t("dayLimit")}</span>}{hasFixedDateRange && <span className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{t("fixedDateRange")}</span>}{failed && <span role="alert" className="mt-1 text-right text-xs text-[var(--color-danger)]">{t("addDayError")}</span>}</div>;
}

export default function ProjectDayEditor({ projectId, day, days, projectMountains, dateLabel, editable = true, weatherContent, evidenceContent, journalContent }: Props) {
  const t = useTranslations("Projects.Mutations");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(day.title ?? "");
  const [notes, setNotes] = useState(day.notes ?? "");
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [conflict,setConflict]=useState<"day"|"order"|"permission"|"archived"|null>(null);
  const index = days.findIndex((item) => item.id === day.id);
  const assignedIds = new Set(day.mountains.map((mountain) => mountain.id));
  const availableMountains = projectMountains.filter((mountain) => !assignedIds.has(mountain.id));

  function begin(key: string) { setAction(key); setError(""); setSuccess(""); }
  function finishSuccess(message: string) { setAction(null); setSuccess(message); router.refresh(); }
  function finishError(message: string) { setAction(null); setError(message); }

  async function save(event: FormEvent) {
    event.preventDefault();
    const validation = validateProjectDay({ title, notes });
    if (validation.length) { setError(t(validation[0] === "day-title-too-long" ? "dayTitleTooLong" : "dayNotesTooLong")); return; }
    begin("save");
    const result = await updateProjectDay(createClient(), projectId, day.id, { title: title || null, notes: notes || null, expectedUpdatedAt: day.updatedAt });
    if (!result.ok) { if(["conflict","permission","archived"].includes(result.reason)){setAction(null);setConflict(result.reason==="conflict"?"day":result.reason as "permission"|"archived");return;} finishError(t("daySaveError")); return; }
    setEditing(false); finishSuccess(t("daySaved"));
  }

  async function remove() {
    if (action || !window.confirm(t("deleteDayConfirm", { number: day.dayNumber }))) return;
    begin("delete");
    const result = await deleteProjectDay(createClient(), day.id);
    if (!result.ok || !result.data) { finishError(t("deleteDayError")); return; }
    finishSuccess(t("dayDeleted"));
  }

  async function move(offset: -1 | 1) {
    const target = index + offset;
    if (action || index < 0 || target < 0 || target >= days.length) return;
    const order = days.map((item) => item.id);
    [order[index], order[target]] = [order[target], order[index]];
    begin(offset < 0 ? "up" : "down");
    const result = await reorderProjectDays(createClient(), projectId, order, days.map(({id,updatedAt})=>({id,updatedAt})));
    if (!result.ok || !result.data) { if(!result.ok&&["conflict","permission","archived"].includes(result.reason)){setAction(null);setConflict(result.reason==="conflict"?"order":result.reason as "permission"|"archived");return;} finishError(t("reorderError")); return; }
    finishSuccess(t("daysReordered"));
  }

  async function changeAssignment(mountain: ProjectMountain, assigned: boolean) {
    if (action) return;
    begin(`mountain-${mountain.id}`);
    const result = assigned
      ? await unassignMountainFromDay(createClient(), projectId, day.id, mountain.id)
      : await assignMountainToDay(createClient(), projectId, day.id, mountain.id, day.mountains.length);
    if (!result.ok) { finishError(t(assigned ? "unassignError" : "assignError")); return; }
    finishSuccess(t(assigned ? "mountainUnassigned" : "mountainAssigned"));
  }

  return (
    <article className="min-w-0 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-control)] sm:p-5">
      {conflict&&<div className="mb-4"><ProjectConflictNotice kind={conflict} onReload={()=>{setConflict(null);router.refresh();}}/></div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="[font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">{dateLabel}</p><h3 className="mt-2 break-words text-xl font-bold text-[var(--color-text)]">{day.title || t("defaultDayTitle", { number: day.dayNumber })}</h3></div>
        {editable && <div className="flex flex-wrap gap-1">
          <button type="button" disabled={index <= 0 || Boolean(action)} onClick={() => void move(-1)} aria-label={t("moveDayUpAria", { number: day.dayNumber })} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface-muted)] disabled:opacity-35"><ChevronUp aria-hidden="true" size={18} /></button>
          <button type="button" disabled={index < 0 || index >= days.length - 1 || Boolean(action)} onClick={() => void move(1)} aria-label={t("moveDayDownAria", { number: day.dayNumber })} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface-muted)] disabled:opacity-35"><ChevronDown aria-hidden="true" size={18} /></button>
          <button type="button" disabled={Boolean(action)} onClick={() => { setEditing(true); setError(""); setSuccess(""); }} aria-label={t("editDayAria", { number: day.dayNumber })} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"><Pencil aria-hidden="true" size={17} /></button>
          <button type="button" disabled={Boolean(action)} onClick={() => void remove()} aria-label={t("deleteDayAria", { number: day.dayNumber })} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-50">{action === "delete" ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : <Trash2 aria-hidden="true" size={17} />}</button>
        </div>}
      </div>
      {editable && editing ? <form onSubmit={(event) => void save(event)} className="mt-4 space-y-4" noValidate>
        <label className="block"><span className="mb-1 block text-sm font-bold">{t("dayTitleLabel")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={PROJECT_DAY_TITLE_MAX_LENGTH} className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3" /></label>
        <label className="block"><span className="mb-1 block text-sm font-bold">{t("dayNotesLabel")}</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={PROJECT_DAY_NOTES_MAX_LENGTH} className="ui-field min-h-28 w-full resize-y rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2" /></label>
        <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={action === "save"} onClick={() => { setEditing(false); setTitle(day.title ?? ""); setNotes(day.notes ?? ""); setError(""); }} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-semibold"><X aria-hidden="true" size={16} />{t("cancel")}</button><button type="submit" disabled={action === "save"} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-[var(--color-text-inverse)] disabled:opacity-60">{action === "save" && <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />}{t("save")}</button></div>
      </form> : null}
      <section className="mt-5 border-t border-[var(--color-border-soft)] pt-4" aria-labelledby={`assigned-mountains-${day.id}`}>
        <h4 id={`assigned-mountains-${day.id}`} className="[font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("assignedToDay")}</h4>
        {day.mountains.length === 0 ? <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("noMountainsAssignedToDay")}</p> : <ul className="mt-2 space-y-2">{day.mountains.map((mountain) => { const name = mountain.nameDe ?? mountain.name ?? t("unnamedMountain"); const loading = action === `mountain-${mountain.id}`; return <li key={mountain.id} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-forest-soft)] p-2.5 sm:flex-row sm:items-center"><div className="flex min-w-0 flex-1 items-center gap-2"><Check aria-hidden="true" className="shrink-0 text-[var(--color-forest)]" size={16} /><span className="min-w-0 break-words text-sm font-bold text-[var(--color-text)]">{name}</span><span className="shrink-0 text-xs font-semibold text-[var(--color-forest)]">{t("assigned")}</span></div>{editable && <button type="button" disabled={Boolean(action)} onClick={() => void changeAssignment(mountain, true)} className="ui-pressable inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] disabled:cursor-wait disabled:opacity-60 sm:w-auto">{loading && <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />}{t("removeMountainFromDay")}</button>}</li>; })}</ul>}
      </section>
      {editable && <section className="mt-5" aria-labelledby={`available-mountains-${day.id}`}>
        <h4 id={`available-mountains-${day.id}`} className="[font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("addFromProject")}</h4>
        {projectMountains.length === 0 ? <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("noProjectMountains")}</p> : availableMountains.length === 0 ? <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t("allProjectMountainsAssigned")}</p> : <ul className="mt-2 space-y-2">{availableMountains.map((mountain) => { const name = mountain.nameDe ?? mountain.name ?? t("unnamedMountain"); const loading = action === `mountain-${mountain.id}`; return <li key={mountain.id} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2.5 sm:flex-row sm:items-center"><span className="min-w-0 flex-1 break-words text-sm font-semibold text-[var(--color-text-secondary)]">{name}</span><button type="button" disabled={Boolean(action)} onClick={() => void changeAssignment(mountain, false)} className="ui-pressable inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-3 text-sm font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-wait disabled:opacity-60 sm:w-auto">{loading ? <LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> : <Plus aria-hidden="true" size={15} />}{t("addMountainToDay")}</button></li>; })}</ul>}
      </section>}
      {weatherContent}
      {evidenceContent}
      {!editing && day.notes && <section className="mt-5 border-t border-[var(--color-border-soft)] pt-4"><h4 className="[font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("notesLabel")}</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-secondary)]">{day.notes}</p></section>}
      {journalContent}
      {(error || success) && <p role={error ? "alert" : "status"} className={`mt-3 text-sm ${error ? "text-[var(--color-danger)]" : "text-[var(--color-forest)]"}`}>{error || success}</p>}
    </article>
  );
}
