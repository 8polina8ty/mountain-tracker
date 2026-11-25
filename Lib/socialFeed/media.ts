import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSocialPostMediaPath, extForMime } from "./mutations.ts";
import type { SocialPostMedia } from "./types.ts";

export async function uploadSocialMedia(supabase: SupabaseClient, userId: string, postId: string, file: File, position: number) {
  const ext = extForMime(file.type);
  if (!ext || file.size < 1 || file.size > 10 * 1024 * 1024 || position < 0 || position > 9) throw new Error("Invalid photo");
  const id = crypto.randomUUID();
  const path = buildSocialPostMediaPath(userId, postId, id, ext);
  const { error: uploadError } = await supabase.storage.from("social-post-media").upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;
  const { error } = await supabase.rpc("register_social_post_media", { requested_post_id: postId, requested_media_id: id, requested_mime: file.type, requested_size: file.size, requested_position: position });
  if (error) {
    await supabase.storage.from("social-post-media").remove([path]);
    throw error;
  }
  return { id, postId, authorId: userId, mimeType: file.type, sizeBytes: file.size, width: null, height: null, position } satisfies SocialPostMedia;
}

export async function removeSocialMedia(supabase: SupabaseClient, media: SocialPostMedia) {
  const { error } = await supabase.rpc("remove_social_post_media", { requested_post_id: media.postId, requested_media_id: media.id });
  if (error) throw error;
  const ext = extForMime(media.mimeType);
  if (ext) {
    const { error: storageError } = await supabase.storage.from("social-post-media").remove([buildSocialPostMediaPath(media.authorId, media.postId, media.id, ext)]);
    if (storageError) throw storageError;
  }
}
