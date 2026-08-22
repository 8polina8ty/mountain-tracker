"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  Mountain,
  User,
} from "lucide-react";
import { createClient } from "@/Lib/supabase/client";
import { Link, useRouter } from "@/i18n/navigation";

export default function SignUpPage() {
  const t = useTranslations("Auth.signUpPage");
  const router = useRouter();

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
    setMessage("");

    if (!username.trim()) {
      setMessage(t("errors.usernameRequired"));
      return;
    }

    if (!email.trim()) {
      setMessage(t("errors.emailRequired"));
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

    const supabase = createClient();

    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          username: username.trim(),
        },
      },
    });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    router.push("/map");
    router.refresh();
  }

  return (
    <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 py-10 sm:px-8 lg:min-h-[calc(100dvh-66px)]">
      <section className="w-full max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)] sm:p-8">
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

        <div className="mt-8 space-y-5">
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
              className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-4"
            />
          </div>

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

          <div>
            <div className="h-2 w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-surface-muted)]">
              <div
                className={`h-full rounded-full transition-all duration-300 ${currentStrength.color}`}
                style={{
                  width: currentStrength.width,
                }}
              />
            </div>

            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-[var(--color-text-muted)]">
                {t("strengthLabel")}
              </span>

              <span
                className={`font-semibold ${currentStrength.textColor}`}
              >
                {currentStrength.text}
              </span>
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
              role="alert"
              className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-sm text-[var(--color-danger)]"
            >
              {message}
            </div>
          )}

          <button
            type="button"
            onClick={handleSignUp}
            disabled={loading}
            className="ui-pressable min-h-11 w-full rounded-[var(--radius-control)] bg-[var(--color-forest)] py-3 font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading
              ? t("submitting")
              : t("submit")}
          </button>
        </div>

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
