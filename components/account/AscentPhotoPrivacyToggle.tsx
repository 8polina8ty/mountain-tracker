"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

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
          "ui-pressable flex min-h-11 w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border px-3 py-2 text-sm font-semibold enabled:hover:border-[var(--color-forest)]",
          isPublic
            ? "border-[var(--color-success-border)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]",
          hasCustomPhoto
            ? ""
            : "cursor-not-allowed opacity-50",
          updating
            ? "cursor-wait opacity-60"
            : "",
        ].join(" ")}
      >
        <span className="flex items-center gap-2">
          {isPublic ? <Eye aria-hidden="true" className="h-4 w-4" /> : <EyeOff aria-hidden="true" className="h-4 w-4" />}
          {isPublic
            ? "Фото публичное"
            : "Фото приватное"}
        </span>

        <span
          className={[
            "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
            isPublic
              ? "bg-[var(--color-success)]"
              : "bg-[var(--color-border-strong)]",
          ].join(" ")}
        >
          <span
            className={[
              "absolute top-1 h-4 w-4 rounded-full bg-white shadow-[var(--shadow-control)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)]",
              isPublic
                ? "left-6"
                : "left-1",
            ].join(" ")}
          />
        </span>
      </button>

      {!hasCustomPhoto && (
        <p className="mt-2 max-w-52 text-xs text-[var(--color-text-muted)]">
          Сначала загрузите собственную фотографию.
        </p>
      )}

      {message && (
        <p className="mt-2 max-w-52 text-xs text-[var(--color-text-muted)]" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
