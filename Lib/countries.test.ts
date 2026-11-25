import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COUNTRY_CODES, filterCountryOptions, getCountryName, getCountryOptions, isCountryCode } from "./countries.ts";

test("country catalog covers 249 distinct assigned alpha-2 codes", () => {
  assert.equal(COUNTRY_CODES.length, 249);
  assert.equal(new Set(COUNTRY_CODES).size, 249);
  assert.ok(COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code)));
  for (const code of ["DE", "US", "NZ", "ZA", "JP", "BR", "AQ", "AX", "BQ"]) {
    assert.ok(isCountryCode(code));
  }
});

test("missing, unknown and composite codes are not silently remapped", () => {
  for (const code of [null, undefined, "", " ", "de", " DE", "UK", "EU", "ZZ", "XK", "DE;AT", "DE,AT", ["DE", "AT"]]) {
    assert.equal(isCountryCode(code), false);
    assert.equal(getCountryName(code, "en"), null);
  }
});

test("six locales have localized names, stable sorted options and equal message keys", () => {
  const keys = Object.keys(JSON.parse(readFileSync(new URL("../messages/en/country.json", import.meta.url), "utf8")).Country).sort();
  for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
    const options = getCountryOptions(locale);
    assert.equal(options.length, 249);
    assert.deepEqual(options, getCountryOptions(locale));
    const collator = new Intl.Collator(locale, { sensitivity: "base" });
    for (let i = 1; i < options.length; i++) {
      assert.ok(collator.compare(options[i - 1].name, options[i].name) <= 0);
    }
    assert.ok(options.every((option) => option.name.length > 2));
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}/country.json`, import.meta.url), "utf8")).Country;
    assert.deepEqual(Object.keys(messages).sort(), keys);
    assert.ok(Object.values(messages).every((value) => typeof value === "string" && value.length > 0));
  }
  assert.equal(getCountryName("DE", "de"), "Deutschland");
  assert.equal(getCountryName("DE", "en"), "Germany");
});

test("country search supports code, localized name and diacritics", () => {
  assert.ok(filterCountryOptions(getCountryOptions("fr"), "etats-unis", "fr").some((c) => c.code === "US"));
  assert.ok(filterCountryOptions(getCountryOptions("ru"), "герм", "ru").some((c) => c.code === "DE"));
  assert.ok(filterCountryOptions(getCountryOptions("en"), "nz", "en").some((c) => c.code === "NZ"));
  assert.deepEqual(filterCountryOptions(getCountryOptions("en"), "no such country 123", "en"), []);
});
