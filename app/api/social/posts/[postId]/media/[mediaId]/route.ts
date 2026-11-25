import { createClient } from "@/Lib/supabase/server";
import { createAdminClient } from "@/Lib/supabase/admin";

export async function GET(_request: Request, { params }: { params: Promise<{ postId: string; mediaId: string }> }) {
  const { postId, mediaId } = await params;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(postId) || !uuid.test(mediaId)) return new Response(null, { status: 404 });
  const supabase = await createClient();
  await supabase.auth.getUser();
  // Authorize with the caller's session before crossing the Storage service boundary.
  const { data: post, error: visibilityError } = await supabase.rpc("get_social_post_phase4", { requested_post_id: postId });
  if (visibilityError || !post || !Array.isArray(post.media) || !post.media.some((m: { id: string }) => m.id === mediaId)) return new Response(null, { status: 404 });
  const admin = createAdminClient();
  const { data: media, error: mediaError } = await admin.from("social_post_media").select("post_id,storage_path,mime_type,size_bytes").eq("id", mediaId).eq("post_id", postId).maybeSingle();
  if (mediaError || !media) return new Response(null, { status: 404 });
  const mime = String((media as Record<string, unknown>).mime_type);
  if (!["image/jpeg","image/png","image/webp"].includes(mime)) return new Response(null, { status: 404 });
  const size = Number((media as Record<string, unknown>).size_bytes);
  if (!Number.isFinite(size) || size < 1 || size > 10 * 1024 * 1024) return new Response(null, { status: 404 });
  const path = String((media as Record<string, unknown>).storage_path);
  const { data: blob, error } = await admin.storage.from("social-post-media").download(path);
  if (error || !blob || blob.size !== size) return new Response(null, { status: 404 });
  return new Response(blob.stream(), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(blob.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
