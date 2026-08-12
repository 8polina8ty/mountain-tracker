import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/i18n/locales";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params; if (!isLocale(locale)) notFound(); const t = await getTranslations({ locale, namespace: "Social.Messages" });
  return { title: t("title"), robots: { index: false, follow: false } };
}
export default function MessagesLayout({ children }: { children: React.ReactNode }) { return children; }
