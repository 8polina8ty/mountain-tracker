import assert from "node:assert/strict";
import test from "node:test";

import {
  ChunkedInQueryError,
  loadChunkedInQuery,
  SUPABASE_IN_QUERY_CHUNK_SIZE,
} from "./chunked-in-query-core.ts";

interface TestRow {
  id: string;
}

test("large IN queries run sequentially in deterministic bounded chunks", async () => {
  const values = Array.from({ length: 298 }, (_, index) => `key-${index}`);
  const observedChunks: string[][] = [];
  let activeQueries = 0;
  let maximumActiveQueries = 0;
  const rows = await loadChunkedInQuery({
    values,
    queryLabel: "Route query",
    loadChunk: async (chunk) => {
      activeQueries += 1;
      maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
      await new Promise<void>((resolve) => setImmediate(resolve));
      observedChunks.push([...chunk]);
      activeQueries -= 1;
      return { data: chunk.map((id) => ({ id })), error: null };
    },
    rowIdentity: (row) => row.id,
  });

  assert.equal(SUPABASE_IN_QUERY_CHUNK_SIZE, 75);
  assert.deepEqual(observedChunks.map((chunk) => chunk.length), [75, 75, 75, 73]);
  assert.equal(maximumActiveQueries, 1);
  assert.deepEqual(rows.map((row) => row.id), values);
});

test("queues larger than Phase 11F stay bounded", async () => {
  const values = Array.from({ length: 704 }, (_, index) => index);
  const chunkSizes: number[] = [];
  const rows = await loadChunkedInQuery({
    values,
    queryLabel: "Summit query",
    loadChunk: async (chunk) => {
      chunkSizes.push(chunk.length);
      return { data: chunk.map((id) => ({ id: String(id) })), error: null };
    },
    rowIdentity: (row) => row.id,
  });

  assert.equal(chunkSizes.length, 10);
  assert.ok(chunkSizes.every((size) => size <= SUPABASE_IN_QUERY_CHUNK_SIZE));
  assert.equal(rows.length, values.length);
});

test("Phase 11F route, summit, and QA query classes each split into four chunks", async () => {
  const values = Array.from({ length: 298 }, (_, index) => `id-${index}`);
  const chunksByQuery = new Map<string, number>();
  for (const queryLabel of ["route", "summit", "QA"]) {
    await loadChunkedInQuery({
      values,
      queryLabel,
      loadChunk: async (chunk) => {
        chunksByQuery.set(queryLabel, (chunksByQuery.get(queryLabel) ?? 0) + 1);
        return {
          data: queryLabel === "QA" ? [] : chunk.map((id) => ({ id })),
          error: null,
        };
      },
      rowIdentity: (row) => row.id,
    });
  }

  assert.deepEqual(Object.fromEntries(chunksByQuery), { route: 4, summit: 4, QA: 4 });
});

test("one failed chunk rejects the whole query with safe context", async () => {
  const values = Array.from({ length: 151 }, (_, index) => `key-${index}`);
  let calls = 0;
  await assert.rejects(
    loadChunkedInQuery({
      values,
      queryLabel: "Staging preview QA query",
      loadChunk: async (chunk) => {
        calls += 1;
        if (calls === 2) {
          return {
            data: null,
            error: {
              code: "NETWORK",
              message: "fetch failed https://project.example/rest/v1/table?secret=value",
            },
          };
        }
        return { data: chunk.map((id) => ({ id })), error: null };
      },
      rowIdentity: (row) => row.id,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChunkedInQueryError);
      assert.equal(error.chunkNumber, 2);
      assert.equal(error.chunkCount, 3);
      assert.equal(error.valueCount, 75);
      assert.match(error.message, /Staging preview QA query failed for chunk 2\/3/);
      assert.doesNotMatch(error.message, /project\.example|secret=value/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("duplicate inputs and duplicate returned identities fail closed", async () => {
  await assert.rejects(
    loadChunkedInQuery({
      values: ["one", "one"],
      queryLabel: "Route query",
      loadChunk: async () => ({ data: [], error: null }),
      rowIdentity: (row: TestRow) => row.id,
    }),
    /duplicate query values/,
  );
  await assert.rejects(
    loadChunkedInQuery({
      values: ["one", "two"],
      queryLabel: "Route query",
      loadChunk: async () => ({ data: [{ id: "same" }, { id: "same" }], error: null }),
      rowIdentity: (row) => row.id,
    }),
    /duplicate row identity same/,
  );
});
