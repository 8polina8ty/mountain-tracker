"use client";
import { useState, useCallback } from "react";
import PostComposer from "./PostComposer";
import CommunityFeed from "./CommunityFeed";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import Phase4Feed from "../Phase4Feed";

export default function CommunityFeedClient({ currentUserId }: { currentUserId: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [mode, setMode] = useState<"all" | "following" | "friends" | "discover">("all");
  const t = useTranslations("Social.Discover");
  const b = useTranslations("Social.Blog");
  const handleCreated = useCallback(() => {
    setRefreshKey((v) => v + 1);
  }, []);
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-3"><Link className="inline-flex min-h-11 items-center rounded-full border px-4" href="/community/blog/new">{b("write")}</Link><Link className="inline-flex min-h-11 items-center rounded-full border px-4" href="/community/discover">{t("exploreAuthors")}</Link><Link className="inline-flex min-h-11 items-center rounded-full border px-4" href="/community/blog">{b("directory")}</Link></nav>
      <PostComposer onCreated={handleCreated} />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("feeds")}>{(["all", "following", "friends", "discover"] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} className="min-h-11 rounded-full border px-4 aria-pressed:bg-[var(--color-surface-muted)]" onClick={() => setMode(value)}>{t(value)}</button>)}</div>
      {mode === "all" ? <CommunityFeed key={refreshKey} currentUserId={currentUserId} /> : <Phase4Feed key={`${mode}-${refreshKey}`} mode={mode} currentUserId={currentUserId} />}
    </div>
  );
}
