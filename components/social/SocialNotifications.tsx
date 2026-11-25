"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";
import { useSocialInbox } from "@/components/messages/SocialInboxProvider";

type Item = { id: string; notification_type: string; post_id: string | null; actor_user_id: string; actor_username: string; read_at: string | null; created_at: string };
const keys = { "social.user_followed": "followed", "social.post_liked": "liked", "social.post_commented": "commented", "social.mentioned_in_post": "mentioned", "social.mentioned_in_comment": "mentioned" } as const;
export default function SocialNotifications() {
  const t = useTranslations("Social.Notifications");
  const { refresh } = useSocialInbox();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<Item | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void createClient().rpc("list_social_notifications", { result_limit: 21 }).then(({ data, error }) => {
      if (!active) return;
      if (error) setError(true);
      else { const rows = (data ?? []) as Item[]; setItems(rows.slice(0, 20)); setCursor(rows.length > 20 ? rows[19] : null); }
      setBusy(false);
    });
    return () => { active = false; };
  }, []);
  async function more() {
    setBusy(true); setError(false);
    const { data, error } = await createClient().rpc("list_social_notifications", { result_limit: 21, cursor_created_at: cursor?.created_at ?? null, cursor_id: cursor?.id ?? null });
    if (error) setError(true);
    else { const rows = (data ?? []) as Item[]; setItems(prev => [...prev, ...rows.slice(0, 20)]); setCursor(rows.length > 20 ? rows[19] : null); }
    setBusy(false);
  }
  async function markRead(id: string) {
    const { error } = await createClient().rpc("mark_social_notification_read", { requested_notification_id: id });
    if (error) setError(true);
    else { setItems(prev => prev.map(item => item.id === id ? { ...item, read_at: new Date().toISOString() } : item)); await refresh(); }
  }
  return <section className="space-y-4"><h2 className="text-2xl font-bold">{t("title")}</h2>{items.map(item => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-[var(--color-surface)] p-4"><div><Link className="inline-flex min-h-11 items-center font-bold" href={`/users/${item.actor_user_id}`}>@{item.actor_username}</Link><p>{t(keys[item.notification_type as keyof typeof keys] ?? "mentioned")}</p>{item.post_id && <Link className="inline-flex min-h-11 items-center underline" href={`/community/posts/${item.post_id}`}>{t("open")}</Link>}</div>{!item.read_at && <button type="button" className="min-h-11 rounded-full border px-4" onClick={() => void markRead(item.id)}>{t("read")}</button>}</article>)}{busy && <p role="status">{t("loading")}</p>}{error && <p role="alert">{t("error")}</p>}{!busy && !error && !items.length && <p>{t("empty")}</p>}{(cursor || error) && <button className="min-h-11 rounded-full border px-4" disabled={busy} onClick={() => void more()}>{t("more")}</button>}</section>;
}
