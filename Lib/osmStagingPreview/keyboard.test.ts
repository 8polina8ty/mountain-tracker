import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getQaKeyboardAction } from "./keyboard.ts";

function shortcut(
  key: string,
  overrides: Partial<Parameters<typeof getQaKeyboardAction>[0]> = {},
) {
  return getQaKeyboardAction({
    key,
    editableOrControlContext: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  });
}

test("A N and R select the three human QA statuses", () => {
  assert.deepEqual(shortcut("a"), {
    type: "SELECT_STATUS",
    status: "VISUALLY_APPROVED",
  });
  assert.deepEqual(shortcut("N"), {
    type: "SELECT_STATUS",
    status: "NEEDS_REVIEW",
  });
  assert.deepEqual(shortcut("r"), {
    type: "SELECT_STATUS",
    status: "REJECTED",
  });
});

test("left and right arrows select queue navigation actions", () => {
  assert.deepEqual(shortcut("ArrowLeft"), { type: "PREVIOUS_ROUTE" });
  assert.deepEqual(shortcut("ArrowRight"), { type: "NEXT_ROUTE" });
});

test("shortcuts are ignored in editable or control contexts", () => {
  for (const key of ["a", "n", "r", "ArrowLeft", "ArrowRight"]) {
    assert.equal(shortcut(key, { editableOrControlContext: true }), null);
  }
});

test("modifier and repeated shortcuts are ignored", () => {
  for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"] as const) {
    assert.equal(shortcut("a", { [modifier]: true }), null);
  }
  assert.equal(shortcut("a", { repeat: true }), null);
});

test("keyboard selection never calls the save action", async () => {
  const source = await readFile("components/internal/OsmStagingQaDecisionForm.tsx", "utf8");
  const handler = source.match(/function handleKeyDown[\s\S]*?window\.addEventListener/)?.[0] ?? "";
  assert.match(handler, /setStatus\(action\.status\)/);
  assert.doesNotMatch(handler, /saveOsmStagingQaDecision|save\(/);
  assert.match(
    handler,
    /input,textarea,select,button,a,\[contenteditable\]/,
  );
});
