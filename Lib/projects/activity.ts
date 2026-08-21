import type { SupabaseClient } from "@supabase/supabase-js";

import { PROJECT_ACTIVITY_ACTIONS, type ProjectActivityCursor, type ProjectActivityItem, type ProjectActivityPage } from "./types.ts";

export const PROJECT_ACTIVITY_PAGE_SIZE = 12;

export async function listProjectActivity(
  supabase: SupabaseClient,
  projectId: string,
  cursor: ProjectActivityCursor | null = null,
  limit = PROJECT_ACTIVITY_PAGE_SIZE,
): Promise<ProjectActivityPage> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 30);
  let query = supabase.from("expedition_project_activity")
    .select("id,actor_user_id,action_type,resource_type,metadata,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(boundedLimit + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw error;
  const pageRows = (data ?? []).slice(0, boundedLimit);
  const actorIds = [...new Set(pageRows.flatMap((row) => typeof row.actor_user_id === "string" ? [row.actor_user_id] : []))];
  const { data: profiles, error: profileError } = actorIds.length === 0
    ? { data: [], error: null }
    : await supabase.from("profiles").select("id,username,display_name,avatar_url").in("id", actorIds);
  if (profileError) throw profileError;
  const profileById = new Map((profiles ?? []).map((profile) => [String(profile.id), profile]));
  const items = pageRows.flatMap((row): ProjectActivityItem[] => {
    if (typeof row.id !== "string" || typeof row.actor_user_id !== "string" || typeof row.action_type !== "string" ||
      !PROJECT_ACTIVITY_ACTIONS.includes(row.action_type as ProjectActivityItem["actionType"]) || typeof row.resource_type !== "string" || typeof row.created_at !== "string") return [];
    const profile = profileById.get(row.actor_user_id);
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as ProjectActivityItem["metadata"] : {};
    return [{ id: row.id, actorUserId: row.actor_user_id, actorName: typeof profile?.display_name === "string" ? profile.display_name : null,
      actorUsername: typeof profile?.username === "string" ? profile.username : null, actorAvatarUrl: typeof profile?.avatar_url === "string" ? profile.avatar_url : null,
      actionType: row.action_type as ProjectActivityItem["actionType"], resourceType: row.resource_type as ProjectActivityItem["resourceType"], metadata, createdAt: row.created_at }];
  });
  const last = items.at(-1);
  return { items, nextCursor: (data?.length ?? 0) > boundedLimit && last ? { createdAt: last.createdAt, id: last.id } : null };
}
