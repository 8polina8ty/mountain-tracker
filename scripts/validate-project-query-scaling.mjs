import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const queriesSource = await readFile(new URL("../Lib/projects/queries.ts", import.meta.url), "utf8");
const detailPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");

const baseSelect = queriesSource.match(/const PROJECT_DETAIL_BASE_SELECT = `([\s\S]*?)`;/)?.[1] ?? "";
const journalSelect = queriesSource.match(/const PROJECT_JOURNAL_ENTRY_SELECT = `([\s\S]*?)`;/)?.[1] ?? "";
const graphLoader = queriesSource.match(/async function loadProjectDetailGraph\([\s\S]*?\n}\n\nexport async function getAccessibleProjectWorkspace/)?.[0] ?? "";
const workspaceLoader = queriesSource.match(/export async function getAccessibleProjectWorkspace\([\s\S]*?\n}\n\nexport async function getUserProject/)?.[0] ?? "";

assert.ok(baseSelect.includes("expedition_project_mountains") && baseSelect.includes("expedition_project_days"),
  "QUERY A: base project graph must retain mountains and days.");
assert.equal(baseSelect.includes("expedition_project_journal_entries"), false,
  "QUERY A: journal rows must not be embedded in the base project relation graph.");
assert.ok(journalSelect.includes("project_day_id") && journalSelect.includes("expedition_project_journal_media"),
  "QUERY B: the split journal query must retain day association and nested media.");
assert.equal((queriesSource.match(/\.from\("expedition_project_journal_media"\)/g) ?? []).length, 0,
  "QUERY B: split loading must not introduce media N+1 queries.");

assert.ok(graphLoader.includes("const [projectResult, journalResult] = await Promise.all([")
  && graphLoader.includes("baseProjectQuery(supabase, projectId, ownerId).maybeSingle()")
  && graphLoader.includes("journalQuery"),
  "QUERY C: canonical full project and journal graph must load in parallel.");
assert.ok(graphLoader.includes('.eq("project_id", projectId)')
  && graphLoader.includes('.order("entry_date", { ascending: false })')
  && graphLoader.includes('.order("id", { ascending: false })'),
  "QUERY D: full journal graph must stay project-scoped with deterministic ordering.");
assert.ok(graphLoader.includes("expedition_project_journal_entries: journalResult.data ?? []"),
  "QUERY E: split rows must be recomposed before canonical normalization.");
assert.ok(graphLoader.includes("normalizeProjectDetail(rawProject)") && graphLoader.includes("logProjectJournalGraph(rawProject, project)"),
  "QUERY F: split loading must preserve normalization and safe display diagnostics.");

assert.ok(workspaceLoader.includes("PROJECT_JOURNAL_INITIAL_PAGE_SIZE + 1")
  && workspaceLoader.includes("slice(0, PROJECT_JOURNAL_INITIAL_PAGE_SIZE)"),
  "QUERY G: private workspace must use bounded journal look-ahead.");
assert.ok(workspaceLoader.includes("listProjectJournalStats(supabase, projectId)")
  && workspaceLoader.includes("journalCursor:"),
  "QUERY G: bounded workspace must preserve exact lightweight stats and an older-entry cursor.");
assert.ok(workspaceLoader.includes("const [projectResult, journalResult, journalStats] = await Promise.all(["),
  "QUERY H: base graph, initial journal page, and lightweight stats must load in parallel.");
assert.ok(queriesSource.includes("return loadProjectDetailGraph(supabase, projectId, userId);"),
  "QUERY I: owner-only full project loading must retain canonical report-compatible behavior.");
assert.ok(queriesSource.includes("return loadProjectDetailGraph(supabase, projectId, null);"),
  "QUERY I: collaboration-aware full project loading must remain available for report/public projection code.");
assert.ok(detailPage.includes("const workspace = await getAccessibleProjectWorkspace(supabase, projectId);")
  && detailPage.includes("const { project, journalCursor, journalStats } = workspace;"),
  "QUERY J: private project detail route must consume the bounded workspace graph once.");

console.log("Project query scaling and bounded workspace contracts passed.");
