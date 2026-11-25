import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The Next.js-only import marker has no behavior in this standalone test.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { parsePublicExpeditionSearch, searchPublicExpeditions } = await import("../Lib/projects/discovery.ts").finally(() => hook.deregister());

// Cases
const empty = parsePublicExpeditionSearch({});
assert.equal(empty.q, "");
assert.equal(empty.year, null);
assert.equal(empty.minDistanceKm, null);
assert.equal(empty.maxDistanceKm, null);
assert.equal(empty.evidence, false);
assert.equal(empty.status, null);
assert.equal(empty.sort, "recent");
assert.equal(empty.cursorValue, null);
assert.equal(empty.cursorSlug, null);

assert.equal(parsePublicExpeditionSearch({ minDistance: "" }).minDistanceKm, null);
assert.equal(parsePublicExpeditionSearch({ maxDistance: "" }).maxDistanceKm, null);
assert.equal(parsePublicExpeditionSearch({ maxDistance: "   " }).maxDistanceKm, null);
assert.equal(parsePublicExpeditionSearch({ cursor: "" }).cursorValue, null);
assert.equal(parsePublicExpeditionSearch({ cursor: "", after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).cursorValue, null);
assert.equal(parsePublicExpeditionSearch({ minDistance: "0" }).minDistanceKm, 0);
assert.equal(parsePublicExpeditionSearch({ maxDistance: "0" }).maxDistanceKm, 0);
assert.equal(parsePublicExpeditionSearch({ cursor: "5", after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).cursorValue, 5);
assert.equal(parsePublicExpeditionSearch({ cursor: "5", after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).cursorSlug, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert.equal(parsePublicExpeditionSearch({ cursor: "5" }).cursorValue, null);
assert.equal(parsePublicExpeditionSearch({ cursor: "5" }).cursorSlug, null);
assert.equal(parsePublicExpeditionSearch({ after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).cursorValue, null);
assert.equal(parsePublicExpeditionSearch({ after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).cursorSlug, null);
assert.equal(parsePublicExpeditionSearch({ minDistance: "abc" }).minDistanceKm, null);
assert.equal(parsePublicExpeditionSearch({ cursor: "abc", after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).cursorValue, null);
assert.equal(parsePublicExpeditionSearch({ cursor: "5", after: "invalid" }).cursorValue, null);
assert.equal(parsePublicExpeditionSearch({ cursor: "5", after: "invalid" }).cursorSlug, null);

// Explicit zero filters must be preserved distinct from missing
assert.equal(parsePublicExpeditionSearch({ minDistance: "0" }).minDistanceKm, 0);
assert.deepEqual(parsePublicExpeditionSearch({}), { q:"", year:null, minDistanceKm:null, maxDistanceKm:null, evidence:false, status:null, sort:"recent", cursorValue:null, cursorSlug:null });

const published = { public_slug: "A".repeat(32), name: "Fixture", status: "archived", sort_value: 1 };
const search = parsePublicExpeditionSearch({});
const client = (result) => ({ rpc: async (name) => {
  assert.equal(name, "search_public_expeditions");
  return result;
} });
assert.equal((await searchPublicExpeditions(client({ data: [published] }), search)).cards[0].slug, published.public_slug);
assert.deepEqual(await searchPublicExpeditions(client({ data: [] }), search), { cards: [], next: null });
await assert.rejects(searchPublicExpeditions(client({ data: [published], error: new Error("fixture database error") }), search), /fixture database error/);

console.log("Discovery parser and mocked RPC regression checks passed.");
