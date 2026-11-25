"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";
import FollowButton from "./FollowButton";

type Summary = { followersCount: number; followingCount: number; isFollowing: boolean };
type Row = { user_id: string; username: string; created_at: string };
export default function FollowSummary({ userId, currentUserId }: { userId: string; currentUserId: string | null }) {
  const t = useTranslations("Social.Follow");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<"followers" | "following" | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(true);
  useEffect(() => {
    let active = true;
    void createClient().rpc("get_social_follow_summary", { requested_user_id: userId }).then(({ data, error }) => {
      if (active) { setSummary(error ? null : data); setError(Boolean(error)); setLoadingSummary(false); }
    });
    return () => { active = false; };
  }, [userId, revision]);
  async function load(nextMode: "followers" | "following", more = false) {
    setBusy(true); setError(false);
    const next = more ? cursor : null;
    const { data, error } = await createClient().rpc(`list_social_${nextMode}`, { requested_user_id: userId, cursor_created_at: next?.created_at ?? null, cursor_user_id: next?.user_id ?? null, result_limit: 21 });
    if (error) setError(true);
    else { const page = (data ?? []) as Row[]; setRows(prev => more ? [...prev, ...page.slice(0, 20)] : page.slice(0, 20)); setCursor(page.length > 20 ? page[19] : null); setMode(nextMode); }
    setBusy(false);
  }
  return <section className="space-y-3" aria-label={t("followers")}>
    {loadingSummary && <p role="status">{t("loading")}</p>}
    {!loadingSummary && !summary && !error && <p>{t("unavailable")}</p>}
    {summary && <div className="flex flex-wrap items-center gap-3">
      <FollowButton key={`${userId}-${summary.isFollowing}`} userId={userId} currentUserId={currentUserId} initialFollowing={summary.isFollowing} onChanged={() => { setRevision(v => v + 1); setMode(null); }} />
      {(["followers", "following"] as const).map(kind => <button key={kind} type="button" disabled={!currentUserId || busy} onClick={() => void load(kind)} className="min-h-11 rounded-full border px-4">{t(kind === "followers" ? "followers" : "followingCount")} · {kind === "followers" ? summary.followersCount : summary.followingCount}</button>)}
    </div>}
    {error && <p role="alert">{t("error")}</p>}
    {mode && <div className="rounded-xl border p-3"><button type="button" onClick={() => setMode(null)} className="min-h-11 px-3">{t("close")}</button><ul>{rows.map(row => <li key={row.user_id}><Link className="inline-flex min-h-11 items-center" href={`/users/${row.user_id}`}>@{row.username}</Link></li>)}</ul>{!rows.length && <p>{t("empty")}</p>}{cursor && <button type="button" className="min-h-11 px-3" disabled={busy} onClick={() => void load(mode, true)}>{t("more")}</button>}</div>}
  </section>;
}
