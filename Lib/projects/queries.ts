import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeJournalEntry, normalizeProjectDetail, normalizeProjectSummary } from "./normalization.ts";
import { logProjectMediaDisplayDiagnostic } from "./mediaDiagnostics.ts";
import { normalizeProjectPickerOption } from "./picker.ts";
import type {
  ExpeditionProject,
  ExpeditionProjectSummary,
  MountainId,
  ProjectDayTrackEvidence,
  ProjectJournalCursor,
  ProjectJournalPage,
  ProjectJournalScopeStats,
  ProjectJournalWorkspaceStats,
  ProjectPickerOption,
  ProjectTrackPickerOption,
  ProjectWorkspaceLoad,
} from "./types.ts";

const TRACK_FIELDS = `id, title, source_type, started_at, distance_m, duration_seconds, elevation_gain_m, processing_status, detected_mountain_id, detection_confidence, detection_status, gps_verified, geojson_url`;

export const PROJECT_JOURNAL_INITIAL_PAGE_SIZE = 40;
export const PROJECT_JOURNAL_PAGE_SIZE = 20;

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

const emptyScopeStats = (): ProjectJournalScopeStats => ({ entryCount: 0, mediaCount: 0, photoCount: 0, videoCount: 0 });

function incrementScopeStats(stats: ProjectJournalScopeStats, mediaTypes: unknown[]) {
  stats.entryCount += 1;
  for (const media of mediaTypes) {
    if (!media || typeof media !== "object") continue;
    const mediaType = (media as Record<string, unknown>).media_type;
    if (mediaType !== "photo" && mediaType !== "video") continue;
    stats.mediaCount += 1;
    if (mediaType === "photo") stats.photoCount += 1;
    else stats.videoCount += 1;
  }
}

function journalCursorFromRow(value: unknown): ProjectJournalCursor | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.entry_date === "string" && typeof row.id === "string"
    ? { entryDate: row.entry_date, id: row.id }
    : null;
}

export async function listProjectJournalStats(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ProjectJournalWorkspaceStats> {
  const { data, error } = await supabase
    .from("expedition_project_journal_entries")
    .select("project_day_id, expedition_project_journal_media (media_type)")
    .eq("project_id", projectId);
  if (error) throw error;

  const total = emptyScopeStats();
  const project = emptyScopeStats();
  const days: Record<string, ProjectJournalScopeStats> = {};
  for (const value of data ?? []) {
    const row = value as unknown as Record<string, unknown>;
    const media = Array.isArray(row.expedition_project_journal_media) ? row.expedition_project_journal_media : [];
    incrementScopeStats(total, media);
    if (typeof row.project_day_id === "string") {
      const stats = days[row.project_day_id] ?? emptyScopeStats();
      incrementScopeStats(stats, media);
      days[row.project_day_id] = stats;
    } else if (row.project_day_id === null) {
      incrementScopeStats(project, media);
    }
  }
  return { total, project, days };
}

export async function listProjectJournalPage(
  supabase: SupabaseClient,
  projectId: string,
  projectDayId: string | null,
  cursor: ProjectJournalCursor | null,
  limit = PROJECT_JOURNAL_PAGE_SIZE,
): Promise<ProjectJournalPage> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  let query = supabase
    .from("expedition_project_journal_entries")
    .select(PROJECT_JOURNAL_ENTRY_SELECT)
    .eq("project_id", projectId)
    .order("entry_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(boundedLimit + 1);
  query = projectDayId === null
    ? query.is("project_day_id", null)
    : query.eq("project_day_id", projectDayId);
  if (cursor) {
    query = query.or(`entry_date.lt.${cursor.entryDate},and(entry_date.eq.${cursor.entryDate},id.lt.${cursor.id})`);
  }

  const { data, error } = await query;
  if (error) throw error;
  const pageRows = (data ?? []).slice(0, boundedLimit);
  const entries = pageRows.map(normalizeJournalEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const lastRow = pageRows.at(-1);
  return {
    entries,
    nextCursor: (data?.length ?? 0) > boundedLimit && lastRow ? journalCursorFromRow(lastRow) : null,
  };
}

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

function baseProjectQuery(supabase: SupabaseClient, projectId: string, ownerId: string | null) {
  let query = supabase
    .from("expedition_projects")
    .select(PROJECT_DETAIL_BASE_SELECT)
    .eq("id", projectId);
  if (ownerId) query = query.eq("user_id", ownerId);
  return query;
}

async function loadProjectDetailGraph(
  supabase: SupabaseClient,
  projectId: string,
  ownerId: string | null,
): Promise<ExpeditionProject | null> {
  const journalQuery = supabase
    .from("expedition_project_journal_entries")
    .select(PROJECT_JOURNAL_ENTRY_SELECT)
    .eq("project_id", projectId)
    .order("entry_date", { ascending: false })
    .order("id", { ascending: false });

  const [projectResult, journalResult] = await Promise.all([
    baseProjectQuery(supabase, projectId, ownerId).maybeSingle(),
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

export async function getAccessibleProjectWorkspace(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ProjectWorkspaceLoad | null> {
  const journalQuery = supabase
    .from("expedition_project_journal_entries")
    .select(PROJECT_JOURNAL_ENTRY_SELECT)
    .eq("project_id", projectId)
    .order("entry_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(PROJECT_JOURNAL_INITIAL_PAGE_SIZE + 1);

  const [projectResult, journalResult, journalStats] = await Promise.all([
    baseProjectQuery(supabase, projectId, null).maybeSingle(),
    journalQuery,
    listProjectJournalStats(supabase, projectId),
  ]);
  if (projectResult.error || journalResult.error) throw projectResult.error ?? journalResult.error;
  if (!projectResult.data) return null;

  const pageRows = (journalResult.data ?? []).slice(0, PROJECT_JOURNAL_INITIAL_PAGE_SIZE);
  const rawProject = {
    ...(projectResult.data as Record<string, unknown>),
    expedition_project_journal_entries: pageRows,
  };
  const project = normalizeProjectDetail(rawProject);
  if (!project) return null;
  logProjectJournalGraph(rawProject, project);
  const lastRow = pageRows.at(-1);
  return {
    project,
    journalCursor: (journalResult.data?.length ?? 0) > PROJECT_JOURNAL_INITIAL_PAGE_SIZE && lastRow
      ? journalCursorFromRow(lastRow)
      : null,
    journalStats,
  };
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
