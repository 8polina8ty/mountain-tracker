import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectShareState = { slug: string; enabled: boolean } | null;

export async function canEnableProjectSharing(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase.rpc("can_enable_expedition_sharing", {
    target_project_id: projectId,
  });
  return error || typeof data !== "boolean" ? null : data;
}

function createPublicSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function enableProjectSharing(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase.rpc("set_expedition_sharing", {
    target_project_id: projectId,
    enable_sharing: true,
    proposed_slug: createPublicSlug(),
  });
  if (error || data?.enabled !== true || typeof data.slug !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(data.slug)) {
    return { ok: false as const };
  }
  return { ok: true as const, slug: data.slug };
}

export async function disableProjectSharing(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase.rpc("set_expedition_sharing", {
    target_project_id: projectId,
    enable_sharing: false,
  });
  return { ok: !error && data?.enabled === false };
}
