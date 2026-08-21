import type { SupabaseClient } from "@supabase/supabase-js";

import type { CreateProjectInput, MountainId, ProjectMutationResult, ProjectStatus } from "./types.ts";
import { isProjectStatus, validateCreateProjectInput, validateJournalEntry, validateProjectDay } from "./validation.ts";
import { deleteProjectJournalEntryWithMedia } from "./media.ts";

function databaseFailure(error: unknown): ProjectMutationResult<never> {
  const message = error instanceof Error ? error.message : "Project database operation failed.";
  return { ok: false, reason: "database", message };
}

function structuredResult<T = undefined>(value: unknown, data?: T): ProjectMutationResult<T> {
  const status = value && typeof value === "object" && !Array.isArray(value) ? String((value as Record<string, unknown>).status ?? "unknown") : "unknown";
  if (status === "success" || status === "already-applied") return { ok: true, data: data as T, outcome: status };
  const allowed = ["auth","validation","conflict","not-found","permission","archived","partial-failure"] as const;
  const reason = allowed.includes(status as typeof allowed[number]) ? status as typeof allowed[number] : "unknown";
  return { ok: false, reason, message: reason };
}

export async function createProject(
  supabase: SupabaseClient,
  input: CreateProjectInput,
): Promise<ProjectMutationResult<string>> {
  const errors = validateCreateProjectInput(input);
  if (errors.length > 0) return { ok: false, reason: "invalid", message: errors[0] };
  const { data, error } = await supabase.rpc("create_expedition_project", {
    requested_name: input.name.trim(),
    requested_description: input.description?.trim() || null,
    requested_start_date: input.startDate ?? null,
    requested_end_date: input.endDate ?? null,
  });
  if (error) return databaseFailure(error);
  return typeof data === "string"
    ? { ok: true, data }
    : { ok: false, reason: "database", message: "Project creation returned no identifier." };
}

export async function addMountainToProject(
  supabase: SupabaseClient,
  projectId: string,
  mountainId: MountainId,
  sortOrder = 0,
): Promise<ProjectMutationResult> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return { ok: false, reason: "unauthenticated", message: "Authentication is required." };
  const { error } = await supabase.from("expedition_project_mountains").insert({
    project_id: projectId,
    mountain_id: mountainId,
    sort_order: sortOrder,
  });
  if (error) {
    return error.code === "23505"
      ? { ok: true, data: undefined, outcome: "already-applied" }
      : databaseFailure(error);
  }
  return { ok: true, data: undefined };
}

export async function removeMountainFromProject(
  supabase: SupabaseClient,
  projectId: string,
  mountainId: MountainId,
): Promise<ProjectMutationResult<boolean>> {
  const { data, error } = await supabase.rpc("remove_expedition_project_mountain", {
    requested_project_id: projectId,
    requested_mountain_id: mountainId,
  });
  if (error) return databaseFailure(error);
  return { ok: true, data: data === true };
}

export async function deleteProjectDay(
  supabase: SupabaseClient,
  dayId: string,
): Promise<ProjectMutationResult<boolean>> {
  const { data, error } = await supabase.rpc("delete_expedition_project_day", { requested_day_id: dayId });
  if (error) return databaseFailure(error);
  return { ok: true, data: data === true };
}

export async function addProjectDay(
  supabase: SupabaseClient,
  projectId: string,
  title?: string | null,
  notes?: string | null,
): Promise<ProjectMutationResult<string>> {
  const errors = validateProjectDay({ title, notes });
  if (errors.length > 0) return { ok: false, reason: "invalid", message: errors[0] };
  const { data, error } = await supabase.rpc("add_expedition_project_day", {
    requested_project_id: projectId,
    requested_title: title?.trim() || null,
    requested_notes: notes?.trim() || null,
  });
  if (error) return databaseFailure(error);
  return typeof data === "string"
    ? { ok: true, data }
    : { ok: false, reason: "database", message: "Day creation returned no identifier." };
}

export async function reorderProjectDays(
  supabase: SupabaseClient,
  projectId: string,
  dayIds: readonly string[],
  expectedDays: readonly { id: string; updatedAt: string }[],
): Promise<ProjectMutationResult<boolean>> {
  if (new Set(dayIds).size !== dayIds.length) return { ok: false, reason: "invalid", message: "Day order contains duplicates." };
  const { data, error } = await supabase.rpc("reorder_expedition_project_days_if_current", {
    requested_project_id: projectId,
    requested_day_ids: [...dayIds],
    expected_day_ids: expectedDays.map((day) => day.id),
    expected_updated_ats: expectedDays.map((day) => day.updatedAt),
  });
  if (error) return databaseFailure(error);
  return structuredResult(data, true);
}

export async function updateProjectStatus(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  status: ProjectStatus,
): Promise<ProjectMutationResult> {
  if (!isProjectStatus(status)) return { ok: false, reason: "invalid", message: "invalid-status" };
  void userId;
  const { error } = await supabase.rpc("set_expedition_project_status", { requested_project_id: projectId, requested_status: status });
  return error ? databaseFailure(error) : { ok: true, data: undefined };
}

