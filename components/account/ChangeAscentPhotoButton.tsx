"use client";

import {
  ChangeEvent,
  useRef,
  useState,
} from "react";
import { Camera, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/Lib/supabase/client";
import { useAchievementNotification } from "@/components/achievements/AchievementNotificationProvider";

type ChangeAscentPhotoButtonProps = {
  ascentId: number;
  hasPhoto: boolean;
  onPhotoChanged: (imageUrl: string | null) => void;
};

const MAX_FILE_SIZE = 8 * 1024 * 1024;

const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export default function ChangeAscentPhotoButton({
  ascentId,
  hasPhoto,
  onPhotoChanged,
}: ChangeAscentPhotoButtonProps) {
  const { reconcileAfterUserAction } = useAchievementNotification();
  const t = useTranslations("Ascents.Photo");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");

  function openFileDialog() {
    if (!uploading) {
      inputRef.current?.click();
    }
  }

  async function removePhoto() {
    if (uploading || !hasPhoto) return;
    setUploading(true);
    setMessage("");
    const supabase = createClient();

    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!user) throw new Error(t("loginRequired"));

      const { error } = await supabase
        .from("ascents")
        .update({ image_url: null })
        .eq("id", ascentId)
        .eq("user_id", user.id);
      if (error) throw error;

      onPhotoChanged(null);
      setMessage(t("removed"));
      await reconcileAfterUserAction(supabase);
    } catch (error) {
      console.error("Unable to remove ascent photo.", error);
      setMessage(error instanceof Error ? error.message : t("removeFailed"));
    } finally {
      setUploading(false);
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
        t("invalidType"),
      );
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage(
        t("tooLarge"),
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
        setMessage(t("loginRequired"));
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
      setMessage(t("updated"));
      await reconcileAfterUserAction(supabase);
    } catch (error) {
      console.error(
        "Ошибка загрузки фотографии восхождения:",
        error,
      );

      setMessage(
        error instanceof Error
          ? error.message
          : t("uploadFailed"),
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
        className="ui-pressable inline-flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-text-secondary)] enabled:hover:border-[var(--color-forest)] enabled:hover:text-[var(--color-forest)] disabled:cursor-wait disabled:opacity-60"
      >
        <Camera aria-hidden="true" className="h-4 w-4" />
        {uploading ? t("uploading") : t("changePhoto")}
      </button>

      {hasPhoto && (
        <button
          type="button"
          onClick={removePhoto}
          disabled={uploading}
          className="ui-destructive ui-pressable mt-2 inline-flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-danger-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-60"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          {uploading ? t("removing") : t("removePhoto")}
        </button>
      )}

      {message && (
        <p className="mt-2 max-w-52 text-xs text-[var(--color-text-muted)]" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
