import "server-only";

import { notFound } from "next/navigation";

import { createClient } from "@/Lib/supabase/server";
import { evaluatePreviewAccess } from "./access-policy";

export async function requireOsmStagingPreviewAccess(): Promise<{ userId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const decision = evaluatePreviewAccess({
    nodeEnv: process.env.NODE_ENV,
    enabled: process.env.OSM_STAGING_PREVIEW_ENABLED,
    allowedUserIds: process.env.OSM_STAGING_PREVIEW_USER_IDS,
    authenticatedUserId: user?.id ?? null,
  });
  if (!decision.allowed || !user) notFound();
  return { userId: user.id };
}
