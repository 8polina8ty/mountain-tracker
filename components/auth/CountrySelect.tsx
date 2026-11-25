"use client";

import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { filterCountryOptions, getCountryOptions, isCountryCode } from "@/Lib/countries";

type CountrySelectProps = {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string;
};

/** Search followed by a native select retains keyboard and screen-reader behavior. */
export default function CountrySelect({ value, onChange, disabled, required = true, error }: CountrySelectProps) {
  const t = useTranslations("Country");
  const locale = useLocale();
  const id = useId();
  const [search, setSearch] = useState("");
  const countries = useMemo(() => getCountryOptions(locale), [locale]);
  const filtered = filterCountryOptions(countries, search, locale);
  // Keep the explicit selection when the search changes; never pick the first match.
  const selected = countries.find((country) => country.code === value);
  const options = selected && !filtered.some((country) => country.code === value)
    ? [selected, ...filtered] : filtered;
  const description = `${id}-description`;

  const flag = (code: string) => {
    if (!isCountryCode(code)) return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  };
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-sm font-semibold">{t("residence")}</legend>
      <label htmlFor={`${id}-search`} className="sr-only">{t("search")}</label>
      <input id={`${id}-search`} type="search" value={search}
        onChange={(event) => setSearch(event.target.value)} placeholder={t("search")}
        autoComplete="off" className="ui-field min-h-12 w-full px-3.5 text-[14px]" />
      <label htmlFor={id} className="sr-only">{t("choose")}</label>
      <div className="relative">
        {isCountryCode(value) && <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[16px]">{flag(value)}</span>}
        <select id={id} name="country_code" required={required}
          value={isCountryCode(value) ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)} aria-describedby={`${description}${error ? ` ${id}-error` : ""}`}
          className={`ui-field min-h-12 w-full bg-[var(--color-surface)] px-3.5 text-[14px] ${isCountryCode(value) ? "pl-9" : ""}`}>
          <option value="">{t("choose")}</option>
          {options.map(({ code, name }) => <option key={code} value={code}>{flag(code)} {name} ({code})</option>)}
        </select>
      </div>
      <p id={description} className="text-xs leading-relaxed text-[var(--color-text-muted)]">{t("description")}</p>
      {filtered.length === 0 && <p role="status" className="text-xs text-[var(--color-text-muted)]">{t("noResults")}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
    </fieldset>
  );
}
