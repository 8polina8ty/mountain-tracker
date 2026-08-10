import {
  Check,
  ExternalLink,
  MapPin,
  Mountain,
  Navigation,
  X,
} from "lucide-react";

import type { SelectedPeak } from "./types";

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
  return (
    <aside
      className="absolute bottom-3 left-3 right-3 z-30 max-h-[calc(100%-24px)] overflow-y-auto rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)] sm:bottom-4 sm:left-auto sm:right-4 sm:w-[400px]"
      aria-labelledby="selected-peak-title"
    >
      <div className="border-b border-[var(--color-border-soft)] px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 [font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
              <Mountain aria-hidden="true" size={15} />
              <span>Выбранная вершина</span>
            </div>

            <h2
              id="selected-peak-title"
              className="mt-2 text-2xl font-bold leading-tight text-[var(--color-text)]"
            >
              {peakName}
            </h2>

            <p className="mt-2 [font-family:var(--font-technical)] text-xl font-bold tabular-nums text-[var(--color-forest)]">
              {peak.height} м
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
            aria-label="Закрыть карточку"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </div>

        <a
          href={`/mountain/${peak.id}`}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-forest)] hover:text-[var(--color-forest-hover)] hover:underline"
        >
          Подробнее о вершине
          <ExternalLink aria-hidden="true" size={14} />
        </a>
      </div>

      <div className="divide-y divide-[var(--color-border-soft)] px-4 sm:px-5">
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <MapPin aria-hidden="true" size={16} />
            <span>Регион</span>
          </div>

          <span className="text-right text-sm font-semibold text-[var(--color-text-secondary)]">
            {peak.name_de ?? "Не указан"}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <Navigation aria-hidden="true" size={16} />
            <span>Координаты</span>
          </div>

          <span className="text-right [font-family:var(--font-technical)] text-xs font-semibold tabular-nums text-[var(--color-text-secondary)]">
            {peak.latitude.toFixed(5)}, {peak.longitude.toFixed(5)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <Mountain aria-hidden="true" size={16} />
            <span>Высота</span>
          </div>

          <span className="[font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text-secondary)]">
            {peak.height} м
          </span>
        </div>
      </div>

      <div className="border-t border-[var(--color-border-soft)] px-4 py-4 sm:px-5">
        <div className="grid grid-cols-2 gap-2">
          <a
            href={`https://www.openstreetmap.org/?mlat=${peak.latitude}&mlon=${peak.longitude}#map=15/${peak.latitude}/${peak.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-10 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
          >
            <MapPin aria-hidden="true" size={14} />
            <span>OpenStreetMap</span>
          </a>

          {wikipediaUrl ? (
            <a
              href={wikipediaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
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

        <button
          type="button"
          onClick={onAscent}
          disabled={ascentLoading}
          className={`mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 text-sm font-bold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] disabled:cursor-wait disabled:opacity-70 ${
            selectedPeakClimbed
              ? "bg-[var(--color-forest-active)]"
              : "bg-[var(--color-forest)] hover:bg-[var(--color-forest-hover)]"
          }`}
        >
          {selectedPeakClimbed && !ascentLoading && (
            <Check aria-hidden="true" size={17} />
          )}
          {ascentLoading
            ? "Сохраняю…"
            : selectedPeakClimbed
              ? "Отменить восхождение"
              : "Взошёл на вершину"}
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
    </aside>
  );
}
