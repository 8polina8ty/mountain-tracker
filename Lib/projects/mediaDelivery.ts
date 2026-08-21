import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { EXPEDITION_MEDIA_BUCKET } from "./mediaPaths.ts";
import { logProjectMediaDisplayDiagnostic } from "./mediaDiagnostics.ts";
import type { ProjectJournalMedia, ProjectJournalMediaDelivery } from "./types.ts";

export const PROJECT_JOURNAL_MEDIA_SIGNED_URL_SECONDS = 60 * 60;

export async function createProjectJournalMediaDeliveries(
  supabase: SupabaseClient,
  ownedMedia: readonly ProjectJournalMedia[],
): Promise<ProjectJournalMediaDelivery[]> {
  const paths = [...new Set(ownedMedia.map((media) => media.storagePath))];
  const pathsRequestedForSigning = paths.length;
  if (paths.length === 0) {
    logProjectMediaDisplayDiagnostic("delivery", {
      pathsRequestedForSigning,
      signedDeliveryCount: 0,
      signedUnavailableCount: 0,
    });
    return [];
  }
  const { data, error } = await supabase.storage
    .from(EXPEDITION_MEDIA_BUCKET)
    .createSignedUrls(paths, PROJECT_JOURNAL_MEDIA_SIGNED_URL_SECONDS);
  const urls = new Map<string, string>();
  if (!error) {
    for (const item of data) {
      if (!item.error && item.path && item.signedUrl) urls.set(item.path, item.signedUrl);
    }
  }
  const deliveries: ProjectJournalMediaDelivery[] = ownedMedia.map((media) => {
    const signedUrl = urls.get(media.storagePath) ?? null;
    return { ...media, signedUrl, deliveryState: signedUrl ? "ready" : "unavailable" };
  });
  const signedDeliveryCount = deliveries.filter((delivery) => delivery.deliveryState === "ready").length;
  logProjectMediaDisplayDiagnostic("delivery", {
    pathsRequestedForSigning,
    signedDeliveryCount,
    signedUnavailableCount: deliveries.length - signedDeliveryCount,
  });
  return deliveries;
}
