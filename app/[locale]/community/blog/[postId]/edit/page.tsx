import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/Lib/supabase/server";
import { SOCIAL_UUID } from "@/Lib/socialFeed/phase4";
import { normalizeSocialPost } from "@/Lib/socialFeed/normalize";
import BlogEditor from "@/components/social/blog/BlogEditor";
import BackButton from "@/components/navigation/BackButton";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function EditBlog({ params }: { params: Promise<{ locale: string; postId: string }> }) {
  const { locale, postId } = await params;
  if (!SOCIAL_UUID.test(postId)) notFound();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent(`/community/blog/${postId}/edit`)}`);
  const { data, error } = await supabase.rpc("get_social_post_phase4", { requested_post_id: postId });
  if (error) throw error;
  const post = normalizeSocialPost(data);
  if (!post || post.postType !== "blog" || post.author.userId !== user.id) notFound();
  return <main className="mx-auto max-w-3xl space-y-4 px-4 py-8"><BackButton fallback={`/community/blog/${postId}`} /><BlogEditor initial={post} currentUserId={user.id} /></main>;
}
