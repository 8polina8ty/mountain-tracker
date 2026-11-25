import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSocialPost } from "./normalize.ts";
import type { SocialFeedCursor, SocialFeedPage, SocialPost } from "./types.ts";

export type FeedMode = "all" | "friends" | "following" | "discover" | "blog" | "activity" | "owner" | "profile";
export const SOCIAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseDiscoverySearch(input: Record<string, string | string[] | undefined>) {
  const value = (key: string) => typeof input[key] === "string" ? input[key] as string : "";
  const date = value("date");
  const id = value("after");
  return {
    q: value("q").trim().slice(0, 80),
    sort: value("sort") === "oldest" ? "oldest" as const : "newest" as const,
    cursor: SOCIAL_UUID.test(id) && Number.isFinite(Date.parse(date)) ? { createdAt: date, postId: id } : null,
  };
}
export async function listPhase4Posts(supabase: SupabaseClient, mode: FeedMode, options: { userId?: string; q?: string; sort?: "newest" | "oldest"; cursor?: SocialFeedCursor } = {}): Promise<SocialFeedPage> {
  const { data, error } = await supabase.rpc("list_social_feed_phase4", {
    requested_mode: mode, requested_user_id: options.userId ?? null,
    search_text: (options.q ?? "").trim().slice(0, 80), sort_mode: options.sort ?? "newest",
    cursor_created_at: options.cursor?.createdAt ?? null, cursor_post_id: options.cursor?.postId ?? null, result_limit: 21,
  });
  if (error) throw error;
  const rows: unknown[] = Array.isArray(data) ? data : [];
  const posts = rows.slice(0, 20).map(normalizeSocialPost).filter((p): p is SocialPost => p !== null);
  const last = posts.at(-1);
  return { posts, nextCursor: rows.length > 20 && last ? { createdAt: last.createdAt, postId: last.id } : null };
}
