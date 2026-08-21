import { buildProjectCompletionSummary } from "./completion.ts";
import type { ExpeditionProject, ProjectCompletionSummary, ProjectJournalEntry } from "./types.ts";

export type ProjectExpeditionReportDay = { day: ExpeditionProject["days"][number]; journalEntries: ProjectJournalEntry[] };
export type ProjectExpeditionReport = { project: ExpeditionProject; summary: ProjectCompletionSummary; reportState: "completed" | "preview"; days: ProjectExpeditionReportDay[] };

export function buildProjectExpeditionReport(project: ExpeditionProject): ProjectExpeditionReport {
  return {
    project,
    summary: buildProjectCompletionSummary(project),
    reportState: project.status === "completed" ? "completed" : "preview",
    days: project.days.map((day) => ({ day, journalEntries: project.journalEntries.filter((entry) => entry.projectDayId === day.id).sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id.localeCompare(b.id)) })),
  };
}
