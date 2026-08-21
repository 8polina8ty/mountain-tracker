import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { isLocale } from "@/i18n/locales";

type DatabaseTestLayoutProps = Readonly<{
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
    title: t("diagnosticTitle"),
    description: t("diagnosticDescription"),
    robots: { index: false, follow: false },
  };
}

export default function DatabaseTestLayout({
  children,
}: DatabaseTestLayoutProps) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return children;
}
