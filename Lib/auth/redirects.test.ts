import assert from "node:assert/strict";
import { test } from "node:test";
import { safeAuthDestination } from "./redirects.ts";

test("auth destinations preserve the active locale and an internal query", () => {
  assert.equal(safeAuthDestination("/account/ascents?page=2", "fr"), "/fr/account/ascents?page=2");
  assert.equal(safeAuthDestination("/ru/mountain/42", "de"), "/de/mountain/42");
  assert.equal(safeAuthDestination("/projects/project-1#journal", "it"), "/it/projects/project-1#journal");
  assert.equal(safeAuthDestination(null, "unsupported"), "/de/map");
});

test("open redirects, ambiguous parsing, auth loops and non-app targets fail closed", () => {
  for (const value of [
    "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)",
    "/%2f%2fevil.example", "/%255cevil.example", "/account\n", "/account\t", "/account\0",
    "/account/../auth/callback", "/account/%2e%2e/auth/callback", "/account//evil",
    "/auth/callback", "/en/auth/login", "/auth/complete-profile", "/api/projects/secret",
    "/unknown", "/", " /account", "/account/" + "x".repeat(2048),
  ]) assert.equal(safeAuthDestination(value, "en"), "/en/map", JSON.stringify(value));
});

test("a nested destination remains query data on a fixed app path", () => {
  assert.equal(safeAuthDestination("/map?next=https%3A%2F%2Fevil.example", "es"),
    "/es/map?next=https%3A%2F%2Fevil.example");
});
