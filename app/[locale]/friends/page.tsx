import { redirect } from "next/navigation";
import FriendsClient from "@/components/social/FriendsClient";
import { createClient } from "@/Lib/supabase/server";
import { isLocale } from "@/i18n/locales";

export default async function FriendsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params; if (!isLocale(locale)) redirect("/de/map");
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) redirect(`/${locale}/auth/login?returnTo=${encodeURIComponent("/friends")}`);
  return <FriendsClient />;
}
