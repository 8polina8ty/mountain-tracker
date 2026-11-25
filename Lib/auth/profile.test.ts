import assert from "node:assert/strict";
import { test } from "node:test";
import { isProfileComplete, needsProfileOnboarding, profileDestination, validateProfileInput, profileErrorKey } from "./profile.ts";
import { normalizeUsername } from "../username.ts";
import { normalizeCountryProgress, normalizeCountryMountainPage, parseCountryMountainFilters } from "../countryProgress.ts";

test("email and Google forms use the same username and explicit country contract", () => {
  assert.equal(normalizeUsername("  Alpine.Name  "), "Alpine.Name");
  assert.equal(validateProfileInput("  Alpine.Name  ", "DE"), null);
  assert.equal(validateProfileInput("Alpine.Name", ""), "countryRequired");
  assert.equal(validateProfileInput("Alpine.Name", "XK"), "countryRequired");
  assert.equal(validateProfileInput("-name", "DE"), "usernameInvalidEdges");
  assert.equal(validateProfileInput(null, "DE"), "usernameRequired");
  assert.equal(profileErrorKey({ code: "23505" }), "usernameUnavailable");
});

test("completed, pending, missing and legacy profiles have distinct authorization states", () => {
  const complete = { username: "Alpine", country_code: "DE", onboarding_required: false };
  const legacy = { username: "A legacy name", country_code: null, onboarding_required: false };
  const pending = { username: null, country_code: null, onboarding_required: true };
  assert.ok(isProfileComplete(complete));
  assert.equal(isProfileComplete(legacy), false);
  assert.equal(needsProfileOnboarding(legacy), false);
  assert.equal(needsProfileOnboarding(complete), false);
  assert.equal(needsProfileOnboarding(pending), true);
  assert.equal(needsProfileOnboarding(null), true);
  assert.equal(profileDestination(complete, "fr", "/account"), "/fr/account");
  assert.equal(profileDestination(legacy, "de", "/account"), "/de/account");
  assert.equal(profileDestination(pending, "en", "//evil.test"), "/en/auth/complete-profile?returnTo=%2Fen%2Fmap");
  assert.equal(isProfileComplete({ ...complete, username: " Alpine " }), false);
});

test("summary accepts authoritative distinct progress and rejects inconsistent totals", () => {
  const progress = { countryCode: "DE", totalMountains: 4, climbedMountains: 1, remainingMountains: 3, progressPercent: 25 };
  assert.deepEqual(normalizeCountryProgress(progress), progress);
  assert.equal(normalizeCountryProgress({ ...progress, remainingMountains: 4 }), null);
  assert.equal(normalizeCountryProgress({ ...progress, progressPercent: 50 }), null);
  assert.equal(normalizeCountryProgress({ ...progress, countryCode: "XK" }), null);
  assert.ok(normalizeCountryProgress({ countryCode: "AD", totalMountains: 0, climbedMountains: 0, remainingMountains: 0, progressPercent: null }));
  assert.ok(normalizeCountryProgress({ countryCode: null, totalMountains: 0, climbedMountains: 0, remainingMountains: 0, progressPercent: null }));
  assert.equal(normalizeCountryProgress({ ...progress, countryCode: null }), null);
});

test("mountain query is bounded, supports bigint IDs and treats wildcards as search data", () => {
  const filters = parseCountryMountainFilters({ search: "100%_peak", min: "-10.5", max: "4000", climbed: "unclimbed", after: "9007199254740993" });
  assert.equal(filters?.result_limit, 20);
  assert.equal(filters?.after_id, "9007199254740993");
  assert.equal(filters?.search, "100%_peak");
  for (const query of [{ min: "NaN" }, { max: "Infinity" }, { min: "10", max: "9" }, { climbed: "unknown" }, { after: "9223372036854775808" }, { search: "x".repeat(101) }]) {
    assert.equal(parseCountryMountainFilters(query), null);
  }
  assert.ok(normalizeCountryMountainPage({ countryCode: "DE", items: [{ id: "9007199254740993", countryCode: "DE", climbed: true, height: 3000 }], nextCursor: null }));
  assert.equal(normalizeCountryMountainPage({ countryCode: "DE", items: [{ id: "1", countryCode: "FR", climbed: true }], nextCursor: null }), null);
  assert.equal(normalizeCountryMountainPage({ countryCode: "DE", items: Array(51).fill({}), nextCursor: null }), null);
});
