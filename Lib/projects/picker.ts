import type { ExpeditionProjectSummary, MountainId, ProjectPickerOption } from "./types.ts";

export function projectContainsMountain(project: Pick<ExpeditionProjectSummary, "mountains">, mountainId: MountainId): boolean {
  return project.mountains.some((mountain) => mountain.id === mountainId);
}

export function buildProjectPickerOptions(projects: readonly ExpeditionProjectSummary[], mountainId: MountainId): ProjectPickerOption[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    status: project.status,
    startDate: project.startDate,
    endDate: project.endDate,
    alreadyContainsMountain: projectContainsMountain(project, mountainId),
  }));
}

type PickerProjectRow = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  expedition_project_mountains?: unknown;
};

export function normalizeProjectPickerOption(value: unknown): ProjectPickerOption | null {
  if (!value || typeof value !== "object") return null;
  const row = value as PickerProjectRow;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  if (row.status !== "planning" && row.status !== "ready" && row.status !== "active" && row.status !== "completed" && row.status !== "archived") return null;
  const memberships = Array.isArray(row.expedition_project_mountains) ? row.expedition_project_mountains : [];
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    startDate: typeof row.start_date === "string" ? row.start_date : null,
    endDate: typeof row.end_date === "string" ? row.end_date : null,
    alreadyContainsMountain: memberships.length > 0,
  };
}
