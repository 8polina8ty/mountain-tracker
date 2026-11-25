import { Search, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { getCountryOptions } from "@/Lib/countries";
import { MAX_MOUNTAIN_SEARCH_LENGTH } from "./mountainSearch";

type SearchPanelProps = {
  searchInput: string;
  searchMessage: string;
  searching: boolean;
  countryCode: string;
  appliedSearch: string;
  visiblePeakCount: number;
  onSearchInputChange: (value: string) => void;
  onCountryChange: (value: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
};

export default function SearchPanel({
  searchInput,
  searchMessage,
  searching,
  countryCode,
  appliedSearch,
  visiblePeakCount,
  onSearchInputChange,
  onCountryChange,
  onSearch,
  onClearSearch,
}: SearchPanelProps) {
  const t = useTranslations("Map.Search");
  const locale = useLocale();
  const countries = useMemo(() => getCountryOptions(locale), [locale]);
  const kosovo = new Intl.DisplayNames([locale], { type: "region" }).of("XK") ?? "XK";

  return (
    <section aria-labelledby="mountain-search-label">
      <form
        aria-busy={searching}
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <label
          id="mountain-search-label"
          htmlFor="mountain-search"
          className="mb-2 block text-[12px] font-semibold leading-none tracking-wide text-[var(--color-text-muted)]"
        >
          {t("label")}
        </label>

          <div className="flex items-center gap-1.5 rounded-[18px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-xs)] transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-within:border-[var(--color-focus)] focus-within:shadow-[var(--shadow-sm)] focus-within:ring-2 focus-within:ring-[var(--color-focus-halo)]">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              size={18}
            />
            <input
              id="mountain-search"
              type="text"
              maxLength={MAX_MOUNTAIN_SEARCH_LENGTH}
              value={searchInput}
              onChange={(event) => {
                onSearchInputChange(event.target.value);
              }}
              placeholder={t("placeholder")}
              className="h-[52px] w-full min-w-0 rounded-[14px] bg-[var(--color-surface)] py-2 pl-10 pr-11 text-[15px] font-medium text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] placeholder:font-normal"
            />

            {searchInput && (
              <button
                type="button"
                onClick={onClearSearch}
                className="ui-pressable absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)] focus-visible:outline-offset-[-2px]"
                aria-label={t("clearInput")}
              >
                <X aria-hidden="true" size={16} />
              </button>
            )}
          </div>

          <button
            type="submit"
            className="ui-pressable inline-flex h-[52px] shrink-0 items-center justify-center rounded-[14px] bg-[var(--color-forest)] px-[14px] text-[14px] font-bold tracking-wide text-white shadow-[var(--shadow-xs)] hover:bg-[var(--color-forest-hover)] hover:shadow-[var(--shadow-sm)] active:translate-y-[1px] focus-visible:outline-offset-[-2px]"
          >
            {t("submit")}
          </button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          {t("countryLabel")}
          <select
            value={countryCode}
            onChange={(event) => onCountryChange(event.target.value)}
            className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
          >
            <option value="">{t("allCountries")}</option>
            {countries.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
            <option value="XK">{kosovo}</option>
          </select>
        </label>
      </form>

      <div className="mt-[10px] flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div>
          <p className="sr-only">
            {t("visiblePeaks")}
          </p>
          <p className="text-[13px] font-medium tabular-nums text-[var(--color-text-muted)]">
            {t("peakCount", { count: visiblePeakCount })}
          </p>
        </div>

        {appliedSearch && (
          <button
            type="button"
            onClick={onClearSearch}
            className="ui-pressable min-h-11 text-xs font-semibold text-[var(--color-forest)] hover:text-[var(--color-forest-hover)] hover:underline"
          >
            {t("removeSearch")}
          </button>
        )}
      </div>

      {searchMessage && (
        <p
          className="mt-3 border-l-2 border-[var(--color-glacier)] pl-3 text-xs font-medium leading-5 text-[var(--color-text-secondary)]"
          role="status"
          aria-live="polite"
        >
          {searchMessage}
        </p>
      )}
    </section>
  );
}
