import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const queriesSource = await readFile(new URL("../Lib/projects/queries.ts", import.meta.url), "utf8");
const journalSource = await readFile(new URL("../components/projects/ProjectJournal.tsx", import.meta.url), "utf8");
const projectView = await readFile(new URL("../components/projects/ProjectDetailView.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api/projects/[projectId]/journal/route.ts", import.meta.url), "utf8");
const normalizationSource = await readFile(new URL("../Lib/projects/normalization.ts", import.meta.url), "utf8");

assert.ok(queriesSource.includes("PROJECT_JOURNAL_INITIAL_PAGE_SIZE = 40"), "JOURNAL PAGE A: initial workspace journal page must remain bounded.");
assert.ok(queriesSource.includes("PROJECT_JOURNAL_PAGE_SIZE = 20"), "JOURNAL PAGE A: incremental journal page size changed unexpectedly.");
assert.ok(queriesSource.includes("PROJECT_JOURNAL_INITIAL_PAGE_SIZE + 1") && queriesSource.includes("slice(0, PROJECT_JOURNAL_INITIAL_PAGE_SIZE)"),
  "JOURNAL PAGE B: initial page must use one-row look-ahead.");
assert.ok(queriesSource.includes("boundedLimit + 1") && queriesSource.includes("Math.min(Math.max(Math.trunc(limit), 1), 50)"),
  "JOURNAL PAGE B: incremental page bounds or look-ahead are missing.");
assert.ok(queriesSource.includes('.order("entry_date", { ascending: false })') && queriesSource.includes('.order("id", { ascending: false })'),
  "JOURNAL PAGE C: journal order must remain deterministic.");
assert.ok(queriesSource.includes("entry_date.lt.${cursor.entryDate}") && queriesSource.includes("id.lt.${cursor.id}"),
  "JOURNAL PAGE C: journal pagination must remain keyset-based.");
assert.ok(queriesSource.includes('? query.is("project_day_id", null)') && queriesSource.includes(': query.eq("project_day_id", projectDayId)'),
  "JOURNAL PAGE D: project notes and day journals must paginate in separate scopes.");

const statsSelect = queriesSource.match(/\.select\("project_day_id, expedition_project_journal_media \(media_type\)"\)/)?.[0] ?? "";
assert.ok(statsSelect, "JOURNAL PAGE E: lightweight journal/media stats query missing.");
for (const heavyField of ["body", "title", "storage_path", "original_filename", "width", "height", "duration_seconds"]) {
  assert.equal(statsSelect.includes(heavyField), false, `JOURNAL PAGE E: stats query leaked heavy field ${heavyField}.`);
}
assert.ok(projectView.includes("journalEntryCount: journalStats.total.entryCount")
  && projectView.includes("photoCount: journalStats.total.photoCount")
  && projectView.includes("videoCount: journalStats.total.videoCount"),
  "JOURNAL PAGE F: completion totals must not depend on the bounded initial page.");
assert.ok(projectView.includes("value={journalStats.total.entryCount}")
  && projectView.includes("totalCount={dayJournalStats.entryCount}")
  && projectView.includes("totalCount={journalStats.project.entryCount}"),
  "JOURNAL PAGE F: header and scope counts are not wired.");

assert.ok(apiSource.includes("supabase.auth.getUser()") && apiSource.includes("getProjectAccessRole(supabase, projectId)"),
  "JOURNAL PAGE G: pagination endpoint must authenticate and resolve project access.");
assert.ok(apiSource.includes('role === "none"') && apiSource.includes("status: 404"),
  "JOURNAL PAGE G: outsider pagination must retain non-disclosing not-found behavior.");
assert.ok(apiSource.includes("ISO_TIMESTAMP_PATTERN") && apiSource.includes("isSafeCursorTimestamp(cursorDate)"),
  "JOURNAL PAGE G: cursor timestamp syntax must be constrained before entering the PostgREST filter string.");
assert.ok(apiSource.includes("listProjectJournalPage(supabase, projectId, projectDayId, cursor)"),
  "JOURNAL PAGE H: endpoint must use the canonical scoped keyset query.");
assert.ok(apiSource.includes("createProjectJournalMediaDeliveries") && apiSource.includes('"Cache-Control": "private, no-store"'),
  "JOURNAL PAGE H: loaded media must retain server-side private signed delivery with no caching.");
assert.equal(apiSource.includes("createAdminClient") || apiSource.includes("service_role"), false,
  "JOURNAL PAGE H: private member pagination must not use privileged service-role access.");

assert.ok(journalSource.includes("cursorDate: cursor.entryDate") && journalSource.includes("cursorId: cursor.id"),
  "JOURNAL PAGE I: client load-more request must carry the keyset cursor.");
assert.ok(journalSource.includes('params.set("day", projectDayId)') && journalSource.includes("/journal?${params.toString()}"),
  "JOURNAL PAGE I: day-scoped pagination request is missing.");
assert.ok(journalSource.includes("new Set(current.map((entry) => entry.id))") && journalSource.includes("!ids.has(entry.id)"),
  "JOURNAL PAGE J: appended journal pages must deduplicate entries.");
assert.ok(journalSource.includes("new Set(current.map((media) => media.id))") && journalSource.includes("!ids.has(media.id)"),
  "JOURNAL PAGE J: appended signed media deliveries must deduplicate.");
assert.ok(journalSource.includes("const hasMore = cursor !== null && loadedEntries.length < totalCount"),
  "JOURNAL PAGE K: load-more visibility must be bounded by the scope count.");
assert.equal(journalSource.includes("getPublicUrl"), false, "JOURNAL PAGE L: pagination must not introduce public media URLs.");
assert.ok(normalizationSource.includes("export function normalizeJournalEntry"),
  "JOURNAL PAGE M: paged rows must reuse the canonical journal entry normalizer.");

console.log("Project journal keyset pagination contracts passed.");
