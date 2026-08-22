import {
  Check,
  ExternalLink,
  MapPin,
  Mountain,
  Navigation,
  X,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Link } from "@/i18n/navigation";
import ProjectPicker from "@/components/projects/ProjectPicker";
import type { SelectedPeak } from "./types";

const standardEasing = [0.2, 0, 0, 1] as const;
const sidePanelQuery = "(min-width: 1024px)";

function useSidePanel() {
  const [isSidePanel, setIsSidePanel] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia(sidePanelQuery).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(sidePanelQuery);

    function handleChange(event: MediaQueryListEvent) {
      setIsSidePanel(event.matches);
    }

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  return isSidePanel;
}

type PeakDetailsPanelProps = {
  peak: SelectedPeak;
  peakName: string;
  wikipediaUrl: string | null;
  selectedPeakClimbed: boolean;
  ascentLoading: boolean;
  ascentMessage: string;
  onClose: () => void;
  onAscent: () => void;
};

export default function PeakDetailsPanel({
  peak,
  peakName,
  wikipediaUrl,
  selectedPeakClimbed,
  ascentLoading,
  ascentMessage,
  onClose,
  onAscent,
}: PeakDetailsPanelProps) {
  const t = useTranslations("Map.PeakDetails");
  const shouldReduceMotion = useReducedMotion();
  const isSidePanel = useSidePanel();

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  return (
    <motion.aside
      initial={{
        opacity: shouldReduceMotion ? 1 : isSidePanel ? 0 : 0.92,
        x: shouldReduceMotion || !isSidePanel ? 0 : 16,
        y: shouldReduceMotion || isSidePanel ? 0 : 32,
      }}
      animate={{
        opacity: 1,
        x: 0,
        y: 0,
        transition: shouldReduceMotion
          ? { duration: 0 }
          : isSidePanel
            ? { duration: 0.2, ease: standardEasing }
            : {
                y: {
                  type: "spring",
                  stiffness: 400,
                  damping: 38,
                  mass: 0.9,
                },
                opacity: {
                  duration: 0.18,
                  ease: standardEasing,
                },
              },
      }}
      exit={{
        opacity: shouldReduceMotion ? 1 : 0,
        x: shouldReduceMotion || !isSidePanel ? 0 : 12,
        y: shouldReduceMotion || isSidePanel ? 0 : 24,
        transition: {
          duration: shouldReduceMotion ? 0 : isSidePanel ? 0.16 : 0.17,
          ease: standardEasing,
        },
      }}
      className="absolute bottom-0 left-0 right-0 z-30 max-h-[min(78dvh,calc(100%-12px))] overflow-y-auto rounded-t-[var(--radius-sheet)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)] sm:bottom-3 sm:left-3 sm:right-3 sm:rounded-[var(--radius-panel)] lg:bottom-4 lg:left-auto lg:right-4 lg:w-[400px]"
      aria-labelledby="selected-peak-title"
    >
      <div className="border-b border-[var(--color-border-soft)] px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
              <Mountain aria-hidden="true" size={15} />
              <span>{t("selectedPeak")}</span>
            </div>

            <h2
              id="selected-peak-title"
              className="mt-2 text-2xl font-bold leading-tight text-[var(--color-text)]"
            >
              {peakName}
            </h2>

            <p className="mt-2 [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-forest)]">
              {peak.height} {t("meterUnit")}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="ui-pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
            aria-label={t("closePanel")}
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        <Link
          href={`/mountain/${peak.id}`}
          className="ui-pressable group mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-forest)] hover:text-[var(--color-forest-hover)] hover:underline"
        >
          {t("moreAboutPeak")}
          <ExternalLink aria-hidden="true" className="transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5" size={14} />
        </Link>
      </div>

      <div className="divide-y divide-[var(--color-border-soft)] px-4 sm:px-5">
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <MapPin aria-hidden="true" size={16} />
            <span>{t("region")}</span>
          </div>

          <span className="text-right text-sm font-semibold text-[var(--color-text-secondary)]">
            {peak.name_de ?? t("notSpecified")}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <Navigation aria-hidden="true" size={16} />
            <span>{t("coordinates")}</span>
          </div>

          <span className="text-right [font-family:var(--font-technical)] text-xs font-semibold tabular-nums text-[var(--color-text-secondary)]">
            {peak.latitude.toFixed(5)}, {peak.longitude.toFixed(5)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <Mountain aria-hidden="true" size={16} />
            <span>{t("elevation")}</span>
          </div>

          <span className="[font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text-secondary)]">
            {peak.height} {t("meterUnit")}
          </span>
        </div>
      </div>

      <div className="border-t border-[var(--color-border-soft)] px-4 py-4 sm:px-5">
        <div className="grid grid-cols-2 gap-2">
          <a
            href={`https://www.openstreetmap.org/?mlat=${peak.latitude}&mlon=${peak.longitude}#map=15/${peak.latitude}/${peak.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ui-pressable flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
          >
            <MapPin aria-hidden="true" size={14} />
            <span>OpenStreetMap</span>
          </a>

          {wikipediaUrl ? (
            <a
              href={wikipediaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ui-pressable flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
            >
              <span className="font-serif text-base" aria-hidden="true">
                W
              </span>
              <span>Wikipedia</span>
            </a>
          ) : (
            <div className="flex min-h-10 cursor-not-allowed items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] px-3 text-xs font-semibold text-[var(--color-text-disabled)]">
              <span className="font-serif text-base" aria-hidden="true">
                W
              </span>
              <span>Wikipedia</span>
            </div>
          )}
        </div>

        <ProjectPicker mountainId={peak.id} mountainName={peakName} context="map" />

        <button
          type="button"
          onClick={onAscent}
          disabled={ascentLoading}
          className={`ui-pressable mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 text-sm font-bold shadow-[var(--shadow-control)] disabled:cursor-wait disabled:opacity-70 ${
            selectedPeakClimbed
              ? "ui-destructive border-[var(--color-danger-border)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
              : "border-[var(--color-forest)] bg-[var(--color-forest)] text-[var(--color-text-inverse)] enabled:hover:bg-[var(--color-forest-hover)]"
          }`}
        >
          {selectedPeakClimbed && !ascentLoading && (
            <Check aria-hidden="true" size={17} />
          )}
          {ascentLoading
            ? t("saving")
            : selectedPeakClimbed
              ? t("removeAscent")
              : t("markClimbed")}
        </button>

        {ascentMessage && (
          <p
            className={`mt-2 text-center text-xs font-semibold ${
              selectedPeakClimbed
                ? "text-[var(--color-success)]"
                : "text-[var(--color-danger)]"
            }`}
            role="status"
            aria-live="polite"
          >
            {ascentMessage}
          </p>
        )}
      </div>
    </motion.aside>
  );
}
