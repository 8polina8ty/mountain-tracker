"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { createProject } from "@/Lib/projects/mutations";
import type { ProjectValidationError } from "@/Lib/projects/validation";
import { validateCreateProjectInput } from "@/Lib/projects/validation";
import { createClient } from "@/Lib/supabase/client";
import { Link, useRouter } from "@/i18n/navigation";

const errorKeys: Record<ProjectValidationError, string> = {
  "name-required": "nameRequired",
  "name-too-long": "nameTooLong",
  "description-too-long": "descriptionTooLong",
  "date-pair-required": "datePairRequired",
  "invalid-date": "invalidDate",
  "end-before-start": "endBeforeStart",
  "too-many-days": "tooManyDays",
};

export default function ProjectCreateForm() {
  const t = useTranslations("Projects.Create");
  const errorsT = useTranslations("Projects.Errors");
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const input = {
      name,
      description: description || null,
      startDate: startDate || null,
      endDate: endDate || null,
    };
    const validationErrors = validateCreateProjectInput(input);

    if (validationErrors.length > 0) {
      setMessage(errorsT(errorKeys[validationErrors[0]]));
      return;
    }

    setSubmitting(true);
    setMessage("");
    const result = await createProject(createClient(), input);

    if (!result.ok) {
      setMessage(
        result.reason === "invalid" && result.message in errorKeys
          ? errorsT(errorKeys[result.message as ProjectValidationError])
          : errorsT("createFailed"),
      );
      setSubmitting(false);
      return;
    }

    router.push(`/projects/${result.data}`);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/projects"
        className="ui-pressable inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-forest)]"
      >
        <ArrowLeft aria-hidden="true" size={17} />
        {t("back")}
      </Link>

      <header className="mt-5 border-b border-[var(--color-border-strong)] pb-6">
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.12em] text-[var(--color-forest)]">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 text-4xl font-bold text-[var(--color-text)] sm:text-5xl">
          {t("title")}
        </h1>
        <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
          {t("description")}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="mt-7 space-y-6" noValidate>
        <label className="block">
          <span className="mb-2 block text-sm font-bold text-[var(--color-text)]">
            {t("nameLabel")}
          </span>
          <input
            className="ui-field min-h-12 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 text-[var(--color-text)]"
            value={name}
            onChange={(event) => { setName(event.target.value); setMessage(""); }}
            maxLength={120}
            autoComplete="off"
            required
            aria-describedby="project-name-help"
          />
          <span id="project-name-help" className="mt-1.5 block text-xs text-[var(--color-text-muted)]">
            {t("nameHelp")}
          </span>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-bold text-[var(--color-text)]">
            {t("descriptionLabel")}
          </span>
          <textarea
            className="ui-field min-h-32 w-full resize-y rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3 text-[var(--color-text)]"
            value={description}
            onChange={(event) => { setDescription(event.target.value); setMessage(""); }}
            maxLength={4000}
          />
        </label>

        <fieldset className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
          <legend className="px-2 text-sm font-bold text-[var(--color-text)]">
            {t("datesLegend")}
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[var(--color-text-secondary)]">
                {t("startDate")}
              </span>
              <input
                type="date"
                className="ui-field min-h-12 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-[var(--color-text)]"
                value={startDate}
                onChange={(event) => { setStartDate(event.target.value); setMessage(""); }}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[var(--color-text-secondary)]">
                {t("endDate")}
              </span>
              <input
                type="date"
                className="ui-field min-h-12 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-[var(--color-text)]"
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => { setEndDate(event.target.value); setMessage(""); }}
              />
            </label>
          </div>
          <p className="mt-3 flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <CalendarDays aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
            {t("datesHelp")}
          </p>
        </fieldset>

        {message && (
          <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--color-danger)]">
            {message}
          </p>
        )}

        <div className="flex flex-col-reverse gap-3 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:justify-end">
          <Link href="/projects" className="ui-pressable inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] px-5 font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]">
            {t("cancel")}
          </Link>
          <button type="submit" disabled={submitting} className="ui-pressable inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-wait disabled:opacity-65">
            {submitting && <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />}
            {submitting ? t("submitting") : t("submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
