"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  Mountain,
  User,
} from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { Link } from "@/i18n/navigation";
import { validateUsername } from "@/Lib/username";
import { isCountryCode } from "@/Lib/countries";
import { checkRegistrationInput, completeProfile } from "@/Lib/auth/actions";
import CountrySelect from "@/components/auth/CountrySelect";
import GoogleAuthButton from "@/components/auth/GoogleAuthButton";

export default function SignUpPage() {
  const t = useTranslations("Auth.signUpPage");
  const countryT = useTranslations("Country");
  const locale = useLocale();
  const pending = useRef(false);
  const [country, setCountry] = useState("");
  const [confirmation, setConfirmation] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const passwordStrength = (() => {
    if (password.length === 0) {
      return 0;
    }

    let score = 0;

    if (password.length >= 8) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;

    return score;
  })();

  const strengthSettings = [
    {
      text: t("strength.empty"),
      width: "0%",
      color: "bg-[var(--color-border-strong)]",
      textColor: "text-[var(--color-text-muted)]",
    },
    {
      text: t("strength.weak"),
      width: "25%",
      color: "bg-[var(--color-danger)]",
      textColor: "text-[var(--color-danger)]",
    },
    {
      text: t("strength.medium"),
      width: "50%",
      color: "bg-[var(--color-warning)]",
      textColor: "text-[var(--color-warning)]",
    },
    {
      text: t("strength.good"),
      width: "75%",
      color: "bg-[var(--color-ochre)]",
      textColor: "text-[var(--color-ochre)]",
    },
    {
      text: t("strength.strong"),
      width: "100%",
      color: "bg-[var(--color-success)]",
      textColor: "text-[var(--color-success)]",
    },
  ];

  const currentStrength = strengthSettings[passwordStrength];

  async function handleSignUp() {
    if (pending.current || loading || confirmation) return;
    setMessage("");

    const usernameError = validateUsername(username);
    if (usernameError) {
      setMessage(t(`errors.${usernameError}`));
      return;
    }

    if (!email.trim()) {
      setMessage(t("errors.emailRequired"));
      return;
    }

    if (!isCountryCode(country)) {
      setMessage(countryT("countryRequired"));
      return;
    }

    if (password.length < 8) {
      setMessage(t("errors.passwordLength"));
      return;
    }

    if (password !== confirmPassword) {
      setMessage(t("errors.passwordMismatch"));
      return;
    }

    setLoading(true);
    pending.current = true;
    try {
      const checked = await checkRegistrationInput(username, country);
      if (checked.error) {
        setMessage(/^username(Required|TooShort|TooLong|InvalidChars|InvalidEdges)$/.test(checked.error)
          ? t(`errors.${checked.error}`) : countryT(checked.error));
        return;
      }
      const { data, error } = await createClient().auth.signUp({
        email: email.trim(), password,
        options: {
          emailRedirectTo: `${window.location.origin}/${locale}/auth/callback`,
          data: { username: username.trim(), country_code: country },
        },
      });
      if (error) {
        if (error.code === "user_already_exists") setConfirmation(true);
        else setMessage(countryT("registrationError"));
        return;
      }
      if (!data.session) { setConfirmation(true); return; }
      const result = await completeProfile({ username, country, locale });
      if (result.destination) window.location.assign(result.destination);
      else window.location.assign(`/${locale}/auth/complete-profile?reason=${result.error === "usernameUnavailable" ? "usernameUnavailable" : "error"}`);
    } catch { setMessage(countryT("error")); }
    finally { pending.current = false; setLoading(false); }
  }

  return (
    <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 py-10 sm:px-8 lg:min-h-[calc(100dvh-66px)]">
      <section className="w-full max-w-[480px] rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)] sm:p-8">
        <div className="flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-forest)] shadow-[var(--shadow-control)]">
            <Mountain size={32} />
          </div>

          <h1 className="mt-4 text-3xl font-bold">
            {t("title")}
          </h1>

          <p className="mt-2 text-center text-sm leading-6 text-[var(--color-text-muted)]">
            {t("subtitle")}
          </p>
        </div>

        <form className="mt-8 space-y-5" onSubmit={(event) => { event.preventDefault(); void handleSignUp(); }}>
          <GoogleAuthButton signup disabled={loading || confirmation} onBusyChange={setLoading} />
          {confirmation ? <div role="status" className="rounded-[var(--radius-card)] border border-[var(--color-success-border)] bg-[var(--color-success-soft)] p-5 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--color-surface)] text-[var(--color-success)]"><Mail size={22} /></div>
            <p className="mt-3 text-[16px] font-bold">{countryT("confirmationRequired")}</p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">{countryT("confirmationDescription")}</p>
            <Link href="/auth/login" className="ui-pressable mt-4 inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 text-sm font-semibold hover:bg-[var(--color-surface-muted)]">{countryT("backToLogin") ?? "Back to sign in"}</Link>
          </div> : <>
          <div className="flex items-center gap-3 py-1" aria-hidden="true">
            <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">or</span>
            <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
          </div>
          <div className="relative">
            <User
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />

            <input
              type="text"
              placeholder={t("usernamePlaceholder")}
              aria-label={t("usernameLabel")}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setMessage("");
              }}
              autoComplete="username"
              required minLength={3} maxLength={20}
              aria-describedby="signup-username-hint signup-feedback"
              className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-4"
            />
          </div>

          <p id="signup-username-hint" className="text-sm text-[var(--color-text-muted)]">{countryT("usernameHint")}</p>
          <CountrySelect value={country} onChange={(code) => { setCountry(code); setMessage(""); }} disabled={loading || confirmation} />
          <div className="relative">
            <Mail
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />

            <input
              type="email"
              placeholder={t("emailPlaceholder")}
              aria-label={t("emailLabel")}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setMessage("");
              }}
              autoComplete="email"
              required aria-describedby="signup-feedback"
              className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-4"
            />
          </div>

          <div className="relative">
            <LockKeyhole
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />

            <input
              type={showPassword ? "text" : "password"}
              placeholder={t("passwordPlaceholder")}
              aria-label={t("passwordLabel")}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setMessage("");
              }}
              autoComplete="new-password"
              required minLength={8} aria-describedby="signup-feedback"
              className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-12"
            />

            <button
              type="button"
              onClick={() =>
                setShowPassword((currentValue) => !currentValue)
              }
              aria-label={
                showPassword ? t("hidePassword") : t("showPassword")
              }
              className="ui-pressable absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
            >
              {showPassword ? (
                <EyeOff size={20} />
              ) : (
                <Eye size={20} />
              )}
            </button>
          </div>

          <div className="space-y-2" aria-live="polite" aria-atomic="true">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border-soft)]" role="progressbar" aria-valuenow={passwordStrength * 25} aria-valuemin={0} aria-valuemax={100} aria-label={t("strengthLabel")} aria-valuetext={currentStrength.text}>
              <div className={`h-full rounded-full transition-[width,background-color] duration-200 ease-out ${currentStrength.color}`} style={{ width: currentStrength.width }} />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">{t("strengthLabel")}</span>
              <span className={`font-semibold ${currentStrength.textColor}`}>{currentStrength.text}</span>
            </div>
          </div>

          <div className="relative">
            <LockKeyhole
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />

            <input
              type={showPassword ? "text" : "password"}
              placeholder={t("confirmPasswordPlaceholder")}
              aria-label={t("confirmPasswordLabel")}
              required aria-describedby="signup-feedback"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setMessage("");
              }}
              autoComplete="new-password"
              className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-4"
            />
          </div>

          {confirmPassword && (
            <p
              className={`text-sm font-medium ${
                password === confirmPassword
                  ? "text-[var(--color-success)]"
                  : "text-[var(--color-danger)]"
              }`}
            >
              {password === confirmPassword
                ? t("passwordsMatch")
                : t("passwordsDoNotMatch")}
            </p>
          )}

          {message && (
            <div
              id="signup-feedback"
              role="alert"
              className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm text-[var(--color-danger)]"
            >
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || confirmation}
            className="ui-pressable min-h-12 w-full rounded-[var(--radius-control)] bg-[var(--color-forest)] py-3.5 font-bold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-forest-hover)] active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading
              ? t("submitting")
              : t("submit")}
          </button>
          </>}
        </form>

        <p className="mt-6 border-t border-[var(--color-border)] pt-5 text-center text-sm text-[var(--color-text-muted)]">
          {t("hasAccount")} {" "}
          <Link
            href="/auth/login"
            className="font-bold text-[var(--color-forest)] hover:underline"
          >
            {t("loginLink")}
          </Link>
        </p>
      </section>
    </main>
  );
}
