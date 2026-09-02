import assert from "node:assert/strict";
import test from "node:test";

import { isMissingPreviewQaSchemaError } from "./query-errors.ts";

test("only explicit missing-schema QA errors enable the compatibility fallback", () => {
  assert.equal(isMissingPreviewQaSchemaError({ code: "42P01" }), true);
  assert.equal(isMissingPreviewQaSchemaError({ code: "PGRST205" }), true);
  assert.equal(
    isMissingPreviewQaSchemaError({
      message: "osm_staging_route_visual_qa does not exist",
    }),
    true,
  );
  assert.equal(isMissingPreviewQaSchemaError({ message: "TypeError: fetch failed" }), false);
  assert.equal(isMissingPreviewQaSchemaError({ code: "ECONNRESET" }), false);
});
