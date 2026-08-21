"use client";

import { ArrowLeft, FileUp, Route, ShieldCheck, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChangeEvent,
  DragEvent,
  useRef,
  useState,
} from "react";
import { createClient } from "@/Lib/supabase/client";
import { importGpxActivity, type GpxImportSource } from "@/Lib/tracks/importGpxActivity";
import AccountNavigation from "@/components/account/AccountNavigation";
import AccountPageHeader from "@/components/account/AccountPageHeader";
import { Link, useRouter } from "@/i18n/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useAchievementNotification } from "@/components/achievements/AchievementNotificationProvider";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const standardEasing = [0.2, 0, 0, 1] as const;

const ALLOWED_EXTENSIONS = [
  "gpx",
  "fit",
  "tcx",
  "geojson",
  "json",
];


type TrackSource = GpxImportSource;

export default function ImportTrackPage() {
  const { reconcileAfterUserAction } = useAchievementNotification();
  const t = useTranslations("Tracks.Import");
  const format = useFormatter();
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();
  
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
        t("invalidFormat"),
      );

      return false;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage(
        t("fileTooLarge"),
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
    setMessage(t("fileReady"));
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

async function handleContinue() {
  if (!selectedFile || uploading) {
    setMessage(t("selectFileFirst"));
    return;
  }

  setUploading(true);
  setMessage("");

  const supabase = createClient();
  const result = await importGpxActivity({
    supabase,
    file: selectedFile,
    source: sourceType,
  });

  if (!result.ok) {
    setMessage(
      result.reason === "auth"
        ? t("loginRequired")
        : result.reason === "validation"
          ? t("gpxOnly")
          : t("uploadFailed"),
    );
    setUploading(false);
    return;
  }

  await reconcileAfterUserAction(supabase);
  router.push(`/account/tracks/${result.gpsActivityId}`);
  setMessage([
    t("success"),
    t("points", { count: result.track.pointCount }),
    t("distance", { value: format.number(result.track.distanceM / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
    t("elevationGain", { value: format.number(result.track.elevationGainM) }),
    result.detectedMountain
      ? t("mountainDetected", { mountainName: result.detectedMountain.mountainName, distance: format.number(result.detectedMountain.distanceM) })
      : t("mountainNotDetected"),
  ].join(" "));
  setSelectedFile(null);
  setUploading(false);
}

  return (
    <main className="min-h-[calc(100dvh-58px)] bg-[var(--color-bg)] px-4 py-6 lg:min-h-[calc(100dvh-66px)] lg:px-6 lg:py-8">
      <div className="mx-auto max-w-7xl">
        <AccountNavigation />
        <AccountPageHeader
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
          actions={
            <Link href="/account/tracks" className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-forest)]">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              {t("allTracks")}
            </Link>
          }
        />

        <section className="grid gap-8 py-8 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] lg:gap-12" aria-labelledby="track-import-form-title">
          <div>
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              {t("stepLabel")}
            </p>
            <h2 id="track-import-form-title" className="mt-1 text-2xl font-bold text-[var(--color-text)]">
              {t("activityData")}
            </h2>

            <div className="mt-6">
            <label
              htmlFor="track-source"
              className="text-sm font-semibold text-[var(--color-text-secondary)]"
            >
              {t("sourceLabel")}
            </label>

            <select
              id="track-source"
              value={sourceType}
              onChange={(event) => {
                setSourceType(
                  event.target.value as TrackSource,
                );
              }}
              className="ui-field mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-2 text-[var(--color-text)] outline-none"
            >
              <option value="garmin">Garmin</option>
              <option value="suunto">Suunto</option>
              <option value="strava">Strava</option>
              <option value="komoot">Komoot</option>
              <option value="watch">
                {t("otherWatch")}
              </option>
              <option value="phone">{t("phone")}</option>
              <option value="other">
                {t("otherApplication")}
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
              {t("dropTitle")}
            </h3>

            <p className="mt-2 text-[var(--color-text-muted)]">
              {t("supportedFormats")}
            </p>

            <button
              type="button"
              onClick={() => {
                inputRef.current?.click();
              }}
              className="ui-pressable mt-6 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white hover:bg-[var(--color-forest-hover)]"
            >
              <Route aria-hidden="true" className="h-4 w-4" />
              {t("chooseFile")}
            </button>
          </div>

          <AnimatePresence initial={false}>
            {selectedFile && (
              <motion.div
                key="selected-file"
                initial={{
                  opacity: shouldReduceMotion ? 1 : 0,
                  y: shouldReduceMotion ? 0 : 10,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: {
                    duration: shouldReduceMotion ? 0 : 0.19,
                    ease: standardEasing,
                  },
                }}
                exit={{
                  opacity: shouldReduceMotion ? 1 : 0,
                  y: shouldReduceMotion ? 0 : 6,
                  transition: {
                    duration: shouldReduceMotion ? 0 : 0.15,
                    ease: standardEasing,
                  },
                }}
                className="mt-6 flex flex-col gap-4 border-l-4 border-[var(--color-success)] bg-[var(--color-success-soft)] p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Route aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" />
                  <div className="min-w-0">
                    <p className="truncate font-bold text-[var(--color-text)]">
                      {selectedFile.name}
                    </p>

                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                      {t("selectedFileMeta", { size: format.number(selectedFile.size / 1024 / 1024, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), source: sourceType })}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={clearFile}
                  className="ui-destructive ui-pressable inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-danger-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-danger)]"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                  {t("removeFile")}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {message && (
              <motion.p
                key="import-status"
                initial={{
                  opacity: shouldReduceMotion ? 1 : 0,
                  y: shouldReduceMotion ? 0 : 8,
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: {
                    duration: shouldReduceMotion ? 0 : 0.18,
                    ease: standardEasing,
                  },
                }}
                exit={{
                  opacity: shouldReduceMotion ? 1 : 0,
                  y: shouldReduceMotion ? 0 : 4,
                  transition: {
                    duration: shouldReduceMotion ? 0 : 0.14,
                    ease: standardEasing,
                  },
                }}
                className="mt-5 border-l-4 border-[var(--color-info)] bg-[var(--color-info-soft)] px-4 py-3 text-sm text-[var(--color-text-secondary)]"
                role="status"
              >
                {message}
              </motion.p>
            )}
          </AnimatePresence>

          <div className="mt-8 flex justify-end border-t border-[var(--color-border)] pt-6">
            <button
  type="button"
  onClick={handleContinue}
  disabled={!selectedFile || uploading}
  className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-6 py-2 font-semibold text-white enabled:hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:opacity-50"
>
  <FileUp aria-hidden="true" className="h-4 w-4" />
  {uploading
    ? t("uploading")
    : t("submit")}
</button>
          </div>
          </div>

          <aside className="border-t border-[var(--color-border-strong)] pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" aria-label={t("protocolAccessibleLabel")}>
            <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
              {t("protocolLabel")}
            </p>
            <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">{t("protocolTitle")}</h2>
            <ol className="mt-5 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)] text-sm text-[var(--color-text-secondary)]">
              <li className="py-4">{t("protocolStorage")}</li>
              <li className="py-4">{t("protocolMetrics")}</li>
              <li className="py-4">{t("protocolDetection")}</li>
            </ol>
            <div className="mt-6 flex gap-3 border-l-2 border-[var(--color-forest)] pl-4">
              <ShieldCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--color-forest)]" />
              <p className="text-sm text-[var(--color-text-muted)]">{t("privacyNote")}</p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
