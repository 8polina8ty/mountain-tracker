"use client";

import Link from "next/link";
import { ArrowLeft, FileUp, Route, ShieldCheck, Trash2 } from "lucide-react";
import {
  ChangeEvent,
  DragEvent,
  useRef,
  useState,
} from "react";
import { createClient } from "@/Lib/supabase/client";
import { parseGpxFile } from "@/Lib/tracks/parseGpxFile";
import { useRouter } from "next/navigation";
import { detectMountainFromTrack } from "@/Lib/tracks/detectMountainFromTrack";
import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [
  "gpx",
  "fit",
  "tcx",
  "geojson",
  "json",
];


type TrackSource =
  | "garmin"
  | "suunto"
  | "strava"
  | "komoot"
  | "watch"
  | "phone"
  | "other";

export default function ImportTrackPage() {
  const router = useRouter();
  
  const inputRef = useRef<HTMLInputElement | null>(
    null,
  );

  const [selectedFile, setSelectedFile] =
    useState<File | null>(null);

  const [sourceType, setSourceType] =
    useState<TrackSource>("other");

  const [dragActive, setDragActive] =
    useState(false);

  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);

  function getFileExtension(fileName: string) {
    return (
      fileName
        .split(".")
        .pop()
        ?.toLowerCase() ?? ""
    );
  }

  function validateFile(file: File): boolean {
    const extension = getFileExtension(file.name);

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      setMessage(
        "Поддерживаются GPX, FIT, TCX и GeoJSON.",
      );

      return false;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage(
        "Размер файла не должен превышать 50 МБ.",
      );

      return false;
    }

    setMessage("");

    return true;
  }

  function selectFile(file: File) {
    if (!validateFile(file)) {
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
    setMessage("Файл готов к импорту.");
  }


function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];

    event.target.value = "";

    if (file) {
      selectFile(file);
    }
  }


  function handleDragOver(
    event: DragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(
    event: DragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    setDragActive(false);
  }

  function handleDrop(
    event: DragEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    setDragActive(false);

    const file = event.dataTransfer.files?.[0];

    if (file) {
      selectFile(file);
    }
  }

  function clearFile() {
    setSelectedFile(null);
    setMessage("");
  }

function getDatabaseSourceType(
  source: TrackSource,
) {
  switch (source) {
    case "garmin":
      return "garmin";

    case "suunto":
      return "suunto";

    case "strava":
      return "strava";

    case "komoot":
      return "komoot";

    case "phone":
      return "phone_recording";

    case "watch":
    case "other":
    default:
      return "other";
  }
}

async function handleContinue() {
  if (!selectedFile || uploading) {
    setMessage(
      "Сначала выберите файл GPS-трека.",
    );
    return;
  }

  setUploading(true);
  setMessage("");

  const supabase = createClient();

  let activityId: number | null = null;
  let uploadedFilePath: string | null = null;
  let uploadedGeoJsonPath: string | null = null;

  try {
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

    const extension =
      getFileExtension(selectedFile.name);
      if (extension !== "gpx") {
  throw new Error(
    "Автоматическая обработка пока поддерживает только GPX. FIT, TCX и GeoJSON подключим следующим этапом.",
  );
}

    const databaseSourceType =
      getDatabaseSourceType(sourceType);

    /*
     * Сначала создаём запись, чтобы получить activityId.
     */
    const {
      data: activity,
      error: activityError,
    } = await supabase
      .from("gps_activities")
      .insert({
        user_id: user.id,
        source_type: databaseSourceType,
        title: selectedFile.name.replace(
          /\.[^.]+$/,
          "",
        ),
        activity_type: "hiking",
        processing_status: "pending",
        is_public: false,
      })
      .select("id")
      .single();

    if (activityError) {
      throw activityError;
    }

    activityId = Number(activity.id);

    if (!Number.isInteger(activityId)) {
      throw new Error(
        "Не удалось получить ID GPS-активности.",
      );
    }

    uploadedFilePath = [
      user.id,
      String(activityId),
      `original.${extension}`,
    ].join("/");

    /*
     * Затем загружаем оригинальный файл
     * в приватный Storage bucket.
     */
    const { error: uploadError } =
      await supabase.storage
        .from("activity-tracks")
        .upload(
          uploadedFilePath,
          selectedFile,
          {
            cacheControl: "3600",
            contentType:
              selectedFile.type ||
              "application/octet-stream",
            upsert: false,
          },
        );

    if (uploadError) {
      throw uploadError;
    }

    /*
     * В приватном bucket сохраняем путь,
     * а не публичный URL.
     */
    /*
 * Отмечаем, что началась обработка файла.
 */
const { error: processingUpdateError } =
  await supabase
    .from("gps_activities")
    .update({
      original_file_url: uploadedFilePath,
      processing_status: "processing",
      processing_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", activityId)
    .eq("user_id", user.id);

if (processingUpdateError) {
  throw processingUpdateError;
}

/*
 * Преобразуем GPX в GeoJSON и рассчитываем статистику.
 */
const parsedTrack =
  await parseGpxFile(selectedFile);

  const detectedMountain =
  await detectMountainFromTrack({
    supabase,
    geojson: parsedTrack.geojson,
  });

const geoJsonFileName = "track.geojson";

uploadedGeoJsonPath = [
  user.id,
  String(activityId),
  geoJsonFileName,
].join("/");

const geoJsonBlob = new Blob(
  [
    JSON.stringify(
      parsedTrack.geojson,
      null,
      2,
    ),
  ],
  {
    type: "application/geo+json",
  },
);

/*
 * Загружаем созданный GeoJSON в тот же приватный bucket.
 */
const { error: geoJsonUploadError } =
  await supabase.storage
    .from("activity-tracks")
    .upload(
      uploadedGeoJsonPath,
      geoJsonBlob,
      {
        cacheControl: "3600",
        contentType: "application/geo+json",
        upsert: false,
      },
    );

if (geoJsonUploadError) {
  throw geoJsonUploadError;
}

/*
 * Обработка завершена — сохраняем статистику и статус ready.
 */
const { error: readyUpdateError } =
  await supabase
    .from("gps_activities")
    .update({
      original_file_url: uploadedFilePath,
      geojson_url: uploadedGeoJsonPath,

      started_at: parsedTrack.startedAt,
      finished_at: parsedTrack.finishedAt,
      duration_seconds:
        parsedTrack.durationSeconds,

      distance_m: parsedTrack.distanceM,
      elevation_gain_m:
        parsedTrack.elevationGainM,

      minimum_elevation_m:
        parsedTrack.minimumElevationM,

      maximum_elevation_m:
        parsedTrack.maximumElevationM,

        detected_mountain_id:
  detectedMountain?.mountainId ?? null,

detection_distance_m:
  detectedMountain?.distanceM ?? null,

detection_confidence:
  detectedMountain?.confidence ?? null,

detection_status:
  detectedMountain
    ? "detected"
    : "not_found",

gps_verified: false,

      processing_status: "ready",
      processing_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", activityId)
    .eq("user_id", user.id);

if (readyUpdateError) {
  throw readyUpdateError;
}

router.push(
  `/account/tracks/${activityId}`,
);

    setMessage(
  [
    "GPS-трек успешно обработан.",
    `Точек: ${parsedTrack.pointCount}.`,
    `Расстояние: ${(parsedTrack.distanceM / 1000).toFixed(2)} км.`,
    `Набор высоты: ${parsedTrack.elevationGainM} м.`,

    detectedMountain
      ? `Найдена вершина: ${detectedMountain.mountainName}, расстояние до трека ${detectedMountain.distanceM} м.`
      : "Рядом с треком подходящая вершина не найдена.",
  ].join(" "),
);

    setSelectedFile(null);
  } catch (error) {
    console.error(
      "Ошибка импорта GPS-трека:",
      error,
    );

    /*
     * Удаляем загруженный файл,
     * если последующий шаг завершился ошибкой.
     */
    const filesToRemove = [
  uploadedFilePath,
  uploadedGeoJsonPath,
].filter(
  (filePath): filePath is string =>
    filePath !== null,
);

if (filesToRemove.length > 0) {
  await supabase.storage
    .from("activity-tracks")
    .remove(filesToRemove);
}
    /*
     * Удаляем незавершённую запись активности.
     */
    if (activityId !== null) {
      await supabase
        .from("gps_activities")
        .delete()
        .eq("id", activityId);
    }

    setMessage(
      error instanceof Error
        ? error.message
        : "Не удалось загрузить GPS-трек.",
    );
  } finally {
    setUploading(false);
  }
}

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <AccountPageHeader
          eyebrow="03.2 / Полевые данные"
          title="Импорт GPS-трека"
          description="Добавьте запись восхождения с навигатора, часов, телефона или туристического приложения."
          actions={
            <Link href="/account/tracks" className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] transition-colors hover:border-[var(--color-forest)]">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              Все треки
            </Link>
          }
        />

        <section className="grid gap-8 py-8 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] lg:gap-12" aria-labelledby="track-import-form-title">
          <div>
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              Шаг 01 / Файл маршрута
            </p>
            <h2 id="track-import-form-title" className="mt-1 text-2xl font-bold text-[var(--color-text)]">
              Данные активности
            </h2>

            <div className="mt-6">
            <label
              htmlFor="track-source"
              className="text-sm font-semibold text-[var(--color-text-secondary)]"
            >
              Источник трека
            </label>

            <select
              id="track-source"
              value={sourceType}
              onChange={(event) => {
                setSourceType(
                  event.target.value as TrackSource,
                );
              }}
              className="mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-2 text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-focus)]"
            >
              <option value="garmin">Garmin</option>
              <option value="suunto">Suunto</option>
              <option value="strava">Strava</option>
              <option value="komoot">Komoot</option>
              <option value="watch">
                Другие часы
              </option>
              <option value="phone">Телефон</option>
              <option value="other">
                Другое приложение
              </option>
            </select>
          </div>

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={[
              "mt-6 flex min-h-72 flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed p-6 text-center transition-colors sm:p-8",
              dragActive
                ? "border-[var(--color-forest)] bg-[var(--color-success-soft)]"
                : "border-[var(--color-border-strong)] bg-[var(--color-surface)]",
            ].join(" ")}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".gpx,.fit,.tcx,.geojson,.json"
              onChange={handleFileChange}
              className="hidden"
            />

            <FileUp aria-hidden="true" className="h-10 w-10 text-[var(--color-track)]" />

            <h3 className="mt-5 text-xl font-bold text-[var(--color-text)]">
              Перетащите GPS-файл сюда
            </h3>

            <p className="mt-2 text-[var(--color-text-muted)]">
              Поддерживаются GPX, FIT, TCX и GeoJSON
              размером до 50 МБ.
            </p>

            <button
              type="button"
              onClick={() => {
                inputRef.current?.click();
              }}
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white transition-colors hover:bg-[var(--color-forest-hover)]"
            >
              <Route aria-hidden="true" className="h-4 w-4" />
              Выбрать файл
            </button>
          </div>

          {selectedFile && (
            <div className="mt-6 flex flex-col gap-4 border-l-4 border-[var(--color-success)] bg-[var(--color-success-soft)] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <Route aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" />
                <div className="min-w-0">
                <p className="truncate font-bold text-[var(--color-text)]">
                  {selectedFile.name}
                </p>

                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {(selectedFile.size / 1024 / 1024).toFixed(
                    2,
                  )}{" "}
                  МБ · источник: {sourceType}
                </p>
                </div>
              </div>

              <button
                type="button"
                onClick={clearFile}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-danger-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-soft)]"
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                Удалить
              </button>
            </div>
          )}

          {message && (
            <p className="mt-5 border-l-4 border-[var(--color-info)] bg-[var(--color-info-soft)] px-4 py-3 text-sm text-[var(--color-text-secondary)]" role="status">
              {message}
            </p>
          )}

          <div className="mt-8 flex justify-end border-t border-[var(--color-border)] pt-6">
            <button
  type="button"
  onClick={handleContinue}
  disabled={!selectedFile || uploading}
  className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-6 py-2 font-semibold text-white transition-colors hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:opacity-50"
>
  <FileUp aria-hidden="true" className="h-4 w-4" />
  {uploading
    ? "Загружаю…"
    : "Загрузить GPS-трек"}
</button>
          </div>
          </div>

          <aside className="border-t border-[var(--color-border-strong)] pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" aria-label="Параметры импорта">
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              Протокол импорта
            </p>
            <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">Что произойдёт</h2>
            <ol className="mt-5 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)] text-sm text-[var(--color-text-secondary)]">
              <li className="py-4">Файл будет сохранён в приватном хранилище.</li>
              <li className="py-4">Маршрут и показатели будут рассчитаны автоматически.</li>
              <li className="py-4">Система проверит ближайшую к треку вершину.</li>
            </ol>
            <div className="mt-6 flex gap-3 border-l-2 border-[var(--color-forest)] pl-4">
              <ShieldCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--color-forest)]" />
              <p className="text-sm text-[var(--color-text-muted)]">Максимальный размер файла: 50 МБ. Доступ к записи остаётся приватным.</p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
