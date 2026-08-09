"use client";

import { useState } from "react";

import { createClient } from "@/Lib/supabase/client";

type AscentPhotoPrivacyToggleProps = {
  ascentId: number;
  initialIsPublic: boolean;
  hasCustomPhoto: boolean;
  onPrivacyChanged: (isPublic: boolean) => void;
};

export default function AscentPhotoPrivacyToggle({
  ascentId,
  initialIsPublic,
  hasCustomPhoto,
  onPrivacyChanged,
}: AscentPhotoPrivacyToggleProps) {
  const [isPublic, setIsPublic] = useState(
    initialIsPublic,
  );

  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState("");

  async function handleToggle() {
    if (!hasCustomPhoto || updating) {
      return;
    }

    const nextValue = !isPublic;

    setUpdating(true);
    setMessage("");

    try {
      const supabase = createClient();

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        throw userError;
      }

      if (!user) {
        setMessage("Сначала войдите в аккаунт.");
        return;
      }

      const { data, error } = await supabase
        .from("ascents")
        .update({
          is_photo_public: nextValue,
        })
        .eq("id", ascentId)
        .eq("user_id", user.id)
        .select("id, is_photo_public")
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error(
          "Не удалось обновить настройки фотографии.",
        );
      }

      const savedValue = Boolean(
        data.is_photo_public,
      );

      setIsPublic(savedValue);
      onPrivacyChanged(savedValue);

      setMessage(
        savedValue
          ? "Фото видно в публичном профиле."
          : "Фото скрыто из публичного профиля.",
      );
    } catch (error) {
      console.error(
        "Ошибка изменения видимости фотографии:",
        error,
      );

      setMessage(
        error instanceof Error
          ? error.message
          : "Не удалось изменить видимость фото.",
      );
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={isPublic}
        onClick={handleToggle}
        disabled={!hasCustomPhoto || updating}
        className={[
          "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm font-semibold transition",
          isPublic
            ? "border-green-300 bg-green-50 text-green-700"
            : "border-gray-300 bg-white text-gray-700",
          hasCustomPhoto
            ? "hover:border-green-500"
            : "cursor-not-allowed opacity-50",
          updating
            ? "cursor-wait opacity-60"
            : "",
        ].join(" ")}
      >
        <span>
          {isPublic
            ? "🌍 Фото публичное"
            : "🔒 Фото приватное"}
        </span>

        <span
          className={[
            "relative h-6 w-11 shrink-0 rounded-full transition",
            isPublic
              ? "bg-green-600"
              : "bg-gray-300",
          ].join(" ")}
        >
          <span
            className={[
              "absolute top-1 h-4 w-4 rounded-full bg-white shadow transition",
              isPublic
                ? "left-6"
                : "left-1",
            ].join(" ")}
          />
        </span>
      </button>

      {!hasCustomPhoto && (
        <p className="mt-2 max-w-52 text-xs text-gray-400">
          Сначала загрузите собственную фотографию.
        </p>
      )}

      {message && (
        <p className="mt-2 max-w-52 text-xs text-gray-500">
          {message}
        </p>
      )}
    </div>
  );
}