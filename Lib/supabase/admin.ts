import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;

export function getSupabaseAdminCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) throw new Error("Server Supabase administration is not configured.");
  return { url, secret };
}

export function createAdminClient() {
  if (adminClient) return adminClient;
  const { url, secret } = getSupabaseAdminCredentials();
  adminClient = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  return adminClient;
}
