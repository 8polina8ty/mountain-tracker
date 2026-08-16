import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";

import "../globals.css";
import Header from "@/components/Header";
import MotionProvider from "@/components/MotionProvider";
import { AchievementNotificationProvider } from "@/components/achievements/AchievementNotificationProvider";
import { SocialInboxProvider } from "@/components/messages/SocialInboxProvider";
import { isLocale, locales, type Locale } from "@/i18n/locales";
import { getOpenGraphLocale, getSiteOrigin } from "@/i18n/seo";

type RootLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: requestedLocale } = await params;

  if (!isLocale(requestedLocale)) {
    notFound();
  }

  const locale: Locale = requestedLocale;
  const t = await getTranslations({ locale, namespace: "Metadata.Site" });
  const origin = getSiteOrigin();

  return {
    metadataBase: origin ? new URL(origin) : undefined,
    title: t("title"),
    description: t("description"),
    openGraph: {
      title: t("title"),
      description: t("description"),
      locale: getOpenGraphLocale(locale),
      siteName: "Mountain Tracker",
      type: "website",
    },
  };
}

export default async function RootLayout({
  children,
  params,
}: RootLayoutProps) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();
  const t = await getTranslations("Accessibility");

  return (
    <html lang={locale}>
      <head>
        <meta
          name="format-detection"
          content="telephone=no, date=no, email=no, address=no"
        />
      </head>

      <body className="antialiased">
        <a
          href="#main-content"
          className="fixed left-3 top-3 z-[200] -translate-y-20 rounded-[var(--radius-control)] bg-[var(--color-surface-inverse)] px-4 py-2 font-semibold text-[var(--color-text-inverse)] shadow-[var(--shadow-panel)] transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus:translate-y-0"
        >
          {t("skipToContent")}
        </a>

        <NextIntlClientProvider messages={messages}>
          <MotionProvider>
            <AchievementNotificationProvider>
              <SocialInboxProvider>
                <Header />

                <div id="main-content" tabIndex={-1} className="outline-none">
                  {children}
                </div>
              </SocialInboxProvider>
            </AchievementNotificationProvider>
          </MotionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}