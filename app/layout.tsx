import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Header from "@/components/Header";
import { AchievementNotificationProvider } from "@/components/achievements/AchievementNotificationProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});
 

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
      
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AchievementNotificationProvider>
          <Header />

          {children}
        </AchievementNotificationProvider>
      </body>
    </html>
  );
}
