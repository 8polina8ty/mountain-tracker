import { PROJECT_STATUSES, type CreateProjectInput, type ProjectStatus } from "./types.ts";

export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;
export const PROJECT_DAY_TITLE_MAX_LENGTH = 160;
export const PROJECT_DAY_NOTES_MAX_LENGTH = 8000;
export const PROJECT_JOURNAL_TITLE_MAX_LENGTH = 160;
export const PROJECT_JOURNAL_BODY_MAX_LENGTH = 12000;
export const PROJECT_MAX_DAYS = 60;

export type ProjectValidationError =
  | "name-required"
  | "name-too-long"
  | "description-too-long"
  | "date-pair-required"
  | "invalid-date"
  | "end-before-start"
  | "too-many-days";

export type ProjectContentValidationError =
  | "day-title-too-long"
  | "day-notes-too-long"
  | "journal-title-too-long"
  | "journal-body-required"
  | "journal-body-too-long";

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && PROJECT_STATUSES.some((status) => status === value);
}

export function validateProjectDay(values: { title?: string | null; notes?: string | null }): ProjectContentValidationError[] {
  const errors: ProjectContentValidationError[] = [];
  if ((values.title?.trim().length ?? 0) > PROJECT_DAY_TITLE_MAX_LENGTH) errors.push("day-title-too-long");
  if ((values.notes?.trim().length ?? 0) > PROJECT_DAY_NOTES_MAX_LENGTH) errors.push("day-notes-too-long");
  return errors;
}

export function validateJournalEntry(values: { title?: string | null; body: string; mediaCount?: number }): ProjectContentValidationError[] {
  const errors: ProjectContentValidationError[] = [];
  if ((values.title?.trim().length ?? 0) > PROJECT_JOURNAL_TITLE_MAX_LENGTH) errors.push("journal-title-too-long");
  const bodyLength = values.body.trim().length;
  if (bodyLength === 0 && (values.mediaCount ?? 0) === 0) errors.push("journal-body-required");
  if (bodyLength > PROJECT_JOURNAL_BODY_MAX_LENGTH) errors.push("journal-body-too-long");
  return errors;
}

export function validateCreateProjectInput(input: CreateProjectInput): ProjectValidationError[] {
  const errors: ProjectValidationError[] = [];
  const name = input.name.trim();
  const startDate = input.startDate ?? null;
  const endDate = input.endDate ?? null;

  if (name.length === 0) errors.push("name-required");
  if (name.length > PROJECT_NAME_MAX_LENGTH) errors.push("name-too-long");
  if ((input.description?.length ?? 0) > PROJECT_DESCRIPTION_MAX_LENGTH) errors.push("description-too-long");
  if ((startDate === null) !== (endDate === null)) errors.push("date-pair-required");

  if (startDate !== null && endDate !== null) {
    const start = parseIsoDate(startDate);
    const end = parseIsoDate(endDate);
    if (!start || !end) errors.push("invalid-date");
    else if (end < start) errors.push("end-before-start");
    else if (inclusiveCalendarDayCount(startDate, endDate) > PROJECT_MAX_DAYS) errors.push("too-many-days");
  }
  return errors;
}

export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function inclusiveCalendarDayCount(startDate: string, endDate: string): number {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end || end < start) return 0;
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}
