import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
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
        <AchievementNotificationProvider>
          <Header />

          {children}
        </AchievementNotificationProvider>
      </body>
    </html>
  );
}
