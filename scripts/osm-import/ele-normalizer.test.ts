import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEle,
  ELE_PLAUSIBLE_MIN_METERS,
  ELE_PLAUSIBLE_MAX_METERS,
} from "./ele-normalizer.ts";

test("exact integer meters parse as VALID_METERS", () => {
  const r = normalizeEle("1234");
  assert.equal(r.status, "VALID_METERS");
  assert.equal(r.normalizedMeters, 1234);
});

test("decimal meters parse as VALID_METERS", () => {
  const r = normalizeEle("1234.5");
  assert.equal(r.status, "VALID_METERS");
  assert.equal(r.normalizedMeters, 1234.5);
});

test("explicit m unit suffix is preserved as meters", () => {
  const r = normalizeEle("1234 m");
  assert.equal(r.status, "VALID_METERS");
  assert.equal(r.normalizedMeters, 1234);
});

test("feet are intentionally converted", () => {
  const r = normalizeEle("4000 ft");
  assert.equal(r.status, "VALID_CONVERTED_FEET");
  assert.equal(r.normalizedMeters, Math.round(4000 * 0.3048 * 100) / 100);
  assert.equal(r.feet, 4000);
});

test("comma thousands/decimal is ambiguous and never silently parsed", () => {
  const r = normalizeEle("1,234");
  assert.equal(r.status, "AMBIGUOUS_ELE");
  assert.equal(r.normalizedMeters, null);
});

test("Swiss dotted u.M. form is meters", () => {
  const r = normalizeEle("1234 ü. M.");
  assert.equal(r.status, "VALID_METERS");
  assert.equal(r.normalizedMeters, 1234);
});

test("ambiguous bare local suffixes are rejected", () => {
  assert.equal(normalizeEle("1234 üM").status, "INVALID_ELE");
  assert.equal(normalizeEle("1234 m.s.l.").status, "INVALID_ELE");
});

test("garbage text is invalid", () => {
  assert.equal(normalizeEle("abc").status, "INVALID_ELE");
  assert.equal(normalizeEle("").status, "INVALID_ELE");
});

test("implausible out-of-range meters fail closed", () => {
  const low = normalizeEle(String(ELE_PLAUSIBLE_MIN_METERS - 1));
  assert.equal(low.status, "INVALID_ELE");
  const high = normalizeEle(String(ELE_PLAUSIBLE_MAX_METERS + 1));
  assert.equal(high.status, "INVALID_ELE");
});

test("multiple decimal points are invalid", () => {
  assert.equal(normalizeEle("12.34.5").status, "INVALID_ELE");
});

test("WHITESPACE is trimmed", () => {
  const r = normalizeEle("  800  ");
  assert.equal(r.status, "VALID_METERS");
  assert.equal(r.normalizedMeters, 800);
});
