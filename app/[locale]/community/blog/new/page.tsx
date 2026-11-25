import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/Lib/supabase/server";
import BlogEditor from "@/components/social/blog/BlogEditor";
import BackButton from "@/components/navigation/BackButton";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default async function NewBlog({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent("/community/blog/new")}`);
  return <main className="mx-auto max-w-3xl space-y-4 px-4 py-8"><BackButton fallback="/community/blog" /><BlogEditor currentUserId={user.id} /></main>;
}
