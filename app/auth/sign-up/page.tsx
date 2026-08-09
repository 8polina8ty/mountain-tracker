"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  Mountain,
  User,
} from "lucide-react";
import { createClient } from "@/Lib/supabase/client";

export default function SignUpPage() {
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
      text: "Введите пароль",
      width: "0%",
      color: "bg-gray-300",
      textColor: "text-gray-500",
    },
    {
      text: "Слабый",
      width: "25%",
      color: "bg-red-500",
      textColor: "text-red-600",
    },
    {
      text: "Средний",
      width: "50%",
      color: "bg-orange-500",
      textColor: "text-orange-600",
    },
    {
      text: "Хороший",
      width: "75%",
      color: "bg-yellow-500",
      textColor: "text-yellow-700",
    },
    {
      text: "Надёжный",
      width: "100%",
      color: "bg-green-600",
      textColor: "text-green-700",
    },
  ];

  const currentStrength = strengthSettings[passwordStrength];

  async function handleSignUp() {
    setMessage("");

    if (!username.trim()) {
      setMessage("Введите имя пользователя.");
      return;
    }

    if (!email.trim()) {
      setMessage("Введите email.");
      return;
    }

    if (password.length < 8) {
      setMessage("Пароль должен содержать минимум 8 символов.");
      return;
    }

    if (password !== confirmPassword) {
      setMessage("Пароли не совпадают.");
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

    router.push("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-[calc(100vh-65px)] items-center justify-center bg-gray-50 px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-gray-200 bg-white p-8 shadow-xl">
        <div className="flex flex-col items-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-green-100 text-green-700">
            <Mountain size={32} />
          </div>

          <h1 className="mt-4 text-3xl font-bold">
            Создать аккаунт
          </h1>

          <p className="mt-2 text-center text-sm text-gray-500">
            Начните отмечать покорённые вершины
          </p>
        </div>

        <div className="mt-8 space-y-5">
          <div className="relative">
            <User
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />

            <input
              type="text"
              placeholder="Имя пользователя"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setMessage("");
              }}
              autoComplete="username"
              className="w-full rounded-xl border border-gray-300 py-3 pl-11 pr-4 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100"
            />
          </div>

          <div className="relative">
            <Mail
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />

            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setMessage("");
              }}
              autoComplete="email"
              className="w-full rounded-xl border border-gray-300 py-3 pl-11 pr-4 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100"
            />
          </div>

          <div className="relative">
            <LockKeyhole
              size={20}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />

            <input
              type={showPassword ? "text" : "password"}
              placeholder="Пароль"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setMessage("");
              }}
              autoComplete="new-password"
              className="w-full rounded-xl border border-gray-300 py-3 pl-11 pr-12 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100"
            />

            <button
              type="button"
              onClick={() =>
                setShowPassword((currentValue) => !currentValue)
              }
              aria-label={
                showPassword ? "Скрыть пароль" : "Показать пароль"
              }
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              {showPassword ? (
                <EyeOff size={20} />
              ) : (
                <Eye size={20} />
              )}
            </button>
          </div>

          <div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className={`h-full rounded-full transition-all duration-300 ${currentStrength.color}`}
                style={{
                  width: currentStrength.width,
                }}
              />
            </div>

            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-gray-500">
                Надёжность пароля:
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
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />

            <input
              type={showPassword ? "text" : "password"}
              placeholder="Повторите пароль"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setMessage("");
              }}
              autoComplete="new-password"
              className="w-full rounded-xl border border-gray-300 py-3 pl-11 pr-4 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100"
            />
          </div>

          {confirmPassword && (
            <p
              className={`text-sm font-medium ${
                password === confirmPassword
                  ? "text-green-700"
                  : "text-red-600"
              }`}
            >
              {password === confirmPassword
                ? "Пароли совпадают."
                : "Пароли не совпадают."}
            </p>
          )}

          {message && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {message}
            </div>
          )}

          <button
            type="button"
            onClick={handleSignUp}
            disabled={loading}
            className="w-full rounded-xl bg-green-600 py-3 font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading
              ? "Создание аккаунта..."
              : "Создать аккаунт"}
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-gray-600">
          Уже есть аккаунт?{" "}
          <Link
            href="/auth/login"
            className="font-semibold text-green-700 hover:underline"
          >
            Войти
          </Link>
        </p>
      </section>
    </main>
  );
}