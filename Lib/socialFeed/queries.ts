import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSocialComment, normalizeSocialPost } from "./normalize.ts";
import type { SocialFeedPage } from "./types.ts";

export async function listSocialFeed(supabase: SupabaseClient, cursor: { createdAt: string; postId: string } | null, limit = 20): Promise<SocialFeedPage> {
  const bounded = Math.min(Math.max(limit, 1), 50);
  const { data, error } = await supabase.rpc("list_social_feed", {
    cursor_created_at: cursor?.createdAt ?? null,
    cursor_post_id: cursor?.postId ?? null,
    result_limit: bounded + 1,
  });
  if (error) throw error;
  const rows = (data ?? []) as unknown[];
  const posts = rows.slice(0, bounded).map(normalizeSocialPost).filter((p): p is NonNullable<typeof p> => p !== null);
  const hasMore = rows.length > bounded;
  const last = posts.at(-1);
  return { posts, nextCursor: hasMore && last ? { createdAt: last.createdAt, postId: last.id } : null };
}

export async function listUserPosts(supabase: SupabaseClient, userId: string, cursor: { createdAt: string; postId: string } | null, limit = 20): Promise<SocialFeedPage> {
  const bounded = Math.min(Math.max(limit, 1), 50);
  const { data, error } = await supabase.rpc("list_user_social_posts", {
    requested_user_id: userId,
    cursor_created_at: cursor?.createdAt ?? null,
    cursor_post_id: cursor?.postId ?? null,
    result_limit: bounded + 1,
  });
  if (error) throw error;
  const rows = (data ?? []) as unknown[];
  const posts = rows.slice(0, bounded).map(normalizeSocialPost).filter((p): p is NonNullable<typeof p> => p !== null);
  const hasMore = rows.length > bounded;
  const last = posts.at(-1);
  return { posts, nextCursor: hasMore && last ? { createdAt: last.createdAt, postId: last.id } : null };
}

export async function getSocialPostMedia(supabase: SupabaseClient, postId: string) {
  const { data, error } = await supabase.from("social_post_media").select("id,post_id,author_id,mime_type,size_bytes,width,height,position").eq("post_id", postId).order("position");
  if (error) throw error;
  return data;
}

export async function listPostComments(supabase: SupabaseClient, postId: string, limit = 5) {
  const { data, error } = await supabase.rpc("list_social_post_comments", { requested_post_id: postId, result_limit: limit });
  if (error) throw error;
  return (data ?? []).map(normalizeSocialComment).filter((c: unknown): c is NonNullable<ReturnType<typeof normalizeSocialComment>> => c !== null);
}
