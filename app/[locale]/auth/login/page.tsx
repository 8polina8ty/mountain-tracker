"use client";

import { useState } from "react";
import { Eye, EyeOff, LockKeyhole, Mail, Mountain } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { Link, useRouter } from "@/i18n/navigation";

export default function LoginPage() {
  const t = useTranslations("Auth.loginPage");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setMessage("");

    if (!email.trim() || !password) {
      setMessage(t("errors.requiredCredentials"));
      return;
    }

    setLoading(true);

    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setMessage(
        error.message === "Invalid login credentials"
          ? t("errors.invalidCredentials")
          : error.message,
      );

      setLoading(false);
      return;
    }

    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    router.push(returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/map");
    router.refresh();
  }

  return (
    <main className="flex min-h-[calc(100dvh-58px)] items-center justify-center bg-[var(--color-bg)] px-4 py-10 sm:px-8 lg:min-h-[calc(100dvh-66px)]">
      <section className="w-full max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)] sm:p-8">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-forest)] shadow-[var(--shadow-control)]">
            <Mountain size={30} />
          </div>

          <h1 className="mt-4 text-3xl font-bold text-[var(--color-text)]">
            {t("title")}
          </h1>

          <p className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
            {t("subtitle")}
          </p>
        </div>

        <div className="mt-8 space-y-5">
          <label className="block">
            <span className="mb-2 block text-sm font-bold text-[var(--color-text-secondary)]">
              {t("emailLabel")}
            </span>

            <div className="relative">
              <Mail
                size={20}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />

              <input
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setMessage("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleLogin();
                  }
                }}
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-4"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-bold text-[var(--color-text-secondary)]">
              {t("passwordLabel")}
            </span>

            <div className="relative">
              <LockKeyhole
                size={20}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />

              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setMessage("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleLogin();
                  }
                }}
                autoComplete="current-password"
                placeholder={t("passwordPlaceholder")}
                className="ui-field w-full rounded-[var(--radius-control)] border px-3 py-3 pl-11 pr-12"
              />

              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
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
          </label>

          {message && (
            <div
              role="alert"
              className="border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]"
            >
              {message}
            </div>
          )}

          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="ui-pressable flex min-h-11 w-full items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 py-3 font-bold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                {t("submitting")}
              </>
            ) : (
              t("submit")
            )}
          </button>
        </div>

        <p className="mt-6 border-t border-[var(--color-border)] pt-5 text-center text-sm text-[var(--color-text-muted)]">
          {t("noAccount")} {" "}
          <Link
            href="/auth/sign-up"
            className="font-bold text-[var(--color-forest)] hover:underline"
          >
            {t("signUpLink")}
          </Link>
        </p>
      </section>
    </main>
  );
}
