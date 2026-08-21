"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FolderPlus, LoaderCircle, Plus, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { addMountainToProject } from "@/Lib/projects/mutations";
import { listProjectPickerOptions } from "@/Lib/projects/queries";
import type { MountainId, ProjectPickerOption } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";

type ProjectPickerProps = {
  mountainId: MountainId;
  mountainName: string;
  context?: "map" | "detail";
};

export default function ProjectPicker({ mountainId, mountainName, context = "detail" }: ProjectPickerProps) {
  const t = useTranslations("Projects.Picker");
  const statusT = useTranslations("Projects.Status");
  const format = useFormatter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [projects, setProjects] = useState<ProjectPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const returnTo = context === "map" ? "/map" : `/mountain/${mountainId}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function loadProjects() {
    const request = ++requestRef.current;
    setAuthState("checking");
    setLoading(true);
    setLoadFailed(false);
    setFailedId(null);
    setSuccessId(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.getUser();
    if (request !== requestRef.current) return;
    if (error || !data.user) {
      setAuthState("unauthenticated");
      setProjects([]);
      setLoading(false);
      return;
    }
    setAuthState("authenticated");
    try {
      const options = await listProjectPickerOptions(supabase, data.user.id, mountainId);
      if (request !== requestRef.current) return;
      setProjects(options);
    } catch {
      if (request !== requestRef.current) return;
      setLoadFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  function showPicker() {
    setOpen(true);
    void loadProjects();
  }

  function closePicker() {
    requestRef.current += 1;
    setOpen(false);
  }

  async function add(project: ProjectPickerOption) {
    if (addingId || project.alreadyContainsMountain) return;
    setAddingId(project.id);
    setFailedId(null);
    setSuccessId(null);
    const result = await addMountainToProject(createClient(), project.id, mountainId);
    setAddingId(null);
    if (!result.ok && result.reason === "unauthenticated") {
      setAuthState("unauthenticated");
      setProjects([]);
      return;
    }
    if (!result.ok && result.reason !== "conflict") {
      setFailedId(project.id);
      return;
    }
    setProjects((current) => current.map((option) => option.id === project.id ? { ...option, alreadyContainsMountain: true } : option));
    setSuccessId(project.id);
  }

  return (
    <>
      <button ref={triggerRef} type="button" onClick={showPicker} className={`ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-bold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)] ${context === "map" ? "mt-3 w-full" : "mt-4 w-full"}`}>
        <FolderPlus aria-hidden="true" size={17} />
        {t("addToProject")}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={`project-picker-title-${mountainId}`}
        aria-describedby={`project-picker-description-${mountainId}`}
        onCancel={(event) => { event.stopPropagation(); closePicker(); }}
        onClose={() => { setOpen(false); triggerRef.current?.focus(); }}
        onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
        className="m-0 mt-auto max-h-[82dvh] w-full max-w-none overflow-hidden rounded-t-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-panel)] backdrop:bg-black/55 sm:m-auto sm:max-h-[min(78dvh,42rem)] sm:w-[min(92vw,36rem)] sm:rounded-[var(--radius-panel)]"
      >
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <h2 id={`project-picker-title-${mountainId}`} className="text-xl font-bold">{t("projectPickerTitle")}</h2>
              <p id={`project-picker-description-${mountainId}`} className="mt-1 break-words text-sm text-[var(--color-text-muted)]">{t("projectPickerDescription", { name: mountainName })}</p>
            </div>
            <button type="button" autoFocus onClick={closePicker} aria-label={t("close")} className="ui-pressable inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--color-surface-muted)]"><X aria-hidden="true" size={19} /></button>
          </header>

          <div className="min-h-28 flex-1 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
            {(loading || authState === "checking") && <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]"><LoaderCircle aria-hidden="true" className="animate-spin" size={18} />{t("loadingProjects")}</div>}

            {!loading && authState === "unauthenticated" && <div className="py-5 text-center"><p className="text-sm text-[var(--color-text-secondary)]">{t("loginToAdd")}</p><Link href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`} className="ui-pressable mt-4 inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 font-bold text-[var(--color-text-inverse)]">{t("login")}</Link></div>}

            {!loading && authState === "authenticated" && loadFailed && <div role="alert" className="py-5 text-center"><p className="text-sm text-[var(--color-danger)]">{t("loadFailed")}</p><button type="button" onClick={() => void loadProjects()} className="ui-pressable mt-4 min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-5 font-bold">{t("retry")}</button></div>}

            {!loading && authState === "authenticated" && !loadFailed && projects.length === 0 && <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">{t("noProjects")}</p>}

            {!loading && authState === "authenticated" && !loadFailed && projects.length > 0 && <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">{projects.map((project) => {
              const isAdding = addingId === project.id;
              const added = successId === project.id;
              const failed = failedId === project.id;
              const dateRange = project.startDate && project.endDate ? t("dateRange", { start: format.dateTime(new Date(`${project.startDate}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }), end: format.dateTime(new Date(`${project.endDate}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }) }) : null;
              return <li key={project.id} className="py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words font-bold">{project.name}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{statusT(project.status)}{dateRange ? ` · ${dateRange}` : ""}</p></div>{project.alreadyContainsMountain ? <span className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-[var(--color-success)]"><Check aria-hidden="true" size={17} />{added ? t("addedToProject") : t("alreadyInProject")}</span> : <button type="button" disabled={Boolean(addingId)} onClick={() => void add(project)} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 text-sm font-bold text-[var(--color-text-inverse)] disabled:cursor-wait disabled:opacity-60">{isAdding ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <Plus aria-hidden="true" size={16} />}{isAdding ? t("adding") : failed ? t("retry") : t("add")}</button>}</div>{failed && <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{t("addFailed")}</p>}{added && <p role="status" className="mt-2 text-sm"><Link href={`/projects/${project.id}`} className="font-bold text-[var(--color-forest)] hover:underline">{t("openProject")}</Link></p>}</li>;
            })}</ul>}
          </div>

          <footer className="border-t border-[var(--color-border)] px-4 py-4 sm:px-5"><Link href="/projects/new" className="ui-pressable inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-4 text-sm font-bold hover:bg-[var(--color-surface-muted)]"><Plus aria-hidden="true" size={17} />{t("createNewProject")}</Link></footer>
        </div>
      </dialog>
    </>
  );
}
