"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { UserGpsPosition } from "./types";

const STALE_THRESHOLD_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 10_000;

function getCardinalDirection(headingDeg: number | null): string | null {
  if (headingDeg === null) {
    return null;
  }

  const normalized = headingDeg % 360;
  const rounded = Math.round(normalized);

  if (rounded >= 348.75 || rounded < 11.25) {
    return "N";
  }
  if (rounded >= 11.25 && rounded < 33.75) {
    return "NNE";
  }
  if (rounded >= 33.75 && rounded < 56.25) {
    return "NE";
  }
  if (rounded >= 56.25 && rounded < 78.75) {
    return "ENE";
  }
  if (rounded >= 78.75 && rounded < 101.25) {
    return "E";
  }
  if (rounded >= 101.25 && rounded < 123.75) {
    return "ESE";
  }
  if (rounded >= 123.75 && rounded < 146.25) {
    return "SE";
  }
  if (rounded >= 146.25 && rounded < 168.75) {
    return "SSE";
  }
  if (rounded >= 168.75 && rounded < 191.25) {
    return "S";
  }
  if (rounded >= 191.25 && rounded < 213.75) {
    return "SSW";
  }
  if (rounded >= 213.75 && rounded < 236.25) {
    return "SW";
  }
  if (rounded >= 236.25 && rounded < 258.75) {
    return "WSW";
  }
  if (rounded >= 258.75 && rounded < 281.25) {
    return "W";
  }
  if (rounded >= 281.25 && rounded < 303.75) {
    return "WNW";
  }
  if (rounded >= 303.75 && rounded < 326.25) {
    return "NW";
  }
  if (rounded >= 326.25 && rounded < 348.75) {
    return "NNW";
  }
  return null;
}

interface GpsStatusPanelProps {
  position: UserGpsPosition;
}

function GpsStatusPanel({ position }: GpsStatusPanelProps) {
  const t = useTranslations("Map.Gps");
  const [now, setNow] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const cardinal = getCardinalDirection(position.headingDeg);
  const isStale =
    now > 0 && position.timestamp < now - STALE_THRESHOLD_MS;
  const speedKmh =
    position.speedMps !== null
      ? position.speedMps * 3.6
      : null;

  return (
    <div
      className="fixed bottom-0 left-1/2 z-20 max-w-[calc(100%-16px)] -translate-x-1/2 rounded-t-[var(--radius-control)] border border-b-0 border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-map-control)]"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-1 text-[var(--color-text)]">
        <div className="w-full truncate text-xs text-[var(--color-text-secondary)]">
          {t("latitude")}: {position.latitude.toFixed(5)}° ·{" "}
          {t("longitude")}: {position.longitude.toFixed(5)}°
        </div>

        <div className="text-sm font-medium">
          {t("altitude")}:{" "}
          {position.altitudeM !== null
            ? `${position.altitudeM.toFixed(0)} m`
            : t("unavailable")}
        </div>

        <div className="text-xs text-[var(--color-text-secondary)]">
          {t("accuracy")}: ±{position.accuracyM.toFixed(0)} m
        </div>

        {position.altitudeAccuracyM !== null && (
          <div className="text-xs text-[var(--color-text-secondary)]">
            {t("altitudeAccuracy")}: ±
            {position.altitudeAccuracyM.toFixed(0)} m
          </div>
        )}

        {speedKmh !== null && (
          <div className="mt-1 text-sm">
            {t("speed")}: {speedKmh.toFixed(1)} km/h
          </div>
        )}

        {cardinal !== null && (
          <div className="text-xs text-[var(--color-text-secondary)]">
            {t("heading")}: {Math.round(position.headingDeg ?? 0)}°{" "}
            {cardinal}
          </div>
        )}

        {isStale && (
          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-warning)]">
            {t("stale")}
          </div>
        )}
      </div>
    </div>
  );
}

export default GpsStatusPanel;