export async function assignMountainToDay(
  supabase: SupabaseClient,
  projectId: string,
  dayId: string,
  mountainId: MountainId,
  sortOrder = 0,
): Promise<ProjectMutationResult> {
  const { error } = await supabase.from("expedition_project_day_mountains").insert({
    project_id: projectId,
    project_day_id: dayId,
    mountain_id: mountainId,
    sort_order: sortOrder,
  });
  if (error) return error.code === "23505"
    ? { ok: true, data: undefined, outcome: "already-applied" }
    : databaseFailure(error);
  return { ok: true, data: undefined };
}

export async function unassignMountainFromDay(
  supabase: SupabaseClient,
  projectId: string,
  dayId: string,
  mountainId: MountainId,
): Promise<ProjectMutationResult> {
  const { error } = await supabase.from("expedition_project_day_mountains").delete()
    .eq("project_id", projectId).eq("project_day_id", dayId).eq("mountain_id", mountainId);
  return error ? databaseFailure(error) : { ok: true, data: undefined };
}

export async function linkExistingTrackToProjectDay(
  supabase: SupabaseClient,
  input: { projectId: string; projectDayId: string; gpsActivityId: number; imported?: boolean },
): Promise<ProjectMutationResult> {
  const { error } = await supabase.rpc(input.imported ? "link_imported_expedition_project_day_track" : "link_expedition_project_day_track", {
    requested_project_id: input.projectId,
    requested_day_id: input.projectDayId,
    requested_activity_id: input.gpsActivityId,
  });
  if (error) return error.code === "23505"
    ? { ok: true, data: undefined, outcome: "already-applied" }
    : databaseFailure(error);
  return { ok: true, data: undefined };
}

export async function unlinkTrackFromProjectDay(supabase: SupabaseClient, relationId: string): Promise<ProjectMutationResult> {
  const { error } = await supabase.rpc("unlink_expedition_project_day_track", { requested_relation_id: relationId });
  return error ? databaseFailure(error) : { ok: true, data: undefined };
}

export async function updateProjectDay(
  supabase: SupabaseClient,
  projectId: string,
  dayId: string,
  values: { title: string | null; notes: string | null; expectedUpdatedAt: string },
): Promise<ProjectMutationResult<string>> {
  const errors = validateProjectDay(values);
  if (errors.length > 0) return { ok: false, reason: "invalid", message: errors[0] };
  const { data, error } = await supabase.rpc("update_expedition_project_day_if_current", { requested_project_id: projectId, requested_day_id: dayId, expected_updated_at: values.expectedUpdatedAt, requested_title: values.title?.trim() || null, requested_notes: values.notes?.trim() || null });
  if (error) return databaseFailure(error);
  const version = data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string,unknown>).updatedAt === "string" ? String((data as Record<string,unknown>).updatedAt) : "";
  return structuredResult(data, version);
}

export async function createJournalEntry(
  supabase: SupabaseClient,
  projectId: string,
  values: { title?: string | null; body: string; entryDate?: string; projectDayId?: string | null; mediaCount?: number },
): Promise<ProjectMutationResult<string>> {
  const errors = validateJournalEntry(values);
  if (errors.length > 0) return { ok: false, reason: "invalid", message: errors[0] };
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return { ok: false, reason: "unauthenticated", message: "Authentication is required." };
  if (values.projectDayId && !(await isOwnedProjectDay(supabase, projectId, values.projectDayId))) {
    return { ok: false, reason: "invalid", message: "journal-day-invalid" };
  }
  const { data, error } = await supabase.from("expedition_project_journal_entries").insert({
    project_id: projectId,
    user_id: authData.user.id,
    title: values.title?.trim() || null,
    body: values.body.trim(),
    project_day_id: values.projectDayId ?? null,
    ...(values.entryDate ? { entry_date: values.entryDate } : {}),
  }).select("id").single();
  if (error) return databaseFailure(error);
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === "string"
    ? { ok: true, data: id }
    : { ok: false, reason: "database", message: "Journal creation returned no identifier." };
}

export async function updateJournalEntry(
  supabase: SupabaseClient,
  projectId: string,
  entryId: string,
  values: { title: string | null; body: string; entryDate: string; projectDayId?: string | null; expectedUpdatedAt: string },
): Promise<ProjectMutationResult<string>> {
  const errors = validateJournalEntry(values);
  if (errors.length > 0) return { ok: false, reason: "invalid", message: errors[0] };
  if (values.projectDayId && !(await isOwnedProjectDay(supabase, projectId, values.projectDayId))) {
    return { ok: false, reason: "invalid", message: "journal-day-invalid" };
  }
  const { data, error } = await supabase.rpc("update_expedition_project_journal_if_current", { requested_project_id: projectId, requested_entry_id: entryId, expected_updated_at: values.expectedUpdatedAt, requested_title: values.title?.trim() || null, requested_body: values.body.trim(), requested_entry_date: values.entryDate, requested_project_day_id: values.projectDayId ?? null });
  if (error) return databaseFailure(error);
  const version = data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string,unknown>).updatedAt === "string" ? String((data as Record<string,unknown>).updatedAt) : "";
  return structuredResult(data, version);
}

export async function deleteJournalEntry(
  supabase: SupabaseClient,
  projectId: string,
  entryId: string,
){
  return deleteProjectJournalEntryWithMedia(supabase, projectId, entryId);
}

async function isOwnedProjectDay(supabase: SupabaseClient, projectId: string, projectDayId: string): Promise<boolean> {
  const { data, error } = await supabase.from("expedition_project_days").select("id")
    .eq("id", projectDayId).eq("project_id", projectId).maybeSingle();
  return !error && data !== null;
}
