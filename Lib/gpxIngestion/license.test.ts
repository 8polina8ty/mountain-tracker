import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLicense,
  evaluateSourcePolicy,
  isPromotable,
} from "./license.ts";
import type { SourceRightsPolicy } from "./types.ts";

const ALLOWED_POLICY: SourceRightsPolicy = {
  licenseStatus: "ALLOWED",
  accessPermissionStatus: "ALLOWED",
  redistributionPermissionStatus: "ALLOWED",
  rawGpxRetentionPermission: "ALLOWED",
  normalizedGeometryPublicationPermission: "ALLOWED",
  attributionRequired: true,
  attributionText: "Example Data contributors",
  lastVerifiedAt: "2026-09-01T00:00:00.000Z",
};

test("missing license fails closed", () => {
  assert.equal(classifyLicense(null).status, "BLOCKED");
  assert.equal(classifyLicense("  ").status, "BLOCKED");
});

test("recognized license still requires a source-specific review", () => {
  const result = classifyLicense("CC-BY-4.0");
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.spdx, "CC-BY-4.0");
});

test("restrictive declared terms are blocked", () => {
  assert.equal(classifyLicense("All rights reserved").status, "BLOCKED");
  assert.equal(classifyLicense("CC-BY-NC-4.0").status, "BLOCKED");
});

test("all required source-registry permissions must be explicitly allowed", () => {
  const result = evaluateSourcePolicy(ALLOWED_POLICY);
  assert.equal(result.status, "ALLOWED");
  assert.equal(result.mayDiscover, true);
  assert.equal(result.mayPublishNormalizedGeometry, true);
});

test("one review-required permission blocks ingestion", () => {
  const result = evaluateSourcePolicy({
    ...ALLOWED_POLICY,
    redistributionPermissionStatus: "REVIEW_REQUIRED",
  });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.mayDiscover, false);
});

test("blocked raw retention discards raw but can allow normalized publication", () => {
  const result = evaluateSourcePolicy({
    ...ALLOWED_POLICY,
    rawGpxRetentionPermission: "BLOCKED",
  });
  assert.equal(result.status, "ALLOWED");
  assert.equal(result.mayRetainRawGpx, false);
  assert.equal(result.mayPublishNormalizedGeometry, true);
});

test("missing required attribution is blocked", () => {
  const result = evaluateSourcePolicy({
    ...ALLOWED_POLICY,
    attributionText: null,
  });
  assert.equal(result.status, "BLOCKED");
});

test("only ALLOWED is promotable", () => {
  assert.equal(isPromotable("ALLOWED"), true);
  assert.equal(isPromotable("REVIEW_REQUIRED"), false);
  assert.equal(isPromotable("BLOCKED"), false);
});
