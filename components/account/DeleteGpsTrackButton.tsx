"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/Lib/supabase/client";

type DeleteGpsTrackButtonProps = {
  activityId: number;
  activityTitle: string;
  originalFilePath: string | null;
  geoJsonFilePath: string | null;
};

export default function DeleteGpsTrackButton({
  activityId,
  activityTitle,
  originalFilePath,
  geoJsonFilePath,
}: DeleteGpsTrackButtonProps) {
  const router = useRouter();

  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] =
    useState("");

  async function handleDelete() {
    if (deleting) {
      return;
    }

    const confirmed = window.confirm(
      `Удалить GPS-трек «${activityTitle}»?\n\nФайлы и данные активности будут удалены без возможности восстановления.`,
    );

    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setErrorMessage("");

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
        throw new Error(
          "Сначала войдите в аккаунт.",
        );
      }

      const filePaths = [
        originalFilePath,
        geoJsonFilePath,
      ].filter(
        (filePath): filePath is string =>
          typeof filePath === "string" &&
          filePath.trim() !== "",
      );

      if (filePaths.length > 0) {
        const { error: storageError } =
          await supabase.storage
            .from("activity-tracks")
            .remove(filePaths);

        if (storageError) {
          throw storageError;
        }
      }

      const { error: deleteError } =
        await supabase
          .from("gps_activities")
          .delete()
          .eq("id", activityId)
          .eq("user_id", user.id);

      if (deleteError) {
        throw deleteError;
      }

      router.refresh();
    } catch (error) {
      console.error(
        "Ошибка удаления GPS-трека:",
        error,
      );

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Не удалось удалить GPS-трек.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        className="inline-flex w-full items-center justify-center rounded-xl border border-red-300 bg-white px-5 py-3 font-semibold text-red-700 transition hover:border-red-500 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
      >
        {deleting
          ? "Удаляю…"
          : "Удалить"}
      </button>

      {errorMessage && (
        <p className="mt-2 max-w-52 text-xs text-red-600">
          {errorMessage}
        </p>
      )}
    </div>
  );
}