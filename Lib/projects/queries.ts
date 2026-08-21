import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeProjectDetail, normalizeProjectSummary } from "./normalization.ts";
import { logProjectMediaDisplayDiagnostic } from "./mediaDiagnostics.ts";
import { normalizeProjectPickerOption } from "./picker.ts";
import type { ExpeditionProject, ExpeditionProjectSummary, MountainId, ProjectDayTrackEvidence, ProjectPickerOption, ProjectTrackPickerOption } from "./types.ts";

const TRACK_FIELDS = `id, title, source_type, started_at, distance_m, duration_seconds, elevation_gain_m, processing_status, detected_mountain_id, detection_confidence, detection_status, gps_verified, geojson_url`;

function normalizeTrack(value: unknown): ProjectTrackPickerOption | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  if (!Number.isInteger(id) || typeof row.source_type !== "string" || typeof row.processing_status !== "string") return null;
  return {
    activityId: id,
    title: typeof row.title === "string" ? row.title : null,
    sourceType: row.source_type,
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    distanceM: typeof row.distance_m === "number" ? row.distance_m : null,
    durationSeconds: typeof row.duration_seconds === "number" ? row.duration_seconds : null,
    elevationGainM: typeof row.elevation_gain_m === "number" ? row.elevation_gain_m : null,
    processingStatus: row.processing_status,
    detectedMountainId: typeof row.detected_mountain_id === "number" ? row.detected_mountain_id : null,
    detectedMountainName: null,
    detectionConfidence: typeof row.detection_confidence === "number" ? row.detection_confidence : null,
    detectionStatus: typeof row.detection_status === "string" ? row.detection_status : null,
    gpsVerified: row.gps_verified === true,
    geoJsonPath: typeof row.geojson_url === "string" ? row.geojson_url : null,
  };
}

export async function listOwnedProjectTrackOptions(supabase: SupabaseClient, userId: string): Promise<ProjectTrackPickerOption[]> {
  const { data, error } = await supabase.from("gps_activities").select(TRACK_FIELDS).eq("user_id", userId).order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []).map(normalizeTrack).filter((track): track is ProjectTrackPickerOption => track !== null);
}

export async function listProjectDayTrackEvidence(supabase: SupabaseClient, userId: string, projectId: string): Promise<ProjectDayTrackEvidence[]> {
  void userId;
  const { data, error } = await supabase.from("expedition_project_day_tracks").select(`id, project_day_id, user_id, gps_activities!expedition_project_day_tracks_activity_owner_fk (${TRACK_FIELDS})`).eq("project_id", projectId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).flatMap((value) => {
    const row = value as unknown as Record<string, unknown>;
    const nested = Array.isArray(row.gps_activities) ? row.gps_activities[0] : row.gps_activities;
    const track = normalizeTrack(nested);
    return typeof row.id === "string" && typeof row.project_day_id === "string" && typeof row.user_id === "string" && track
      ? [{ ...track, relationId: row.id, projectDayId: row.project_day_id, userId: row.user_id }]
      : [];
  });
}

const PROJECT_MOUNTAIN_SELECT = `
  sort_order,
  mountains (id, name, name_de, height, latitude, longitude)
`;

const PROJECT_DETAIL_BASE_SELECT = `
  id, user_id, name, description, status, start_date, end_date, created_at, updated_at,
  expedition_project_mountains (${PROJECT_MOUNTAIN_SELECT}),
  expedition_project_days (
    id, project_id, day_number, date, title, notes, created_at, updated_at,
    expedition_project_day_mountains (mountain_id, sort_order)
  )
`;

const PROJECT_JOURNAL_ENTRY_SELECT = `
  id, project_id, user_id, project_day_id, entry_date, title, body, created_at, updated_at,
  expedition_project_journal_media (
    id, journal_entry_id, project_id, user_id, media_type, storage_path,
    original_filename, mime_type, size_bytes, width, height,
    duration_seconds, sort_order, created_at
  )
`;

