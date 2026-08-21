import "server-only";

import { notFound, redirect } from "next/navigation";

import { createClient } from "@/Lib/supabase/server";
import type { Locale } from "@/i18n/locales";
import { getProjectAccessRole } from "./collaboration.ts";

export async function requireProjectUser(locale: Locale, returnTo: string) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return { supabase, user };
}

export async function requireProjectAccess(locale: Locale, returnTo: string, projectId: string) {
  const { supabase, user } = await requireProjectUser(locale, returnTo);
  const role = await getProjectAccessRole(supabase, projectId);
  if (role === "none") notFound();
  return { supabase, user, role };
}
