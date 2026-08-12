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
    <main className="flex min-h-[calc(100vh-65px)] items-center justify-center bg-gray-50 px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-gray-200 bg-white p-6 shadow-xl sm:p-8">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-100 text-green-700">
            <Mountain size={30} />
          </div>

          <h1 className="mt-4 text-3xl font-bold text-gray-900">
            {t("title")}
          </h1>

          <p className="mt-2 text-sm text-gray-500">
            {t("subtitle")}
          </p>
        </div>

        <div className="mt-8 space-y-5">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-gray-700">
              {t("emailLabel")}
            </span>

            <div className="relative">
              <Mail
                size={20}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
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
                className="w-full rounded-xl border border-gray-300 py-3 pl-11 pr-4 outline-none transition focus:border-green-600 focus:ring-2 focus:ring-green-100"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-gray-700">
              {t("passwordLabel")}
            </span>

            <div className="relative">
              <LockKeyhole
                size={20}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
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
                className="w-full rounded-xl border border-gray-300 py-3 pl-11 pr-12 outline-none transition focus:border-green-600 focus:ring-2 focus:ring-green-100"
              />

              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={
                  showPassword ? t("hidePassword") : t("showPassword")
                }
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
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
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {message}
            </div>
          )}

          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="flex w-full items-center justify-center rounded-xl bg-green-600 px-4 py-3 font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
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

        <p className="mt-6 text-center text-sm text-gray-600">
          {t("noAccount")} {" "}
          <Link
            href="/auth/sign-up"
            className="font-semibold text-green-700 hover:underline"
          >
            {t("signUpLink")}
          </Link>
        </p>
      </section>
    </main>
  );
}