export async function listProjectPickerOptions(
  supabase: SupabaseClient,
  userId: string,
  mountainId: MountainId,
): Promise<ProjectPickerOption[]> {
  const [{ data: owned, error: ownedError }, { data: memberships, error: membershipError }] = await Promise.all([
    supabase
    .from("expedition_projects")
    .select(`
      id, name, status, start_date, end_date,
      expedition_project_mountains (mountain_id)
    `)
    .eq("user_id", userId)
    .eq("expedition_project_mountains.mountain_id", mountainId)
    .order("updated_at", { ascending: false }),
    supabase.from("expedition_project_members").select("project_id").eq("user_id", userId).eq("role", "editor"),
  ]);
  if (ownedError || membershipError) throw ownedError ?? membershipError;
  const sharedIds = (memberships ?? []).map((row) => String(row.project_id));
  const { data: shared, error: sharedError } = sharedIds.length === 0 ? { data: [], error: null } : await supabase
    .from("expedition_projects")
    .select(`id, name, status, start_date, end_date, expedition_project_mountains (mountain_id)`)
    .in("id", sharedIds)
    .neq("status", "archived")
    .eq("expedition_project_mountains.mountain_id", mountainId)
    .order("updated_at", { ascending: false });
  if (sharedError) throw sharedError;
  return [...(owned ?? []), ...(shared ?? [])].map(normalizeProjectPickerOption).filter((project): project is ProjectPickerOption => project !== null);
}

export async function listUserProjects(
  supabase: SupabaseClient,
  userId: string,
): Promise<ExpeditionProjectSummary[]> {
  const { data, error } = await supabase
    .from("expedition_projects")
    .select(`
      id, user_id, name, description, status, start_date, end_date, created_at, updated_at,
      expedition_project_mountains (${PROJECT_MOUNTAIN_SELECT}),
      expedition_project_days (count),
      expedition_project_journal_entries (count)
    `)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(normalizeProjectSummary).filter((project): project is ExpeditionProjectSummary => project !== null);
}

function logProjectJournalGraph(rawProject: Record<string, unknown>, project: ExpeditionProject | null) {
  const rawEntries = Array.isArray(rawProject.expedition_project_journal_entries)
    ? rawProject.expedition_project_journal_entries
    : [];
  const rawNestedMediaCount = rawEntries.reduce((count, value) => {
    if (typeof value !== "object" || value === null) return count;
    const nestedMedia = (value as Record<string, unknown>).expedition_project_journal_media;
    return count + (Array.isArray(nestedMedia) ? nestedMedia.length : 0);
  }, 0);
  logProjectMediaDisplayDiagnostic("query", { rawNestedMediaCount });

  const normalizedMediaCount = project?.journalEntries.reduce((count, entry) => count + entry.media.length, 0) ?? 0;
  const journalEntriesWithMediaCount = project?.journalEntries.filter((entry) => entry.media.length > 0).length ?? 0;
  logProjectMediaDisplayDiagnostic("normalized", { normalizedMediaCount, journalEntriesWithMediaCount });
}

async function loadProjectDetailGraph(
  supabase: SupabaseClient,
  projectId: string,
  ownerId: string | null,
): Promise<ExpeditionProject | null> {
  let projectQuery = supabase
    .from("expedition_projects")
    .select(PROJECT_DETAIL_BASE_SELECT)
    .eq("id", projectId);
  if (ownerId) projectQuery = projectQuery.eq("user_id", ownerId);

  const journalQuery = supabase
    .from("expedition_project_journal_entries")
    .select(PROJECT_JOURNAL_ENTRY_SELECT)
    .eq("project_id", projectId)
    .order("entry_date", { ascending: false })
    .order("id", { ascending: false });

  const [projectResult, journalResult] = await Promise.all([
    projectQuery.maybeSingle(),
    journalQuery,
  ]);
  if (projectResult.error || journalResult.error) throw projectResult.error ?? journalResult.error;
  if (!projectResult.data) return null;

  const rawProject = {
    ...(projectResult.data as Record<string, unknown>),
    expedition_project_journal_entries: journalResult.data ?? [],
  };
  const project = normalizeProjectDetail(rawProject);
  logProjectJournalGraph(rawProject, project);
  return project;
}

export async function getUserProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<ExpeditionProject | null> {
  return loadProjectDetailGraph(supabase, projectId, userId);
}

export async function getAccessibleProject(supabase: SupabaseClient, projectId: string): Promise<ExpeditionProject | null> {
  return loadProjectDetailGraph(supabase, projectId, null);
}
