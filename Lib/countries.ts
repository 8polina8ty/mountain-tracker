/**
 * Assigned ISO 3166-1 alpha-2 codes, including dependent territories.
 * Source: https://www.iso.org/iso-3166-country-codes.html
 * Names come from the runtime's Unicode CLDR data via Intl.DisplayNames.
 * Never use this catalog to infer residence or remap imported mountain data.
 */
export const COUNTRY_CODES: readonly string[] = Object.freeze(
  (`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
    BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
    CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
    DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
    GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
    HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
    KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
    MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
    NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
    QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
    TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
    VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`).split(/\s+/),
);

const countryCodes = new Set(COUNTRY_CODES);

/** Strict: NULL, composites, aliases (UK), lowercase and unknown codes are invalid. */
export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && countryCodes.has(value);
}

export type CountryOption = { code: string; name: string };

export function getCountryOptions(locale: string): CountryOption[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => collator.compare(a.name, b.name) || a.code.localeCompare(b.code, "en"));
}

export function getCountryName(code: unknown, locale: string): string | null {
  if (!isCountryCode(code)) return null;
  return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
}

export function filterCountryOptions(options: readonly CountryOption[], query: string, locale: string) {
  const normalize = (value: string) => value.normalize("NFD")
    .replace(/\p{M}/gu, "").toLocaleLowerCase(locale);
  const search = normalize(query.trim());
  return options.filter(({ code, name }) =>
    normalize(name).includes(search) || normalize(code).includes(search));
}
