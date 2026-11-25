"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import CountrySelect from "./CountrySelect";
import { changeResidenceCountry, completeProfile } from "@/Lib/auth/actions";
import { validateProfileInput } from "@/Lib/auth/profile";
import { isCountryCode } from "@/Lib/countries";

export default function ProfileForm({ mode, initialUsername = "", initialCountry = "", returnTo, initialError = "" }: {
  mode: "onboarding" | "country"; initialUsername?: string; initialCountry?: string;
  returnTo?: string; initialError?: string;
}) {
  const t = useTranslations("Country");
  const usernameT = useTranslations("Auth.signUpPage.errors");
  const locale = useLocale();
  const router = useRouter();
  const [username, setUsername] = useState(initialUsername);
  const [country, setCountry] = useState(initialCountry);
  const [error, setError] = useState(initialError);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const errorText = error ? (/^username(Required|TooShort|TooLong|InvalidChars|InvalidEdges)$/.test(error) ? usernameT(error) : t(error)) : "";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const invalid = mode === "onboarding" ? validateProfileInput(username, country) : isCountryCode(country) ? null : "countryRequired";
    if (invalid) { setError(invalid); return; }
    pending.current = true; setBusy(true); setError(""); setSaved(false);
    try {
      if (mode === "onboarding") {
        const result = await completeProfile({ username, country, locale, returnTo });
        if (result.error) setError(result.error);
        else if (result.destination) { window.location.assign(result.destination); return; }
      } else {
        const result = await changeResidenceCountry(country, locale);
        if (result.error) setError(result.error);
        else { setSaved(true); router.refresh(); }
      }
    } catch { setError("error"); }
    pending.current = false; setBusy(false);
  }

  return <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
    {mode === "onboarding" && <label className="block space-y-2">
      <span className="text-sm font-semibold">{t("username")}</span>
      <input name="username" value={username} onChange={(event) => { setUsername(event.target.value); setError(""); }}
        required autoComplete="username" minLength={3} maxLength={20} disabled={busy}
        aria-describedby="profile-username-hint profile-feedback" aria-invalid={Boolean(error && /^username/.test(error))} className="ui-field min-h-12 w-full px-3.5 text-[15px]" />
      <span id="profile-username-hint" className="block text-xs leading-relaxed text-[var(--color-text-muted)]">{t("usernameHint")}</span>
    </label>}
    <CountrySelect value={country} onChange={(code) => { setCountry(code); setError(""); setSaved(false); }}
      disabled={busy} error={error === "countryRequired" ? errorText : undefined} />
    <div id="profile-feedback" aria-live="polite" className="min-h-4">
      {error && <p role="alert" className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">{errorText}</p>}
      {saved && <p role="status" className="border-l-4 border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)]">{t("countryUpdated")}</p>}
    </div>
    <button type="submit" disabled={busy} className="ui-pressable inline-flex min-h-12 w-full items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-6 py-3.5 text-[14px] font-bold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-forest-hover)] active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60">
      {t(busy ? "saving" : mode === "onboarding" ? "completeProfile" : "save")}
    </button>
    {mode === "country" && <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">{t("changeNote") ?? "Changing your residence country changes your country ranking and country progress only. Your ascents and achievements remain unchanged."}</p>}
  </form>;
}
