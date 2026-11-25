import { redirect } from "next/navigation";
import { RequestsClient } from "@/components/social/SocialListsClient";
import { createClient } from "@/Lib/supabase/server";
import { isLocale } from "@/i18n/locales";
import BackButton from "@/components/navigation/BackButton";
export default async function Page({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; if (!isLocale(locale)) redirect("/de/map"); const { data: { user } } = await (await createClient()).auth.getUser(); if (!user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent("/friends/requests")}`); return <main className="mx-auto max-w-3xl space-y-4 px-4 py-6"><BackButton fallback="/friends" /><RequestsClient /></main>; }
