"use client";

import { useEffect, useRef, useState } from "react";
import {
  CircleDot,
  Download,
  Flag,
  Pause,
  Play,
  RotateCcw,
  Save,
  LogIn,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";

import type { UserGpsPosition } from "./types";
import type { GpsTrackRecorder } from "./useGpsTrackRecorder";
import {
  buildGpxFilename,
  buildGpxTrackName,
  buildGpxXml,
  formatDistanceValue,
  getActiveDurationMs,
  getDurationParts,
  usesKilometers,
} from "./trackRecording";
import {
  SaveRecordedTrackAuthenticationError,
  saveRecordedTrack,
} from "./saveRecordedTrack";
import {
  clearPendingRecordingDraft,
  loadPendingRecordingDraft,
  persistPendingRecordingDraft,
} from "./pendingRecordingDraft";

type GpsTrackRecorderPanelProps = {
  recorder: GpsTrackRecorder;
  latestGpsPosition: UserGpsPosition | null;
};

function TrackStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
        {label}
      </p>
      <p className="mt-0.5 truncate [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
        {value}
      </p>
    </div>
  );
}

export default function GpsTrackRecorderPanel({
  recorder,
  latestGpsPosition,
}: GpsTrackRecorderPanelProps) {
  const t = useTranslations("Map.TrackRecorder");
  const tNavigation = useTranslations("Navigation");
  const locale = useLocale();
  const router = useRouter();

  const { status, points, startedAt, finishedAt } =
    recorder.state;
  const { pointCount, distanceM, elevationGainM, hasAltitudeData } =
    recorder.stats;

  const [now, setNow] = useState(() => Date.now());

  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState("");
  const [saveRequiresLogin, setSaveRequiresLogin] = useState(false);
  const [trackName, setTrackName] = useState("");
  const saveInFlightRef = useRef(false);
  const draftRestoreStartedRef = useRef(false);

  useEffect(() => {
    if (status !== "recording") {
      return;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (draftRestoreStartedRef.current || status !== "idle") {
      return;
    }

    draftRestoreStartedRef.current = true;
    const draft = loadPendingRecordingDraft();
    if (!draft) {
      return;
    }

    queueMicrotask(() => {
      setTrackName(draft.trackName);
      recorder.restoreFinished({
        points: draft.points,
        startedAt: draft.startedAt,
        finishedAt: draft.finishedAt,
        activeDurationMs: draft.activeDurationMs,
      });
    });
  }, [recorder, status]);

  const activeDurationMsLive = getActiveDurationMs(
    recorder.state,
    now,
  );

  const durationParts = getDurationParts(activeDurationMsLive);

  const durationLabel =
    durationParts.hours > 0
      ? t("durationHoursMinutes", {
          hours: durationParts.hours,
          minutes: durationParts.minutes,
        })
      : durationParts.minutes > 0
        ? t("durationMinutes", {
            minutes: durationParts.minutes,
          })
        : t("durationSeconds", {
            seconds: durationParts.seconds,
          });

  const distanceValue = formatDistanceValue(distanceM, locale);

  const distanceLabel = `${distanceValue} ${
    usesKilometers(distanceM)
      ? t("kilometerUnit")
      : t("meterUnit")
  }`;

  const elevationLabel = hasAltitudeData
    ? `${Math.round(elevationGainM)} ${t("meterUnit")}`
    : t("unavailable");

  const canFinish = pointCount >= 2;

  useEffect(() => {
    if (!startedAt || !finishedAt || status !== "finished" || points.length < 2) {
      return;
    }

    persistPendingRecordingDraft(
      {
        points,
        startedAt,
        finishedAt,
        activeDurationMs: activeDurationMsLive,
      },
      trackName,
    );
  }, [activeDurationMsLive, finishedAt, points, startedAt, status, trackName]);

  function handleStart() {
    setNow(Date.now());
    recorder.start(latestGpsPosition);
  }

  function handleResume() {
    setNow(Date.now());
    recorder.resume();
  }

  function handleFinish() {
    if (startedAt) {
      const date = new Date(startedAt).toLocaleDateString(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      setTrackName(t("trackNameDefault", { date }));
    }
    recorder.finish();
  }

  function handleExportGpx() {
    if (!startedAt || points.length < 2) {
      return;
    }

    const xml = buildGpxXml(
      points,
      buildGpxTrackName(startedAt),
    );

    const blob = new Blob([xml], {
      type: "application/gpx+xml",
    });

    const objectUrl = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = buildGpxFilename(startedAt);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(objectUrl);
  }

  async function handleSaveTrack() {
    if (
      !startedAt ||
      !finishedAt ||
      points.length < 2 ||
      saveInFlightRef.current ||
      saveState === "saved"
    ) {
      return;
    }

    saveInFlightRef.current = true;
    persistPendingRecordingDraft(
      { points, startedAt, finishedAt, activeDurationMs: activeDurationMsLive },
      trackName,
    );
    setSaveState("saving");
    setSaveError("");
    setSaveRequiresLogin(false);

    try {
      await saveRecordedTrack({
        points,
        startedAt,
        finishedAt,
        activeDurationMs: activeDurationMsLive,
        trackName: trackName.trim() || undefined,
        authenticationErrorMessage: t("loginToSave"),
      });

      clearPendingRecordingDraft();
      setSaveState("saved");
      router.push("/account/tracks");
      router.refresh();
    } catch (error) {
      console.error("Ошибка сохранения трека:", error);
      setSaveError(
        error instanceof SaveRecordedTrackAuthenticationError
          ? t("loginToSave")
          : error instanceof Error
          ? error.message
          : t("saveFailed"),
      );
      setSaveRequiresLogin(
        error instanceof SaveRecordedTrackAuthenticationError,
      );
      setSaveState("error");
    } finally {
      saveInFlightRef.current = false;
    }
  }

  function handleRetrySave() {
    void handleSaveTrack();
  }

  function handleReset() {
    saveInFlightRef.current = false;
    setSaveState("idle");
    setSaveError("");
    setSaveRequiresLogin(false);
    setTrackName("");
    clearPendingRecordingDraft();
    recorder.reset();
  }

  const buttonBase =
    "ui-pressable flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border px-3 text-sm font-bold";

  return (
    <section
      aria-label={t("trackRecording")}
      className="w-full overflow-hidden rounded-t-[var(--radius-sheet)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)] lg:rounded-[var(--radius-panel)] lg:shadow-[var(--shadow-map-control)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
        <p className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          <CircleDot aria-hidden="true" size={14} />
          <span>{t("trackRecording")}</span>
        </p>

        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text)]"
        >
          {status === "recording" && (
            <span
              aria-hidden="true"
              className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-danger)]"
            />
          )}
          {status === "paused" && (
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-[var(--color-warning)]"
            />
          )}
          {status === "finished" && (
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-[var(--color-success)]"
            />
          )}
          {status === "recording"
            ? t("recording")
            : status === "paused"
              ? t("paused")
              : status === "finished"
                ? t("trackComplete")
                : t("trackRecording")}
        </p>
      </header>

      {status === "idle" && (
        <p className="px-4 pb-1 text-xs font-medium text-[var(--color-text-secondary)]">
          {latestGpsPosition ? t("gpsReady") : t("waitingForGps")}
        </p>
      )}

      {(status === "recording" ||
        status === "paused" ||
        status === "finished") && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-4">
          <TrackStat label={t("distance")} value={distanceLabel} />
          <TrackStat label={t("duration")} value={durationLabel} />
          <TrackStat label={t("elevationGain")} value={elevationLabel} />
          <TrackStat
            label={t("points")}
            value={t("pointCount", { count: pointCount })}
          />
        </div>
      )}

      {(status === "recording" || status === "paused") && (
        <div className="space-y-1 px-4 pb-1">
          {status === "recording" &&
            pointCount === 0 &&
            !recorder.gpsUnavailable && (
              <p className="text-xs font-medium text-[var(--color-text-secondary)]">
                {t("waitingForGps")}
              </p>
            )}

          {recorder.gpsUnavailable && (
            <p className="text-xs font-medium text-[var(--color-warning)]">
              {t("gpsUnavailable")}
            </p>
          )}

          {status === "recording" &&
            recorder.state.lastRejectedReason === "accuracy" && (
              <p className="text-xs font-medium text-[var(--color-warning)]">
                {t("poorGpsAccuracy")}
              </p>
            )}

          {!canFinish && (
            <p className="text-xs font-medium text-[var(--color-text-muted)]">
              {t("needMorePoints")}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2 border-t border-[var(--color-border-soft)] px-4 py-3">
        {status === "idle" && (
          <button
            type="button"
            onClick={handleStart}
            className={`${buttonBase} border-[var(--color-forest)] bg-[var(--color-forest)] text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]`}
          >
            <Play aria-hidden="true" size={16} />
            {t("startRecording")}
          </button>
        )}

        {(status === "recording" || status === "paused") && (
          <>
            {status === "recording" ? (
              <button
                type="button"
                onClick={recorder.pause}
                className={`${buttonBase} border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]`}
              >
                <Pause aria-hidden="true" size={16} />
                {t("pauseRecording")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleResume}
                className={`${buttonBase} border-[var(--color-forest)] bg-[var(--color-forest)] text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]`}
              >
                <Play aria-hidden="true" size={16} />
                {t("resumeRecording")}
              </button>
            )}

            <button
              type="button"
              onClick={handleFinish}
              disabled={!canFinish}
              className={`${buttonBase} border-[var(--color-forest)] bg-[var(--color-forest)] text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:border-[var(--color-border-soft)] disabled:bg-[var(--color-surface-muted)] disabled:text-[var(--color-text-disabled)]`}
            >
              <Flag aria-hidden="true" size={16} />
              {t("finishRecording")}
            </button>
          </>
        )}

        {status === "finished" && (
          <>
            <button
              type="button"
              onClick={handleExportGpx}
              className={`${buttonBase} border-[var(--color-forest)] bg-[var(--color-forest)] text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]`}
            >
              <Download aria-hidden="true" size={16} />
              {t("exportGpx")}
            </button>

            <button
              type="button"
              onClick={handleReset}
              disabled={saveState === "saving"}
              className={`${buttonBase} ui-destructive border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-text)]`}
            >
              <RotateCcw aria-hidden="true" size={16} />
              {t("resetRecording")}
            </button>
          </>
        )}
      </div>

      {status === "finished" && (
        <div className="space-y-3 border-t border-[var(--color-border-soft)] px-4 py-3">
          <label
            htmlFor="recorded-track-name"
            className="block text-xs font-semibold text-[var(--color-text-secondary)]"
          >
            {t("trackName")}
          </label>
          <input
            id="recorded-track-name"
            value={trackName}
            onChange={(event) => setTrackName(event.target.value)}
            disabled={saveState === "saving" || saveState === "saved"}
            maxLength={160}
            className="ui-field min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-sm text-[var(--color-text)] outline-none disabled:opacity-60"
          />

          <button
            type="button"
            onClick={() => void handleSaveTrack()}
            disabled={saveState === "saving" || saveState === "saved"}
            className={`${buttonBase} w-full border-[var(--color-forest)] bg-[var(--color-forest)] text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <Save aria-hidden="true" size={16} />
            {saveState === "saving"
              ? t("savingTrack")
              : saveState === "saved"
                ? t("trackSaved")
                : t("saveTrack")}
          </button>

          {saveState === "error" && (
            <div role="alert" className="space-y-2 text-xs text-[var(--color-danger)]">
              <p>{saveError || t("saveFailed")}</p>
              <button
                type="button"
                onClick={handleRetrySave}
                className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-danger-border)] px-3 font-semibold"
              >
                {t("retrySave")}
              </button>
              {saveRequiresLogin && (
                <Link
                  href="/auth/login?returnTo=/record"
                  className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] px-3 font-semibold text-[var(--color-text)]"
                >
                  <LogIn aria-hidden="true" size={15} />
                  {tNavigation("login")}
                </Link>
              )}
            </div>
          )}

          {saveState === "saved" && (
            <p
              role="status"
              aria-live="polite"
              className="text-xs font-semibold text-[var(--color-success)]"
            >
              {t("trackSaved")}
            </p>
          )}
        </div>
      )}

      {status === "finished" && (
        <p className="px-4 pb-3 text-[10px] leading-4 text-[var(--color-text-muted)]">
          {t("trackLostOnReload")}
        </p>
      )}
    </section>
  );
}
