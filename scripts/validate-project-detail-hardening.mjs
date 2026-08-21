import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const projectPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");
const projectView = await readFile(new URL("../components/projects/ProjectDetailView.tsx", import.meta.url), "utf8");
const activitySource = await readFile(new URL("../Lib/projects/activity.ts", import.meta.url), "utf8");
const queriesSource = await readFile(new URL("../Lib/projects/queries.ts", import.meta.url), "utf8");

assert.equal(projectPage.includes('"use client"'), false, "DETAIL A: project detail must remain a Server Component.");
assert.equal(projectView.includes('"use client"'), false, "DETAIL A: extracted project presentation must remain server-rendered.");
assert.ok(projectPage.includes("ProjectDetailView"), "DETAIL A: route must delegate presentation to ProjectDetailView.");
assert.equal(projectPage.includes("<ProjectDayEditor"), false, "DETAIL A: route must not own itinerary presentation after decomposition.");
assert.equal(projectPage.includes("function CompletionReport"), false, "DETAIL A: route must not retain large presentation helpers after decomposition.");

assert.ok(projectPage.includes('const sharePromise = role === "owner"'), "DETAIL B: owner-only share loading must remain conditional.");
assert.ok(projectPage.includes("const trackPickerPromise = editable"), "DETAIL C: read-only viewers must not load private track picker options.");
assert.ok(projectPage.includes("? listOwnedProjectTrackOptions(supabase, user.id)"), "DETAIL C: editable users must retain the owned-track picker.");
assert.ok(projectPage.includes('const teamPromise = role === "owner"'), "DETAIL D: team management data must remain owner-only.");
assert.ok(projectPage.includes("const [shareResult, trackEvidence, trackPickerOptions, activityPage, weatherByMountain, mediaDeliveries, team] = await Promise.all(["), "DETAIL E: independent project-detail reads must stay in one parallel loading group.");
for (const dependency of [
  "listProjectDayTrackEvidence(supabase, user.id, project.id)",
  "listProjectActivity(supabase, project.id)",
  "loadProjectMountainWeather(project.days)",
  "createProjectJournalMediaDeliveries(supabase, journalMedia)",
]) {
  assert.ok(projectPage.includes(dependency), `DETAIL E: missing parallel dependency ${dependency}`);
}

assert.ok(projectView.includes("const dayJournalEntriesById = new Map"), "DETAIL F: initially loaded day journal entries must be prepared once before rendering.");
assert.equal((projectView.match(/projectWithEvidence\.journalEntries\.filter\(\(entry\) => entry\.projectDayId === day\.id\)/g) ?? []).length, 1,
  "DETAIL F: day journal filtering must not be repeated inside multiple render branches.");
assert.ok(projectView.includes("entries={dayJournalEntries}"), "DETAIL G: day journal rendering must reuse the prepared entries.");
assert.ok(projectView.includes("journalCount={dayJournalStats.entryCount}") && projectView.includes("mediaCount={dayJournalStats.mediaCount}"),
  "DETAIL G: day progress must use exact lightweight journal stats rather than the bounded initial page.");
assert.ok(projectView.includes("totalCount={dayJournalStats.entryCount}") && projectView.includes("initialCursor={journalCursor}"),
  "DETAIL G: each day journal must receive exact scope counts and the shared initial pagination boundary.");
assert.ok(projectView.includes("const projectWithEvidence: ExpeditionProject = { ...project, days };"),
  "DETAIL G: presentation must derive evidence-enriched days without mutating the loaded project.");
assert.ok(projectView.includes("journalEntryCount: journalStats.total.entryCount")
  && projectView.includes("photoCount: journalStats.total.photoCount")
  && projectView.includes("videoCount: journalStats.total.videoCount"),
  "DETAIL G: completion summary must retain exact journal/media totals while detail rows are paginated.");

assert.equal((projectPage.match(/\.from\("activity-tracks"\)/g) ?? []).length, 1,
  "DETAIL H: linked GPS evidence must retain one Storage signing bucket access.");
assert.equal((projectPage.match(/\.createSignedUrls\(/g) ?? []).length, 1,
  "DETAIL H: linked GPS evidence must retain one batched signed-URL operation.");
assert.ok(projectPage.includes("60 * 60"), "DETAIL H: signed track URLs must retain the one-hour lifetime.");

assert.ok(activitySource.includes("PROJECT_ACTIVITY_PAGE_SIZE = 12"), "DETAIL I: activity initial page must remain bounded.");
assert.ok(activitySource.includes("boundedLimit + 1"), "DETAIL I: activity pagination must use bounded look-ahead.");
assert.ok(activitySource.includes('.order("created_at", { ascending: false })') && activitySource.includes('.order("id", { ascending: false })'),
  "DETAIL J: activity pagination order must remain deterministic.");
assert.ok(activitySource.includes("created_at.lt.${cursor.createdAt}") && activitySource.includes("id.lt.${cursor.id}"),
  "DETAIL J: activity cursor must remain keyset-based.");
assert.ok(queriesSource.includes('.limit(200)'), "DETAIL K: owned-track picker must remain bounded.");

console.log("Project detail performance, decomposition, pagination, and exact journal-count contracts passed.");
