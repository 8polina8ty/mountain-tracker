"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { safeAuthDestination } from "@/Lib/auth/redirects";

export default function GoogleAuthButton({ signup = false, disabled, onBusyChange }: {
  signup?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("Country");
  const locale = useLocale();
  const pending = useRef(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function continueWithGoogle() {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true); onBusyChange?.(true); setError(false);
    try {
      const returnTo = safeAuthDestination(new URLSearchParams(window.location.search).get("returnTo"), locale);
      const callback = new URL(`/${locale}/auth/callback`, window.location.origin);
      callback.searchParams.set("returnTo", returnTo);
      const { error: authError } = await createClient().auth.signInWithOAuth({
        provider: "google", options: { redirectTo: callback.toString() },
      });
      if (authError) throw new Error("oauth_failed");
      // Keep the button locked until the browser leaves this page.
    } catch {
      pending.current = false; setBusy(false); onBusyChange?.(false); setError(true);
    }
  }
  return <div className="space-y-2">
    <button type="button" onClick={continueWithGoogle} disabled={disabled || busy} aria-busy={busy}
      className="ui-pressable flex min-h-12 w-full items-center justify-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-3.5 text-[14px] font-semibold shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:shadow-[var(--shadow-control)] active:translate-y-px active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-60">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
        <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.3 2.98-7.36Z" />
        <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.97-3.38.97-2.6 0-4.81-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z" />
        <path fill="#FBBC05" d="M6.4 13.93a6 6 0 0 1 0-3.86V7.48H3.05a10 10 0 0 0 0 9.04l3.35-2.59Z" />
        <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.5 3.82 1.5l2.86-2.86A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.48l3.35 2.59c.79-2.36 3-4.12 5.6-4.12Z" />
      </svg>
      {t(signup ? "googleSignup" : "googleLogin")}
    </button>
    {error && <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{t("oauthError")}</p>}
  </div>;
}
