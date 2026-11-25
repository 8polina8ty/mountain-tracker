import "server-only";
import { cache } from "react";
import { createClient } from "@/Lib/supabase/server";
import { normalizeSocialPost } from "./normalize";
import { SOCIAL_UUID } from "./phase4";

// Request-local memoization only: never cache a viewer's access across requests.
export const getPublicBlog = cache(async (postId: string) => {
  if (!SOCIAL_UUID.test(postId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_social_blog", { requested_post_id: postId });
  if (error) throw error;
  const post = normalizeSocialPost(data);
  return post?.postType === "blog" && post.visibility === "public" && post.publishedAt ? post : null;
});
