import type { SupabaseClient } from "@supabase/supabase-js";

export async function createSocialPost(supabase: SupabaseClient, body: string, visibility: string, postType: string) {
  const { data, error } = await supabase.rpc("create_social_post", { requested_body: body, requested_visibility: visibility, requested_post_type: postType });
  if (error) throw error;
  return data as string;
}
export async function createSocialAscentPost(supabase: SupabaseClient, ascentId: number, body: string, visibility: string) {
  const { data, error } = await supabase.rpc("create_social_ascent_post", { requested_ascent_id: ascentId, requested_body: body, requested_visibility: visibility });
  if (error) throw error;
  return data as string;
}
export async function createSocialAchievementPost(supabase: SupabaseClient, achievementId: string, body: string, visibility: string) {
  const { data, error } = await supabase.rpc("create_social_achievement_post", { requested_achievement_id: achievementId, requested_body: body, requested_visibility: visibility });
  if (error) throw error;
  return data as string;
}
export async function createSocialExpeditionPost(supabase: SupabaseClient, projectId: string, body: string, visibility: string) {
  const { data, error } = await supabase.rpc("create_social_expedition_post", { requested_project_id: projectId, requested_body: body, requested_visibility: visibility });
  if (error) throw error;
  return data as string;
}

export async function updateSocialPost(supabase: SupabaseClient, postId: string, body: string, visibility: string) {
  const { error } = await supabase.rpc("update_social_post", { requested_post_id: postId, requested_body: body, requested_visibility: visibility });
  if (error) throw error;
}

export async function deleteSocialPost(supabase: SupabaseClient, postId: string) {
  const { error } = await supabase.rpc("delete_social_post", { requested_post_id: postId });
  if (error) throw error;
}

export async function likePost(supabase: SupabaseClient, postId: string) {
  const { error } = await supabase.rpc("like_social_post", { requested_post_id: postId });
  if (error) throw error;
}

export async function unlikePost(supabase: SupabaseClient, postId: string) {
  const { error } = await supabase.rpc("unlike_social_post", { requested_post_id: postId });
  if (error) throw error;
}

export async function addComment(supabase: SupabaseClient, postId: string, body: string) {
  const { data, error } = await supabase.rpc("create_social_post_comment", { requested_post_id: postId, requested_body: body });
  if (error) throw error;
  return data as string;
}

export async function removeComment(supabase: SupabaseClient, commentId: string) {
  const { error } = await supabase.rpc("delete_social_post_comment", { requested_comment_id: commentId });
  if (error) throw error;
}

export function buildSocialPostMediaPath(userId: string, postId: string, mediaId: string, ext: string) {
  return `${userId}/${postId}/${mediaId}.${ext}`;
}
export function extForMime(mime: string): string | null {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return null;
}
