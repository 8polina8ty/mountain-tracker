import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectShareState = { slug: string; enabled: boolean } | null;

function createPublicSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function enableProjectSharing(supabase: SupabaseClient, projectId: string) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false as const };
  const { data: project } = await supabase.from("expedition_projects").select("id,status").eq("id", projectId).eq("user_id", auth.user.id).in("status", ["completed", "archived"]).maybeSingle();
  if (!project) return { ok: false as const };
  const { data: existing } = await supabase.from("expedition_project_shares").select("public_slug").eq("project_id", projectId).eq("user_id", auth.user.id).maybeSingle();
  const slug = (existing as { public_slug?: string } | null)?.public_slug ?? createPublicSlug();
  const { error } = await supabase.from("expedition_project_shares").upsert({ project_id: projectId, user_id: auth.user.id, public_slug: slug, is_enabled: true, updated_at: new Date().toISOString() }, { onConflict: "project_id" });
  return error ? { ok: false as const } : { ok: true as const, slug };
}

export async function disableProjectSharing(supabase: SupabaseClient, projectId: string) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false as const };
  const { error } = await supabase.from("expedition_project_shares").update({ is_enabled: false, updated_at: new Date().toISOString() }).eq("project_id", projectId).eq("user_id", auth.user.id);
  return { ok: !error } as const;
}
