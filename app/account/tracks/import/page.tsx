"use client";

import Link from "next/link";
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
    <main className="min-h-[calc(100vh-80px)] bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/account/ascents"
          className="font-semibold text-green-700 transition hover:text-green-800"
        >
          ← Вернуться к восхождениям
        </Link>

        <section className="mt-6 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-sm font-bold uppercase tracking-wider text-green-700">
            GPS-треки
          </p>

          <h1 className="mt-2 text-3xl font-bold text-gray-900">
            Импорт GPS-трека
          </h1>

          <p className="mt-3 max-w-2xl text-gray-500">
            Загрузите запись восхождения с Garmin,
            Suunto, Strava, Komoot, часов, телефона или
            другого туристического приложения.
          </p>

          <div className="mt-8">
            <label
              htmlFor="track-source"
              className="text-sm font-semibold text-gray-700"
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
              className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100"
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
              "mt-6 flex min-h-72 flex-col items-center justify-center rounded-3xl border-2 border-dashed p-8 text-center transition",
              dragActive
                ? "border-green-500 bg-green-50"
                : "border-gray-300 bg-gray-50",
            ].join(" ")}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".gpx,.fit,.tcx,.geojson,.json"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="text-6xl">🗺️</div>

            <h2 className="mt-5 text-xl font-bold text-gray-900">
              Перетащите GPS-файл сюда
            </h2>

            <p className="mt-2 text-gray-500">
              Поддерживаются GPX, FIT, TCX и GeoJSON
              размером до 50 МБ.
            </p>

            <button
              type="button"
              onClick={() => {
                inputRef.current?.click();
              }}
              className="mt-6 rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700"
            >
              Выбрать файл
            </button>
          </div>

          {selectedFile && (
            <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-green-200 bg-green-50 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-bold text-gray-900">
                  {selectedFile.name}
                </p>

                <p className="mt-1 text-sm text-gray-500">
                  {(selectedFile.size / 1024 / 1024).toFixed(
                    2,
                  )}{" "}
                  МБ · источник: {sourceType}
                </p>
              </div>

              <button
                type="button"
                onClick={clearFile}
                className="shrink-0 rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-700"
              >
                Удалить
              </button>
            </div>
          )}

          {message && (
            <p className="mt-5 rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-600">
              {message}
            </p>
          )}

          <div className="mt-8 flex justify-end">
            <button
  type="button"
  onClick={handleContinue}
  disabled={!selectedFile || uploading}
  className="rounded-xl bg-green-600 px-6 py-3 font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
>
  {uploading
    ? "Загружаю…"
    : "Загрузить GPS-трек"}
</button>
          </div>
        </section>
      </div>
    </main>
  );
}