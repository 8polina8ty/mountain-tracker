"use client";
import { useTranslations } from "next-intl";
import Phase4Feed from "../Phase4Feed";
export default function ProfileBlog({ userId, currentUserId }: { userId: string; currentUserId: string | null }) {
  const t = useTranslations("Social.Blog");
  return <section className="mt-6 space-y-4"><h2 className="text-2xl font-bold">{t("directory")}</h2><Phase4Feed key={userId} mode="discover" userId={userId} currentUserId={currentUserId} /></section>;
}
