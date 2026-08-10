"use client";

import {
  ChangeEvent,
  useRef,
  useState,
} from "react";
import { Camera } from "lucide-react";

import { createClient } from "@/Lib/supabase/client";

type ChangeAscentPhotoButtonProps = {
  ascentId: number;
  onPhotoChanged: (imageUrl: string) => void;
};

const MAX_FILE_SIZE = 8 * 1024 * 1024;

const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export default function ChangeAscentPhotoButton({
  ascentId,
  onPhotoChanged,
}: ChangeAscentPhotoButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");

  function openFileDialog() {
    if (!uploading) {
      inputRef.current?.click();
    }
  }

  async function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];

    event.target.value = "";

    if (!file) {
      return;
    }

    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      setMessage(
        "Можно загружать только JPG, PNG или WebP.",
      );
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage(
        "Размер фотографии не должен превышать 8 МБ.",
      );
      return;
    }

    setUploading(true);
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

      const fileExtension =
        file.name.split(".").pop()?.toLowerCase() ??
        "jpg";

      const filePath = [
        user.id,
        String(ascentId),
        `${Date.now()}.${fileExtension}`,
      ].join("/");

      const { error: uploadError } =
        await supabase.storage
          .from("ascent-images")
          .upload(filePath, file, {
            cacheControl: "3600",
            contentType: file.type,
            upsert: false,
          });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("ascent-images")
          .getPublicUrl(filePath);

      const imageUrl = publicUrlData.publicUrl;

      const { error: updateError } = await supabase
        .from("ascents")
        .update({
          image_url: imageUrl,
        })
        .eq("id", ascentId)
        .eq("user_id", user.id);

      if (updateError) {
        throw updateError;
      }

      onPhotoChanged(imageUrl);
      setMessage("Фотография обновлена.");
    } catch (error) {
      console.error(
        "Ошибка загрузки фотографии восхождения:",
        error,
      );

      setMessage(
        error instanceof Error
          ? error.message
          : "Не удалось загрузить фотографию.",
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      <button
        type="button"
        onClick={openFileDialog}
        disabled={uploading}
        className="inline-flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-forest)] hover:text-[var(--color-forest)] disabled:cursor-wait disabled:opacity-60"
      >
        <Camera aria-hidden="true" className="h-4 w-4" />
        {uploading ? "Загружаю…" : "Сменить фото"}
      </button>

      {message && (
        <p className="mt-2 max-w-52 text-xs text-[var(--color-text-muted)]" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
