import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { isLocale } from "@/i18n/locales";

type AuthLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }
  const t = await getTranslations({ locale, namespace: "Metadata.NoIndex" });

  return {
    title: t("authTitle"),
    description: t("authDescription"),
    robots: { index: false, follow: false },
  };
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return children;
}
