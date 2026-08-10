import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import MotionProvider from "@/components/MotionProvider";
import { AchievementNotificationProvider } from "@/components/achievements/AchievementNotificationProvider";

export const metadata: Metadata = {
  title: "Mountain Tracker",
  description: "Track your mountain summits",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
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
          К основному содержимому
        </a>

        <MotionProvider>
          <AchievementNotificationProvider>
            <Header />

            <div id="main-content" tabIndex={-1} className="outline-none">
              {children}
            </div>
          </AchievementNotificationProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
