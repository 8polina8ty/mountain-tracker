import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/Lib/supabase/server";
import { normalizeSocialPost } from "@/Lib/socialFeed/normalize";
import { SOCIAL_UUID } from "@/Lib/socialFeed/phase4";
import PostCard from "@/components/social/feed/PostCard";
import BackButton from "@/components/navigation/BackButton";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function DirectPost({ params }: { params: Promise<{ locale: string; postId: string }> }) {
  const { locale, postId } = await params;
  if (!SOCIAL_UUID.test(postId)) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_social_post_phase4", { requested_post_id: postId });
  if (error) throw error;
  const post = normalizeSocialPost(data);
  if (!post) notFound();
  if (post.postType === "blog") redirect(`/${locale}/community/blog/${post.id}${post.publishedAt ? "" : "/edit"}`);
  const { data: { user } } = await supabase.auth.getUser();
  return <main className="mx-auto max-w-3xl space-y-4 px-4 py-8"><BackButton fallback="/community" /><PostCard post={post} currentUserId={user?.id ?? null} /></main>;
}
