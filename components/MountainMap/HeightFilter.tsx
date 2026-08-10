import { RotateCcw } from "lucide-react";

import {
  MAX_HEIGHT,
  MIN_HEIGHT,
  PEAK_COLORS,
} from "./constants";

type HeightFilterProps = {
  minimumHeight: number;
  onHeightChange: (height: number) => void;
  onReset: () => void;
};

export default function HeightFilter({
  minimumHeight,
  onHeightChange,
  onReset,
}: HeightFilterProps) {
  const altitudeRanges = [
    { label: "700–999 м", color: PEAK_COLORS.low },
    { label: "1000–1299 м", color: PEAK_COLORS.mediumLow },
    { label: "1300–1599 м", color: PEAK_COLORS.medium },
    { label: "1600–1999 м", color: PEAK_COLORS.mediumHigh },
    { label: "2000–3999 м", color: PEAK_COLORS.high },
    { label: "4000–5999 м", color: PEAK_COLORS.veryHigh },
    { label: "6000–8000 м", color: PEAK_COLORS.extreme },
  ];

  return (
    <section className="pt-4" aria-labelledby="height-filter-label">
      <label className="block" htmlFor="minimum-height">
        <div className="mb-3 flex items-end justify-between gap-3">
          <span
            id="height-filter-label"
            className="text-xs font-semibold text-[var(--color-text-secondary)]"
          >
            Минимальная высота
          </span>

          <span className="[font-family:var(--font-technical)] text-lg font-bold leading-none tabular-nums text-[var(--color-forest)]">
            {minimumHeight} м
          </span>
        </div>

        <input
          id="minimum-height"
          type="range"
          min={MIN_HEIGHT}
          max={MAX_HEIGHT}
          step={50}
          value={minimumHeight}
          onChange={(event) => {
            onHeightChange(Number(event.target.value));
          }}
          className="h-2 w-full cursor-pointer [accent-color:var(--color-forest)]"
        />

        <span className="mt-1 flex justify-between [font-family:var(--font-technical)] text-[10px] text-[var(--color-text-muted)]">
          <span>{MIN_HEIGHT} м</span>
          <span>{MAX_HEIGHT} м</span>
        </span>
      </label>

      <div className="mt-4 border-t border-[var(--color-border-soft)] pt-3">
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          Высотные зоны
        </p>

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {altitudeRanges.map((range) => (
            <div
              key={range.label}
              className="flex items-center gap-2 [font-family:var(--font-technical)] text-[11px] leading-4 text-[var(--color-text-secondary)]"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: range.color }}
                aria-hidden="true"
              />
              <span>{range.label}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="ui-pressable mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-transparent px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
      >
        <RotateCcw aria-hidden="true" size={14} />
        Сбросить фильтры
      </button>
    </section>
  );
}
