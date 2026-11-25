import type { Dispatch, SetStateAction } from "react";
import { useTranslations } from "next-intl";
import { MAX_HEIGHT, MIN_HEIGHT } from "./constants";
import { ALTITUDE_PRESETS, type MountainFilterDraft } from "./mountainFilters";

export type MapFilterKind = "all" | "height" | "status";

type Props = {
  id: string;
  kind: MapFilterKind;
  mobile: boolean;
  draft: MountainFilterDraft;
  setDraft: Dispatch<SetStateAction<MountainFilterDraft>>;
  error: string | null;
  onBlur: () => void;
};

export default function MapFilterFields({ id, kind, mobile, draft, setDraft, error, onBlur }: Props) {
  const t = useTranslations("Map.Filter");
  return (
    <div className="space-y-7">
      {kind !== "status" && (
        <fieldset>
          <legend className={kind === "height" ? "sr-only" : "mb-3 text-lg font-bold"}>{t("height")}</legend>
          <div className="grid grid-cols-2 gap-3">
            {(["minHeight", "maxHeight"] as const).map((bound) => (
              <div key={bound} className="min-w-0">
                <label htmlFor={`${id}-${bound}`} className="mb-1.5 block text-[12px] font-semibold leading-none tracking-wide text-[var(--color-text-muted)]">
                  {t(bound === "minHeight" ? "from" : "to")}
                </label>
                <div className="relative">
                  <input id={`${id}-${bound}`} type="number" inputMode="numeric"
                    min={MIN_HEIGHT} max={MAX_HEIGHT} step={1} value={draft[bound]}
                    onChange={(event) => setDraft({ ...draft, [bound]: event.target.value })}
                    onBlur={onBlur}
                    aria-invalid={Boolean(error)}
                    aria-describedby={`${id}-bounds${error ? ` ${id}-error` : ""}`}
                    className={`w-full rounded-[14px] border bg-[var(--color-surface)] px-3 pr-10 text-[16px] font-semibold tabular-nums shadow-[var(--shadow-xs)] outline-none transition-[border-color,box-shadow] focus:border-[var(--color-forest)] focus:ring-2 focus:ring-[var(--color-focus-halo)] ${mobile ? "h-[52px]" : "h-12"} ${error ? "border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[var(--color-danger-soft)]" : "border-[var(--color-border-soft)] hover:border-[var(--color-border)]"}`} />
                  <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] font-medium text-[var(--color-text-muted)]">{t("meters")}</span>
                </div>
              </div>
            ))}
          </div>
          <p id={`${id}-bounds`} className="mt-2 text-xs text-[var(--color-text-muted)]">
            {t("presetRange", { min: MIN_HEIGHT, max: MAX_HEIGHT })}
          </p>
          {error && <p id={`${id}-error`} role="alert" className="mt-2 text-[12px] font-medium text-[var(--color-danger)]">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t("altitudeZones")}>
            {ALTITUDE_PRESETS.map((preset) => {
              const active = draft.minHeight === String(preset.minHeight) && draft.maxHeight === String(preset.maxHeight);
              return (
                <button key={preset.minHeight} type="button" aria-pressed={active}
                  onClick={() => setDraft({ ...draft, minHeight: String(preset.minHeight), maxHeight: String(preset.maxHeight) })}
                  className="flex min-h-[36px] items-center focus-visible:outline-offset-0">
                  <span className={`flex h-[34px] items-center rounded-[12px] border px-3 text-[13px] font-semibold tabular-nums transition-colors ${active
                    ? "border-[var(--color-forest)] bg-[var(--color-forest)] text-white shadow-[var(--shadow-xs)]"
                    : "border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)]"}`}>
                    {t("presetRange", { min: preset.minHeight, max: preset.maxHeight })}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      {kind !== "height" && (
        <fieldset>
          <legend className={kind === "status" ? "sr-only" : "mb-2 text-lg font-bold"}>{t("status")}</legend>
          {(["all", "climbed", "unclimbed"] as const).map((status) => {
            const selected = draft.ascentStatus === status;
            return (
              <label key={status} className={`flex min-h-[48px] cursor-pointer items-center gap-3 rounded-[10px] px-2 transition-colors ${selected ? "bg-[var(--color-success-soft)] text-[var(--color-forest)]" : "hover:bg-[var(--color-surface-muted)]"}`}>
                <input type="radio" name={`${id}-ascent`} value={status} checked={selected}
                  onChange={() => setDraft({ ...draft, ascentStatus: status })}
                  className="h-5 w-5 shrink-0 accent-[var(--color-forest)]" />
                <span className="text-[14px] font-medium">{t(status)}</span>
              </label>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
