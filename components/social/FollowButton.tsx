"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { createClient } from "@/Lib/supabase/client";

export default function FollowButton({ userId, currentUserId, initialFollowing = false, unavailable = false, onChanged }: { userId: string; currentUserId: string | null; initialFollowing?: boolean; unavailable?: boolean; onChanged?: () => void }) {
  const t = useTranslations("Social.Follow");
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (userId === currentUserId) return null;
  if (!currentUserId) return <Link href="/auth/login" className="ui-pressable inline-flex min-h-11 items-center rounded-full border px-4">{t("login")}</Link>;
  async function toggle() {
    if (busy || unavailable) return;
    setBusy(true); setError(false);
    try {
      const { error } = await createClient().rpc(following ? "unfollow_social_user" : "follow_social_user", { requested_user_id: userId });
      if (error) throw error;
      setFollowing(!following); onChanged?.();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div><button type="button" onClick={toggle} disabled={busy || unavailable} aria-pressed={following} aria-label={following ? t("unfollow") : t("follow")} className="ui-pressable group min-h-11 rounded-full border px-4 font-semibold disabled:opacity-50">{unavailable ? t("unavailable") : busy ? t("loading") : following ? <><span className="group-hover:hidden group-focus-visible:hidden">{t("following")}</span><span className="hidden group-hover:inline group-focus-visible:inline">{t("unfollow")}</span></> : t("follow")}</button>{error && <p role="alert" className="text-sm text-[var(--color-danger)]">{t("error")}</p>}</div>;
}
