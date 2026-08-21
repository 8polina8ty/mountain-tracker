import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mediaSource = await readFile(new URL("../Lib/projects/media.ts", import.meta.url), "utf8");
const journalEditor = await readFile(new URL("../components/projects/ProjectJournalEditor.tsx", import.meta.url), "utf8");
const photoGallery = await readFile(new URL("../components/projects/ProjectPhotoGallery.tsx", import.meta.url), "utf8");

assert.ok(mediaSource.includes("function isMediaOrderConflict"), "Journal media must classify sort-order conflicts narrowly.");
assert.ok(mediaSource.includes("async function nextAvailableSortOrder"), "Journal media must be able to recover a fresh sort order.");
assert.ok(mediaSource.includes("if (metadataError && isMediaOrderConflict(metadataError))"), "Metadata insert must retry after a sort-order conflict.");
assert.ok(mediaSource.includes("media = { ...media, sortOrder: nextOrder.value }"), "Conflict recovery must replace the stale sort order.");
assert.ok(mediaSource.includes("function isStorageMissingError"), "Journal cleanup must recognize already-missing Storage objects.");
assert.ok(mediaSource.includes("storageError && !isStorageMissingError(storageError)"), "Media delete must remain retryable when Storage cleanup was already completed.");
assert.ok(mediaSource.includes("cleanupError && !isStorageMissingError(cleanupError)"), "Upload compensation must tolerate an already-missing object.");

assert.ok(journalEditor.includes("const lockedAfterCreate = Boolean(createdEntryId)"), "Partial create must lock committed journal text.");
assert.ok(journalEditor.includes("{!createdEntryId && <button type=\"button\" disabled={busy} onClick={onCancel}"), "Cancel must disappear after the journal row has been committed.");
assert.ok(journalEditor.includes('setError(failures.some(({ result }) => !result.ok && result.reason === "cleanup-required")'), "Partial upload failures must keep an explicit recovery state.");
assert.ok(journalEditor.includes('draft.status === "error" && <button type="button" disabled={busy} onClick={() => void retryDraft(draft)}'), "Failed media must remain individually retryable.");

assert.ok(photoGallery.includes('if (result.reason === "not-found")'), "Stale media deletion must converge by refreshing an already-removed item.");
assert.ok(photoGallery.includes('if (result.reason === "cleanup-required")'), "Gallery must expose partial cleanup separately.");
assert.ok(photoGallery.includes('result.reason === "auth" || result.reason === "ownership"'), "Gallery must distinguish authorization failures from storage failures.");

console.log("Journal hardening recovery contracts passed.");
