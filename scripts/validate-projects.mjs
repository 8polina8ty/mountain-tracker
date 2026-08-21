import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

import { addUtcCalendarDays, generateProjectDays, renumberProjectDays } from "../Lib/projects/dates.ts";
import { normalizeProjectDetail, normalizeProjectSummary } from "../Lib/projects/normalization.ts";
import { buildProjectPickerOptions, normalizeProjectPickerOption } from "../Lib/projects/picker.ts";
import { isProjectStatus, validateCreateProjectInput, validateJournalEntry, validateProjectDay } from "../Lib/projects/validation.ts";
import { loadProjectMountainWeather, matchProjectDayWeather, summarizeProjectWeather, uniqueWeatherLocations } from "../Lib/projects/weather.ts";
import { buildProjectJournalMediaPath, canonicalExtensionForMime } from "../Lib/projects/mediaPaths.ts";
import { validateProjectJournalMediaMetadata } from "../Lib/projects/mediaValidation.ts";
import { runBoundedPhotoUploads } from "../Lib/projects/photoUploadQueue.ts";
import { createProjectMediaDiagnostic } from "../Lib/projects/mediaDiagnostics.ts";
import { PROJECT_VIDEO_TUS_THRESHOLD_BYTES, selectProjectMediaUploadTransport } from "../Lib/projects/mediaUploadTransport.ts";
import { buildDayJournalPresentation } from "../components/projects/projectJournalPresentation.ts";
import { formatProjectVideoDuration } from "../components/projects/videoThumbnailPresentation.ts";
import { deriveProjectTrackVerification } from "../Lib/projects/tracks.ts";
import { buildGpxActivityPaths } from "../Lib/tracks/importGpxActivity.ts";
import { buildProjectCompletionSummary } from "../Lib/projects/completion.ts";
import { buildProjectExpeditionReport } from "../Lib/projects/report.ts";
import { canChangeLifecycle, canDeleteProject, canEditProject, canManageProjectMembers, canManageSharing, canViewProject } from "../Lib/projects/collaboration.ts";

const sql = (await readFile(new URL("../database/expedition_projects.sql", import.meta.url), "utf8")).toLowerCase();
const mediaSql = (await readFile(new URL("../database/expedition_project_media.sql", import.meta.url), "utf8")).toLowerCase();
const mediaStorageRepairSql = (await readFile(new URL("../database/fix_expedition_media_storage_policies.sql", import.meta.url), "utf8")).toLowerCase();
const dayTracksSql = (await readFile(new URL("../database/expedition_project_day_tracks.sql", import.meta.url), "utf8")).toLowerCase();
const dayTracksPolicyRepairSql = (await readFile(new URL("../database/fix_expedition_project_day_tracks_policies.sql", import.meta.url), "utf8")).toLowerCase();
const projectSharesSql = (await readFile(new URL("../database/expedition_project_shares.sql", import.meta.url), "utf8")).toLowerCase();
const collaborationSql = (await readFile(new URL("../database/expedition_project_members.sql", import.meta.url), "utf8")).toLowerCase();
const collaborationAccessSql = (await readFile(new URL("../database/expedition_project_collaboration_access.sql", import.meta.url), "utf8")).toLowerCase();
const collaborationRecursionRepairSql = (await readFile(new URL("../database/fix_expedition_project_collaboration_rls_recursion.sql", import.meta.url), "utf8")).toLowerCase();
const dayTracksGpsRecursionRepairSql = (await readFile(new URL("../database/fix_expedition_project_day_tracks_gps_rls_recursion.sql", import.meta.url), "utf8")).toLowerCase();
const activitySql = (await readFile(new URL("../database/expedition_project_activity.sql", import.meta.url), "utf8")).toLowerCase();

for (const table of [
  "expedition_projects",
  "expedition_project_mountains",
  "expedition_project_days",
  "expedition_project_day_mountains",
  "expedition_project_journal_entries",
]) {
  assert.ok(sql.includes(`create table if not exists public.${table}`), `Missing table ${table}`);
  assert.ok(sql.includes(`alter table public.${table} enable row level security`), `RLS missing for ${table}`);
}

for (const invariant of [
  "primary key (project_id, mountain_id)",
  "unique (project_id, day_number) deferrable initially immediate",
  "primary key (project_day_id, mountain_id)",
  "foreign key (project_id, project_day_id)",
  "foreign key (project_id, mountain_id)",
  "p.user_id = auth.uid()",
  "user_id = auth.uid()",
  "security definer set search_path = ''",
  "set constraints expedition_project_days_number_unique deferred",
  "create or replace function public.add_expedition_project_day",
  "coalesce(max(day_number), 0) + 1",
  "delete from public.expedition_project_mountains",
  "on delete cascade",
  "revoke all on function",
  "grant execute on function",
]) assert.ok(sql.includes(invariant), `Missing SQL invariant: ${invariant}`);

// Confirmed deployed contract: public.mountains.id is PostgreSQL bigint (int8).
const projectMountainsTable = sql.match(
  /create table if not exists public\.expedition_project_mountains \(([\s\S]*?)\n\);/,
)?.[1] ?? "";
const dayMountainsTable = sql.match(
  /create table if not exists public\.expedition_project_day_mountains \(([\s\S]*?)\n\);/,
)?.[1] ?? "";

assert.ok(projectMountainsTable, "Missing expedition_project_mountains table definition");
assert.ok(dayMountainsTable, "Missing expedition_project_day_mountains table definition");
assert.match(projectMountainsTable, /mountain_id bigint not null references public\.mountains\(id\)/);
assert.match(dayMountainsTable, /mountain_id bigint not null/);
assert.match(
  dayMountainsTable,
  /foreign key \(project_id, mountain_id\)\s+references public\.expedition_project_mountains\(project_id, mountain_id\)/,
);
assert.equal(sql.includes("__mountains_id_type__"), false, "Resolved SQL must not retain a mountain ID type placeholder");
assert.equal(/mountain_id\s+integer\b/.test(sql), false, "Project mountain IDs must not use integer");
assert.match(
  sql,
  /create or replace function public\.remove_expedition_project_mountain\(\s*requested_project_id uuid,\s*requested_mountain_id bigint\s*\)/,
);
assert.ok(sql.includes("public.remove_expedition_project_mountain(uuid, bigint)"));
assert.equal(
  (sql.match(/public\.remove_expedition_project_mountain\(uuid, bigint\)/g) ?? []).length,
  2,
  "Both REVOKE and GRANT must target the bigint RPC signature",
);

// A/J: every child policy derives access from the owner of the parent project;
// journal additionally binds its user_id to auth.uid().
assert.ok((sql.match(/exists \(select 1 from public\.expedition_projects p/g) ?? []).length >= 6);
assert.ok(sql.includes("using (user_id = auth.uid() and exists"));
assert.ok(sql.includes("with check (user_id = auth.uid() and exists"));

// B/D/E: normalization retains multiple project mountains and multiple day
// assignments. The same numeric mountain ID is independent between projects.
const projectRaw = {
  id: "p1", user_id: "u1", name: "Alps Week", description: null, status: "planning",
  start_date: "2027-09-10", end_date: "2027-09-12", created_at: "2026-01-01", updated_at: "2026-01-02",
  expedition_project_mountains: [
    { sort_order: 0, mountains: { id: 1, name: "Alpspitze", name_de: null, height: 2628, latitude: 47.43, longitude: 11.05 } },
    { sort_order: 1, mountains: { id: 2, name: "Zugspitze", name_de: null, height: 2962, latitude: 47.42, longitude: 10.98 } },
  ],
  expedition_project_days: [{
    id: "d1", project_id: "p1", day_number: 1, date: "2027-09-10", title: null, notes: null,
    created_at: "2026-01-01", updated_at: "2026-01-01",
    expedition_project_day_mountains: [
      { mountain_id: 1, sort_order: 0 }, { mountain_id: 2, sort_order: 1 },
    ],
  }],
  expedition_project_journal_entries: [],
};
const detail = normalizeProjectDetail(projectRaw);
assert.equal(detail?.mountains.length, 2);
assert.deepEqual(detail?.days[0].mountains.map((mountain) => mountain.id), [1, 2]);
const otherProject = normalizeProjectDetail({ ...projectRaw, id: "p2", expedition_project_days: [] });
assert.equal(otherProject?.mountains.some((mountain) => mountain.id === 1), true);

// C/M: database uniqueness and picker state both prevent duplicate membership.
assert.ok(sql.includes("primary key (project_id, mountain_id)"));
const summary = normalizeProjectSummary({
  ...projectRaw,
  expedition_project_days: [{ count: 3 }],
  expedition_project_journal_entries: [{ count: 2 }],
});
assert.equal(summary?.dayCount, 3);
assert.equal(summary?.journalEntryCount, 2);
const picker = buildProjectPickerOptions(summary ? [summary] : [], 1);
assert.equal(picker[0]?.alreadyContainsMountain, true);
assert.equal(buildProjectPickerOptions(summary ? [summary] : [], 99)[0]?.alreadyContainsMountain, false);

// F/G: inclusive UTC calendar dates, leap days, validation, and the 60-day cap.
assert.deepEqual(generateProjectDays("2027-09-10", "2027-09-12"), [
  { dayNumber: 1, date: "2027-09-10" },
  { dayNumber: 2, date: "2027-09-11" },
  { dayNumber: 3, date: "2027-09-12" },
]);
assert.equal(addUtcCalendarDays("2028-02-28", 1), "2028-02-29");
assert.deepEqual(validateCreateProjectInput({ name: "Trip", startDate: "2027-09-12", endDate: "2027-09-10" }), ["end-before-start"]);
assert.ok(validateCreateProjectInput({ name: "Trip", startDate: "2027-01-01", endDate: "2027-03-02" }).includes("too-many-days"));

// H/I: membership cascade removes day assignments and domain renumbering is contiguous.
assert.ok(sql.includes("expedition_project_day_mountains_membership_fk"));
assert.ok(sql.includes("references public.expedition_project_mountains(project_id, mountain_id) on delete cascade"));
assert.deepEqual(renumberProjectDays([{ id: "d3" }, { id: "d1" }]).map((day) => day.dayNumber), [1, 2]);

// K/L: forecasts match exact provider dates; no future forecast is fabricated.
const daily = [{
  date: "2026-08-18", condition: "clear", temperatureMaxC: 7, temperatureMinC: 1,
  precipitationProbabilityMaxPct: 10, precipitationSumMm: 0, snowfallSumCm: 0,
  windSpeedMaxKmh: 20, windGustsMaxKmh: 30, sunriseUtc: null, sunsetUtc: null,
}];
const weather = { generatedAt: "2026-08-17", timezone: "Europe/Berlin", elevationM: 2962, current: {}, hourly: [], daily };
assert.equal(matchProjectDayWeather("2026-08-18", weather).state, "available");
assert.equal(matchProjectDayWeather("2027-09-10", weather).state, "outside-horizon");
assert.equal(matchProjectDayWeather(null, weather).state, "unavailable");
assert.equal(uniqueWeatherLocations(detail?.mountains ?? []).size, 2);
assert.equal(uniqueWeatherLocations([...(detail?.mountains ?? []), detail?.mountains[0]]).size, 2);

// AU-BA: project weather is request-local, deduplicated, exact-date matched,
// input-safe, independent per mountain, and summarized once per project day.
const weatherDay = {
  id: "weather-day", projectId: "p1", dayNumber: 1, date: "2026-08-18", title: null, notes: null,
  mountains: detail?.mountains ?? [], createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const weatherCalls = [];
const weatherByMountain = await loadProjectMountainWeather(
  [weatherDay, { ...weatherDay, id: "weather-day-2", dayNumber: 2 }],
  async (location) => { weatherCalls.push(location); return weather; },
);
assert.equal(weatherCalls.length, 2, "AU: weather requests must deduplicate by mountain ID");
assert.equal(weatherByMountain.size, 2);
assert.equal(matchProjectDayWeather("2026-08-18", weather).forecast?.date, "2026-08-18", "AV: forecast matching must use the exact project date");
assert.equal(matchProjectDayWeather("2027-08-18", weather).state, "outside-horizon", "AW: future dates must not receive fabricated forecasts");
assert.equal(matchProjectDayWeather("2026-08-18", null).state, "unavailable", "AX: missing provider data must be unavailable");
let emptyDayCalls = 0;
await loadProjectMountainWeather([{ ...weatherDay, mountains: [] }], async () => { emptyDayCalls += 1; return weather; });
assert.equal(emptyDayCalls, 0, "AY: days without mountains must not request weather");
let invalidLocationCalls = 0;
await loadProjectMountainWeather([{ ...weatherDay, mountains: [{ ...weatherDay.mountains[0], latitude: null }] }], async () => { invalidLocationCalls += 1; return weather; });
assert.equal(invalidLocationCalls, 0, "AY: invalid summit inputs must not request weather");
const independentWeather = new Map([
  [1, weather],
  [2, { ...weather, daily: [{ ...daily[0], temperatureMaxC: 2 }] }],
]);
assert.equal(matchProjectDayWeather(weatherDay.date, independentWeather.get(1)).forecast?.temperatureMaxC, 7);
assert.equal(matchProjectDayWeather(weatherDay.date, independentWeather.get(2)).forecast?.temperatureMaxC, 2, "AZ: mountain forecasts must remain independent");
const summaryWithThreeForecastsOnOneDay = summarizeProjectWeather(
  [{ ...weatherDay, mountains: [
    ...(detail?.mountains ?? []),
    { ...(detail?.mountains[0] ?? {}), id: 3, sortOrder: 2 },
  ] }],
  new Map([[1, weather], [2, weather], [3, weather]]),
);
assert.equal(summaryWithThreeForecastsOnOneDay.availableDayCount, 1, "BA: summary must count project days, not mountain forecasts");

// N foundation: project domain code remains plain-text only.
const domainFiles = ["types", "validation", "dates", "weather", "picker", "normalization", "queries", "mutations", "index"];
for (const file of [...domainFiles, "media", "mediaPaths", "mediaValidation"]) {
  const source = await readFile(new URL(`../Lib/projects/${file}.ts`, import.meta.url), "utf8");
  assert.equal(source.includes("dangerouslySetInnerHTML"), false, `${file}.ts must remain plain-text only`);
}

// O / Phase 2: all six project catalogs must exist with identical nested shape.
function catalogShape(value, prefix = "") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return nested && typeof nested === "object" && !Array.isArray(nested)
      ? catalogShape(nested, path)
      : [path];
  }).sort();
}

const localeNames = ["de", "en", "ru", "fr", "it", "es"];
const catalogs = await Promise.all(localeNames.map(async (locale) =>
  JSON.parse(await readFile(new URL(`../messages/${locale}/projects.json`, import.meta.url), "utf8")),
));
const expectedShape = catalogShape(catalogs[0]);
for (const [index, catalog] of catalogs.entries()) {
  assert.deepEqual(catalogShape(catalog), expectedShape, `${localeNames[index]} project catalog shape differs`);
  for (const path of expectedShape) {
    const value = path.split(".").reduce((current, key) => current[key], catalog);
    assert.equal(typeof value, "string", `${localeNames[index]} ${path} must be text`);
    assert.ok(value.trim().length > 0, `${localeNames[index]} ${path} is empty`);
  }
}

const requestConfig = await readFile(new URL("../i18n/request.ts", import.meta.url), "utf8");
assert.ok(requestConfig.includes('"projects"'), "projects catalog must be registered");

// Phase 2 route contracts: every page authenticates independently; layout is private.
const listPage = await readFile(new URL("../app/[locale]/projects/page.tsx", import.meta.url), "utf8");
const createPage = await readFile(new URL("../app/[locale]/projects/new/page.tsx", import.meta.url), "utf8");
const detailPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");
const routeLayout = await readFile(new URL("../app/[locale]/projects/layout.tsx", import.meta.url), "utf8");
const createForm = await readFile(new URL("../components/projects/ProjectCreateForm.tsx", import.meta.url), "utf8");
const authHelper = await readFile(new URL("../Lib/projects/auth.ts", import.meta.url), "utf8");

for (const [name, source] of [["list", listPage], ["create", createPage]]) assert.ok(source.includes("requireProjectUser("), `${name} route must authenticate independently`);
assert.ok(detailPage.includes("requireProjectAccess("), "detail route must authenticate and resolve collaboration access independently");
assert.ok(authHelper.includes("supabase.auth.getUser()"));
assert.ok(authHelper.includes("/auth/login?returnTo="));
assert.ok(authHelper.includes("encodeURIComponent(returnTo)"));
assert.ok(routeLayout.includes("Projects.Metadata"));
assert.ok(routeLayout.includes("robots: { index: false, follow: false }"));
assert.ok(listPage.includes("listUserProjects(supabase, user.id)"));
assert.ok(detailPage.includes("getAccessibleProject(supabase, projectId)"));
assert.ok(detailPage.includes("if (!project) notFound()"));
assert.ok(createForm.includes("validateCreateProjectInput(input)"));
assert.ok(createForm.includes("createProject(createClient(), input)"));
assert.ok(createForm.includes("router.push(`/projects/${result.data}`)"));
assert.ok(sql.includes("day_count := case when requested_start_date is null then 0"));
assert.ok(sql.includes("if day_count > 0 then"));
assert.ok((await readFile(new URL("../Lib/projects/mutations.ts", import.meta.url), "utf8")).includes('supabase.rpc("create_expedition_project"'));

// Phase 3 mutation contracts P-AF.
const mutationSource = await readFile(new URL("../Lib/projects/mutations.ts", import.meta.url), "utf8");
const statusControl = await readFile(new URL("../components/projects/ProjectStatusControl.tsx", import.meta.url), "utf8");
const mountainActions = await readFile(new URL("../components/projects/ProjectMountainActions.tsx", import.meta.url), "utf8");
const dayEditor = await readFile(new URL("../components/projects/ProjectDayEditor.tsx", import.meta.url), "utf8");
const journal = await readFile(new URL("../components/projects/ProjectJournal.tsx", import.meta.url), "utf8");
const journalEditor = await readFile(new URL("../components/projects/ProjectJournalEditor.tsx", import.meta.url), "utf8");
const photoGallery = await readFile(new URL("../components/projects/ProjectPhotoGallery.tsx", import.meta.url), "utf8");
const videoThumbnail = await readFile(new URL("../components/projects/ProjectVideoThumbnail.tsx", import.meta.url), "utf8");

assert.equal(isProjectStatus("active"), true);
assert.equal(isProjectStatus("paused"), false);
assert.ok(mutationSource.includes("if (!isProjectStatus(status))"));
assert.ok(mutationSource.includes('supabase.rpc("remove_expedition_project_mountain"'));
assert.ok(sql.includes("expedition_project_day_mountains_membership_fk"));
assert.ok(sql.includes("references public.expedition_project_mountains(project_id, mountain_id) on delete cascade"));
assert.ok(mutationSource.includes('supabase.rpc("add_expedition_project_day"'));
assert.ok(mutationSource.includes('supabase.rpc("delete_expedition_project_day"'));
assert.ok(mutationSource.includes('supabase.rpc("reorder_expedition_project_days_if_current"'));
assert.ok(sql.includes("day order must contain every project day exactly once"));
assert.ok(dayEditor.includes("disabled={index <= 0"));
assert.ok(dayEditor.includes("index >= days.length - 1"));
assert.deepEqual(validateProjectDay({ title: "x".repeat(161) }), ["day-title-too-long"]);
assert.deepEqual(validateProjectDay({ notes: "x".repeat(8001) }), ["day-notes-too-long"]);
assert.ok(sql.includes("expedition_project_day_mountains_membership_fk"));
assert.ok(sql.includes("primary key (project_day_id, mountain_id)"));
assert.deepEqual(validateJournalEntry({ body: "   " }), ["journal-body-required"]);
assert.ok(sql.includes("user_id = auth.uid() and exists"));
assert.equal((journal + mutationSource).includes("dangerouslySetInnerHTML"), false);
assert.ok(statusControl.includes("statusError") && mountainActions.includes("removeMountainError") && dayEditor.includes("daySaveError") && journalEditor.includes("journalCreateError"));
assert.ok(expectedShape.includes("Projects.Mutations.statusError"));
assert.equal((detailPage + statusControl + mountainActions + dayEditor + journal).includes("ProjectPicker"), false);
assert.equal((detailPage + statusControl + mountainActions + dayEditor + journal).includes("addMountainToProject"), false);
assert.ok(dayEditor.includes("day.mountains.map((mountain)"), "Assigned section must render day.mountains");
assert.ok(dayEditor.includes("projectMountains.filter((mountain) => !assignedIds.has(mountain.id))"), "Available section must exclude assigned mountains");
assert.ok(dayEditor.includes('t("noMountainsAssignedToDay")'), "Assigned section must have a localized empty state");
assert.ok(dayEditor.includes("assignMountainToDay(createClient(), projectId, day.id, mountain.id"));
assert.ok(dayEditor.includes("unassignMountainFromDay(createClient(), projectId, day.id, mountain.id)"));
assert.ok(dayEditor.includes('t("addMountainToDay")') && dayEditor.includes('t("removeMountainFromDay")'));
assert.ok(expectedShape.includes("Projects.Mutations.assignedToDay"));
assert.ok(expectedShape.includes("Projects.Mutations.addFromProject"));

// Phase 4 mountain selection integration contracts AG-AT.
const pickerComponent = await readFile(new URL("../components/projects/ProjectPicker.tsx", import.meta.url), "utf8");
const pickerQuerySource = await readFile(new URL("../Lib/projects/queries.ts", import.meta.url), "utf8");
const peakDetailsPanel = await readFile(new URL("../components/MountainMap/PeakDetailsPanel.tsx", import.meta.url), "utf8");
const mountainDetailPage = await readFile(new URL("../app/[locale]/mountain/[id]/page.tsx", import.meta.url), "utf8");
const mapSources = await readFile(new URL("../components/MountainMap/mapSources.ts", import.meta.url), "utf8");
const mapLayers = await readFile(new URL("../components/MountainMap/mapLayers.ts", import.meta.url), "utf8");

assert.ok(pickerQuerySource.includes("listProjectPickerOptions("));
assert.ok(pickerQuerySource.includes('.eq("user_id", userId)'));
assert.ok(pickerQuerySource.includes("expedition_project_mountains (mountain_id)"));
assert.equal((pickerQuerySource.match(/\.from\("expedition_projects"\)/g) ?? []).length >= 2, true);
const duplicatePickerOption = normalizeProjectPickerOption({
  id: "p1", name: "Alps", status: "planning", start_date: null, end_date: null,
  expedition_project_mountains: [{ mountain_id: 1 }],
});
assert.equal(duplicatePickerOption?.alreadyContainsMountain, true);
assert.ok(pickerComponent.includes("project.alreadyContainsMountain"));
assert.ok(pickerComponent.includes("disabled={Boolean(addingId)}"));
assert.ok(pickerComponent.includes("addMountainToProject(createClient(), project.id, mountainId)"));
assert.equal(pickerComponent.includes("user_id"), false);
assert.ok(mutationSource.includes("supabase.auth.getUser()"));
assert.ok(mutationSource.includes('supabase.from("expedition_project_mountains").insert({'));
assert.ok(pickerComponent.indexOf("supabase.auth.getUser()") < pickerComponent.indexOf("listProjectPickerOptions("));
assert.ok(pickerComponent.includes('authState === "unauthenticated"'));
assert.ok(peakDetailsPanel.includes('import ProjectPicker from "@/components/projects/ProjectPicker"'));
assert.ok(peakDetailsPanel.includes('<ProjectPicker mountainId={peak.id} mountainName={peakName} context="map" />'));
assert.ok(mountainDetailPage.includes('import ProjectPicker from "@/components/projects/ProjectPicker"'));
assert.ok(mountainDetailPage.includes("mountainId={typedMountain.id}"));
assert.ok(pickerComponent.includes('import { Link } from "@/i18n/navigation"'));
assert.ok(pickerComponent.includes('href="/projects/new"'));
for (const mapId of ['"peaks"', '"clusters"', '"cluster-count"', '"individual-peaks"']) {
  assert.ok((mapSources + mapLayers).includes(mapId), `MapLibre contract ID missing: ${mapId}`);
}
assert.ok(pickerQuerySource.includes("getUserProject("));
assert.ok(pickerQuerySource.includes("expedition_project_mountains (${PROJECT_MOUNTAIN_SELECT})"));
for (const forbidden of ["project_media", "project_gpx", "project_members", "ascent_verification", "offline"] ) {
  assert.equal((pickerComponent + peakDetailsPanel + mountainDetailPage).includes(forbidden), false, `Phase 5 feature leaked into Phase 4: ${forbidden}`);
}

// BB-BH: project presentation reuses Summit Weather without safety ratings,
// persistence, client-wide conversion, mutation regression, or later-phase scope.
const projectWeatherSource = await readFile(new URL("../Lib/projects/weather.ts", import.meta.url), "utf8");
const projectDayWeather = await readFile(new URL("../components/projects/ProjectDayWeather.tsx", import.meta.url), "utf8");
const projectWeatherSummary = await readFile(new URL("../components/projects/ProjectWeatherSummary.tsx", import.meta.url), "utf8");
const projectPresentation = detailPage + projectDayWeather + projectWeatherSummary;
assert.equal(/\b(safe|unsafe)\b/i.test(projectDayWeather + projectWeatherSummary), false, "BB: project weather must not rate safety");
assert.ok(projectWeatherSource.includes('from "../weather/summitWeather.ts"'));
assert.ok(projectWeatherSource.includes("getSummitWeather"), "BC: existing Summit Weather provider must be reused");
assert.ok(projectWeatherSource.includes("days.flatMap((day) => day.mountains)"), "Weather loading must remain assignment-based");
assert.ok(projectDayWeather.includes("if (day.mountains.length === 0) return null"), "Day weather empty behavior must remain assignment-based");
assert.ok(projectWeatherSummary.includes("summary.assignedDayCount === 0"), "Weather summary empty behavior must remain unchanged");
assert.equal(sql.includes("project_weather"), false, "BD: project weather must not be persisted");
assert.ok(expectedShape.includes("Projects.Weather.weatherForecast"), "BE: project weather translations must be present");
assert.equal(detailPage.includes('"use client"'), false, "BF: project detail must remain a Server Component");
assert.ok(detailPage.includes("loadProjectMountainWeather(project.days)"));
for (const mutationComponent of ["ProjectStatusControl", "ProjectMountainActions", "ProjectDayEditor", "ProjectJournal"]) {
  assert.ok(detailPage.includes(mutationComponent), `BG: ${mutationComponent} must remain wired`);
}
for (const forbidden of ["project_media", "project_gpx", "photo upload", "video upload", "ai planning"]) {
  assert.equal(projectPresentation.toLowerCase().includes(forbidden), false, `BH: later-phase feature leaked into Phase 5: ${forbidden}`);
}

for (const forbidden of ["project_gpx", "project_members", "ascent_verification", "offline"]) {
  assert.equal(sql.includes(forbidden), false, `Out-of-scope table detected: ${forbidden}`);
}

// Phase 6A BI-CF: incremental journal/day, media metadata, private bucket, and
// operation-specific ownership contracts. Application upload/rendering remains
// deliberately out of scope.
assert.ok(mediaSql.includes("alter table public.expedition_project_journal_entries"));
assert.match(mediaSql, /add column project_day_id uuid\s*;/, "BI: project_day_id must remain nullable");
assert.ok(mediaSql.includes("unique (project_id, user_id, id)"), "BJ: journal composite identity missing");
assert.match(
  mediaSql,
  /foreign key \(project_id, project_day_id\)[\s\S]*references public\.expedition_project_days\(project_id, id\)[\s\S]*on delete set null \(project_day_id\)/,
  "BK: journal day FK must preserve the project and null only project_day_id",
);
assert.ok(mediaSql.includes("create table public.expedition_project_journal_media"), "BL: media table missing");
assert.ok(mediaSql.includes("foreign key (project_id, user_id, journal_entry_id)"));
assert.ok(mediaSql.includes("references public.expedition_project_journal_entries(project_id, user_id, id)"));
assert.ok(mediaSql.includes("on delete cascade"), "BM: journal deletion must cascade media metadata");
assert.ok(mediaSql.includes("media_type in ('photo', 'video')"));
for (const mime of ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]) {
  assert.ok(mediaSql.includes(`'${mime}'`), `BN: missing media MIME ${mime}`);
}
for (const limit of ["10485760", "104857600", "width <= 8192", "height <= 8192", "40000000", "width <= 3840", "height <= 2160", "duration_seconds <= 300"]) {
  assert.ok(mediaSql.includes(limit), `BO: missing media limit ${limit}`);
}
assert.ok(mediaSql.includes("size_bytes > 0"));
assert.ok(mediaSql.includes("width > 0 and height > 0"));
assert.ok(mediaSql.includes("duration_seconds is null"));
assert.ok(mediaSql.includes("duration_seconds > 0"));
assert.ok(mediaSql.includes("unique (storage_path)"), "BP: storage paths must be globally unique");
assert.ok(mediaSql.includes("check (sort_order >= 0)"));
assert.ok(mediaSql.includes("unique (journal_entry_id, sort_order) deferrable initially immediate"));
assert.ok(mediaSql.includes("for update"), "BQ: media cap must serialize on the journal parent");
assert.ok(mediaSql.includes("existing_count >= 12"), "BQ: hard 12-media cap missing");
assert.equal(/language\s+plpgsql\s+(?:volatile\s+)?security\s+definer/.test(mediaSql), false, "BR: Phase 6A must not add SECURITY DEFINER");
assert.match(mediaSql, /returns trigger\s+language plpgsql\s+set search_path = ''/, "BR: media cap trigger must remain security invoker");

assert.ok(mediaSql.includes("'expedition-media'"));
assert.match(mediaSql, /'expedition-media',\s*'expedition-media',\s*false,\s*104857600/, "BS: bucket must be private with a 100 MiB ceiling");
assert.ok(mediaSql.includes("allowed_mime_types"));
assert.ok(mediaSql.includes("cardinality(storage.foldername(storage.objects.name)) = 4"));
assert.ok(mediaSql.includes("storage.filename(storage.objects.name) in ('original.jpg', 'original.png', 'original.webp', 'original.mp4', 'original.webm')"));
assert.ok(mediaSql.includes("storage_path = user_id::text || '/' || project_id::text"), "BT: metadata path must bind ownership identifiers");

for (const operation of ["select", "insert", "update", "delete"]) {
  assert.ok(mediaSql.includes(`expedition_project_journal_media_${operation}`), `BU: metadata ${operation} policy missing`);
}
for (const operation of ["insert", "select", "delete"]) {
  assert.ok(mediaSql.includes(`expedition_media_objects_${operation}_owned`), `BV: Storage ${operation} policy missing`);
}
assert.equal(/create policy expedition_media_objects[^\n]*update/.test(mediaSql), false, "BW: Storage UPDATE policy is forbidden");
assert.equal(/on storage\.objects\s+for update/.test(mediaSql), false, "BW: Storage UPDATE policy is forbidden");
assert.ok(mediaSql.includes("for insert to authenticated"));
assert.ok(mediaSql.includes("for select to authenticated"));
assert.ok(mediaSql.includes("for delete to authenticated"));
assert.ok(mediaSql.includes("revoke all on public.expedition_project_journal_media from public, anon, authenticated"));
assert.ok(mediaSql.includes("grant update (sort_order)"), "BX: only sort_order receives UPDATE privilege");
assert.equal(mediaSql.includes("grant update on public.expedition_project_journal_media"), false, "BX: broad metadata UPDATE grant forbidden");
assert.equal(mediaSql.includes("getpublicurl"), false, "BY: private media must not use public URLs");
assert.equal(mediaSql.includes("service_role"), false, "BZ: service-role access is outside browser-facing contract");
assert.ok(mediaSql.includes("begin;") && mediaSql.includes("commit;"), "CA: incremental artifact must be transactional");
assert.equal(mediaSql.includes("create table if not exists public.expedition_project_journal_media"), false, "CB: incompatible media schemas must not be silently accepted");

// Phase 6 Storage repair: target-relation qualification prevents the joined
// expedition_projects.name column from capturing the object path reference.
function storagePolicy(sqlSource, policyName) {
  const match = sqlSource.match(new RegExp(
    `create policy ${policyName}\\s+on storage\\.objects([\\s\\S]*?)\\n\\);`,
  ));
  assert.ok(match, `Missing Storage policy definition: ${policyName}`);
  return match[1].replace(/\s+/g, " ").trim();
}

const storagePolicyNames = [
  "expedition_media_objects_insert_owned",
  "expedition_media_objects_select_owned",
  "expedition_media_objects_delete_owned",
];
for (const policyName of storagePolicyNames) {
  const sourcePolicy = storagePolicy(mediaSql, policyName);
  const repairPolicy = storagePolicy(mediaStorageRepairSql, policyName);
  assert.equal(repairPolicy, sourcePolicy, `${policyName} differs between Phase 6A and repair SQL`);
  assert.ok(sourcePolicy.includes("to authenticated"), `${policyName} must remain authenticated-only`);
  assert.ok(sourcePolicy.includes("bucket_id = 'expedition-media'"), `${policyName} must remain bucket-bound`);
  assert.ok(sourcePolicy.includes("cardinality(storage.foldername(storage.objects.name)) = 4"), `${policyName} must require four folders plus a filename`);
  assert.ok(sourcePolicy.includes("(storage.foldername(storage.objects.name))[1] = (select auth.uid())::text"), `${policyName} must bind folder 1 to auth.uid()`);
  assert.ok(sourcePolicy.includes("project.id::text = (storage.foldername(storage.objects.name))[2]"), `${policyName} must bind folder 2 to the owned project`);
  assert.ok(sourcePolicy.includes("entry.id::text = (storage.foldername(storage.objects.name))[3]"), `${policyName} must bind folder 3 to the owned journal entry`);
}
const insertStoragePolicy = storagePolicy(mediaSql, "expedition_media_objects_insert_owned");
assert.ok(insertStoragePolicy.includes("(storage.foldername(storage.objects.name))[4] ~"), "Storage INSERT must validate the media UUID in folder 4");
assert.ok(insertStoragePolicy.includes("storage.filename(storage.objects.name) in ('original.jpg', 'original.png', 'original.webp', 'original.mp4', 'original.webm')"), "Storage INSERT must allow only canonical filenames");
for (const sqlSource of [mediaSql, mediaStorageRepairSql]) {
  assert.equal(sqlSource.includes("storage.foldername(project.name)"), false, "project.name must never be parsed as a Storage path");
  assert.equal(/storage\.foldername\(name\)/.test(sqlSource), false, "Storage path references must not use ambiguous bare name");
  assert.equal(/create policy expedition_media_objects[^\n]*update/.test(sqlSource), false, "Storage UPDATE policy is forbidden");
  assert.equal(/on storage\.objects\s+for update/.test(sqlSource), false, "Storage UPDATE policy is forbidden");
}
assert.match(mediaStorageRepairSql, /^--[\s\S]*?begin;/, "Storage repair must be transactional");
assert.ok(mediaStorageRepairSql.trimEnd().endsWith("commit;"), "Storage repair must commit atomically");
for (const policyName of storagePolicyNames) {
  assert.ok(mediaStorageRepairSql.includes(`drop policy ${policyName} on storage.objects;`), `Repair must drop exact policy ${policyName}`);
  assert.equal(mediaStorageRepairSql.includes(`drop policy if exists ${policyName}`), false, `Repair must fail if ${policyName} is absent`);
}

for (const forbidden of ["expedition_project_journal_media", "expedition-media", "photo upload", "video upload", "getpublicurl"]) {
  assert.equal(projectPresentation.toLowerCase().includes(forbidden), false, `CC: Phase 6A leaked into project UI: ${forbidden}`);
}

// Phase 6B BI-CN: reusable media domain, validation, compensation, deletion,
// and server-only delivery infrastructure without Phase 6C presentation UI.
const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  entry: "33333333-3333-4333-8333-333333333333",
  day: "44444444-4444-4444-8444-444444444444",
  media: "55555555-5555-4555-8555-555555555555",
};
const jpegPath = `${ids.user}/${ids.project}/${ids.entry}/${ids.media}/original.jpg`;
const validMediaRow = {
  id: ids.media, journal_entry_id: ids.entry, project_id: ids.project, user_id: ids.user,
  media_type: "photo", storage_path: jpegPath, original_filename: "summit.JPG", mime_type: "image/jpeg",
  size_bytes: 1024, width: 1200, height: 800, duration_seconds: null, sort_order: 0,
  created_at: "2026-08-18T10:00:00.000Z",
};
const mediaProject = normalizeProjectDetail({
  ...projectRaw,
  id: ids.project,
  user_id: ids.user,
  expedition_project_days: [],
  expedition_project_journal_entries: [{
    id: ids.entry, project_id: ids.project, user_id: ids.user, project_day_id: ids.day,
    entry_date: "2026-08-18T09:00:00.000Z", title: "Summit", body: "Reached camp.",
    created_at: "2026-08-18T09:00:00.000Z", updated_at: "2026-08-18T09:00:00.000Z",
    expedition_project_journal_media: [validMediaRow, { ...validMediaRow, id: "malformed" }],
  }],
});
assert.equal(mediaProject?.journalEntries[0].media.length, 1, "BI/BJ: malformed media must not discard its journal entry");
assert.equal(mediaProject?.journalEntries[0].media[0].storagePath, jpegPath);
assert.equal(mediaProject?.journalEntries[0].projectDayId, ids.day, "BK: projectDayId must normalize");
const normalizeJournalCase = (overrides = {}) => normalizeProjectDetail({
  ...projectRaw,
  id: ids.project,
  user_id: ids.user,
  expedition_project_days: [],
  expedition_project_journal_entries: [{
    id: ids.entry, project_id: ids.project, user_id: ids.user, project_day_id: null,
    entry_date: "2026-08-18T09:00:00.000Z", title: null, body: "Journal text",
    created_at: "2026-08-18T09:00:00.000Z", updated_at: "2026-08-18T09:00:00.000Z",
    expedition_project_journal_media: [],
    ...overrides,
  }],
});
const emptyBodyPhotoJournal = normalizeJournalCase({ body: "", expedition_project_journal_media: [validMediaRow] });
assert.equal(emptyBodyPhotoJournal?.journalEntries.length, 1, "Phase 6C: empty body with valid photo must be retained");
assert.equal(emptyBodyPhotoJournal?.journalEntries[0].media.length, 1, "Phase 6C: valid photo must survive normalization");
assert.equal(normalizeJournalCase({ body: "   ", expedition_project_journal_media: [validMediaRow] })?.journalEntries.length, 1,
  "Phase 6C: whitespace-only body with valid photo must be retained");
assert.equal(normalizeJournalCase({ body: "" })?.journalEntries.length, 0, "Phase 6C: empty body without media must be rejected");
assert.equal(normalizeJournalCase({ body: "   " })?.journalEntries.length, 0, "Phase 6C: whitespace-only body without media must be rejected");
assert.equal(normalizeJournalCase({ body: "", expedition_project_journal_media: [{ ...validMediaRow, id: "malformed" }] })?.journalEntries.length, 0,
  "Phase 6C: empty body with only malformed media must be rejected");
assert.equal(normalizeJournalCase()?.journalEntries.length, 1, "Phase 6C: non-empty body without media must be retained");
for (const invalidBody of [null, 42]) {
  assert.equal(normalizeJournalCase({ body: invalidBody })?.journalEntries.length, 0, "Phase 6C: non-string body must be rejected");
}
assert.equal(normalizeJournalCase({ title: null })?.journalEntries[0].title, null, "Phase 6C: null title must remain accepted");
assert.equal(normalizeJournalCase({ project_day_id: null })?.journalEntries[0].projectDayId, null,
  "Phase 6C: null projectDayId must remain accepted");
assert.equal(normalizeJournalCase({ project_day_id: ids.day })?.journalEntries[0].projectDayId, ids.day,
  "Phase 6C: valid projectDayId must remain accepted");
assert.equal(normalizeJournalCase({ project_day_id: 42 })?.journalEntries.length, 0,
  "Phase 6C: invalid non-null projectDayId type must remain rejected");
const mediaForSignedDelivery = emptyBodyPhotoJournal?.journalEntries.flatMap((entry) => entry.media)
  .filter((media) => media.mediaType === "photo") ?? [];
assert.equal(mediaForSignedDelivery.length, 1, "Phase 6C: normalized photo must flow into signed-delivery collection");
const projectLevelJournal = normalizeProjectDetail({
  ...projectRaw, id: ids.project, user_id: ids.user, expedition_project_days: [],
  expedition_project_journal_entries: [{
    id: ids.entry, project_id: ids.project, user_id: ids.user, project_day_id: null,
    entry_date: "2026-08-18T09:00:00.000Z", title: null, body: "Project note",
    created_at: "2026-08-18T09:00:00.000Z", updated_at: "2026-08-18T09:00:00.000Z",
    expedition_project_journal_media: [],
  }],
});
assert.equal(projectLevelJournal?.journalEntries[0].projectDayId, null, "BK: projectDayId must remain nullable");
assert.ok(pickerQuerySource.includes("expedition_project_journal_media ("), "BL: detail query must nest journal media");
assert.ok(pickerQuerySource.includes("project_day_id"), "BK: detail query must select projectDayId");
assert.equal((pickerQuerySource.match(/\.from\("expedition_project_journal_media"\)/g) ?? []).length, 0, "BL: detail query must not add a media N+1 query");
assert.deepEqual(validateJournalEntry({ body: "", mediaCount: 1 }), [], "Phase 6C may later permit media-only journal entries");

const expectedExtensions = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["video/mp4", "mp4"], ["video/webm", "webm"],
]);
for (const [mimeType, extension] of expectedExtensions) {
  assert.equal(canonicalExtensionForMime(mimeType), extension);
  assert.equal(buildProjectJournalMediaPath({ userId: ids.user, projectId: ids.project, journalEntryId: ids.entry, mediaId: ids.media, mimeType }),
    `${ids.user}/${ids.project}/${ids.entry}/${ids.media}/original.${extension}`, `BM-BQ: canonical path failed for ${mimeType}`);
}
assert.equal(jpegPath.includes("summit.JPG"), false, "BR: original filename must not enter Storage path");
assert.equal(canonicalExtensionForMime("image/gif"), null, "BS: invalid MIME must be rejected");
const metadata = { mimeType: "image/jpeg", sizeBytes: 100, width: 100, height: 100, durationSeconds: null, sortOrder: 0 };
assert.equal(validateProjectJournalMediaMetadata({ ...metadata, sizeBytes: 10 * 1024 * 1024 + 1 }).ok, false, "BT: oversized photo accepted");
assert.equal(validateProjectJournalMediaMetadata({ ...metadata, mimeType: "video/mp4", sizeBytes: 100 * 1024 * 1024 + 1, width: 100, height: 100, durationSeconds: 1 }).ok, false, "BU: oversized video accepted");
assert.equal(validateProjectJournalMediaMetadata({ ...metadata, width: 8193 }).ok, false, "BV: photo width limit missing");
assert.equal(validateProjectJournalMediaMetadata({ ...metadata, width: 8000, height: 6000 }).ok, false, "BV: photo pixel limit missing");
assert.equal(validateProjectJournalMediaMetadata({ ...metadata, mimeType: "video/webm", width: 3841, height: 2160, durationSeconds: 1 }).ok, false, "BW: video dimensions missing");
assert.equal(validateProjectJournalMediaMetadata({ ...metadata, mimeType: "video/webm", width: 1920, height: 1080, durationSeconds: 301 }).ok, false, "BW: video duration missing");

const mediaSource = await readFile(new URL("../Lib/projects/media.ts", import.meta.url), "utf8");
const mediaTypesSource = await readFile(new URL("../Lib/projects/types.ts", import.meta.url), "utf8");
const mediaDeliverySource = await readFile(new URL("../Lib/projects/mediaDelivery.ts", import.meta.url), "utf8");
const mediaUploadTransportSource = await readFile(new URL("../Lib/projects/mediaUploadTransport.ts", import.meta.url), "utf8");
const displayDiagnosticSources = pickerQuerySource + mediaDeliverySource + journal;
assert.ok(mediaSource.indexOf("supabase.auth.getUser()") < mediaSource.indexOf("uploadProjectMediaObject(supabase"), "BX: upload must authenticate before Storage access");
const uploadInputBlock = mediaTypesSource.match(/export type ProjectJournalMediaUploadInput = \{([\s\S]*?)\n\};/)?.[1] ?? "";
assert.equal(uploadInputBlock.includes("userId"), false, "BY: upload caller must not supply userId");
assert.ok(mutationSource.includes("isOwnedProjectDay(supabase, projectId, values.projectDayId)"), "BK: journal mutations must reject cross-project days");
assert.ok(mediaSource.indexOf("uploadProjectMediaObject(supabase") < mediaSource.indexOf('.from("expedition_project_journal_media").insert'), "BZ: metadata insert must follow upload");
assert.ok(mediaSource.includes("if (!metadataError) return { ok: true, data: media }"));
assert.ok(mediaSource.includes("media-metadata-and-cleanup-failed"), "CA/CB: metadata cleanup outcomes must be explicit");
assert.ok(mediaSource.includes("isMediaLimitError(metadataError)"), "CC: DB media cap must normalize to limit");
const individualDeleteStart = mediaSource.indexOf("export async function deleteProjectJournalMedia(");
const journalDeleteStart = mediaSource.indexOf("export async function deleteProjectJournalEntryWithMedia(");
const individualDeleteSource = mediaSource.slice(individualDeleteStart, journalDeleteStart);
assert.ok(individualDeleteSource.indexOf(".remove([media.storage_path])") < individualDeleteSource.indexOf('.from("expedition_project_journal_media").delete()'), "CD: Storage delete must precede metadata delete");
assert.ok(individualDeleteSource.includes("if (storageError) return failure"), "CE: failed Storage delete must preserve metadata");
const journalDeleteSource = mediaSource.slice(journalDeleteStart);
assert.ok(journalDeleteSource.indexOf(".remove(paths)") < journalDeleteSource.indexOf('.from("expedition_project_journal_entries").delete()'), "CF: media objects must precede journal deletion");
assert.ok(journalDeleteSource.includes("journal-media-removed-entry-delete-failed"), "CG: partial journal cleanup must be explicit");
assert.ok(mediaDeliverySource.includes('import "server-only"'));
assert.equal((mediaDeliverySource.match(/createSignedUrls\(/g) ?? []).length, 1, "CH: signed URLs must use one batch call");
assert.ok(mediaDeliverySource.includes("new Set("), "CH: signed URL paths must be deduplicated");
assert.equal(mediaTypesSource.match(/export type ProjectJournalMedia = \{([\s\S]*?)\n\};/)?.[1].includes("signedUrl"), false, "CI: persisted media must not contain signed URLs");
assert.ok(mediaDeliverySource.includes('deliveryState: signedUrl ? "ready" : "unavailable"'), "CJ: one missing URL must not fail the project");
assert.equal((mediaSource + mediaDeliverySource).includes("getPublicUrl"), false, "CK: public media URLs are forbidden");
assert.equal((mediaSource + mediaDeliverySource).includes("service_role"), false, "CL: browser service-role usage is forbidden");
for (const forbidden of ["lightbox", "media gallery", "video player"]) {
  assert.equal(projectPresentation.toLowerCase().includes(forbidden), false, `CM: Phase 6C UI leaked into Phase 6B: ${forbidden}`);
}
assert.equal(catalogs.length, 6, "CN: all six unchanged locale catalogs must remain validated");

// Phase 6C CO-DH: photo-only journal creation, bounded upload presentation,
// private delivery, accessible lightbox, and six-locale UI contracts.
assert.deepEqual(validateJournalEntry({ body: "", mediaCount: 1 }), [], "CO: one photo must allow a media-only entry");
assert.deepEqual(validateJournalEntry({ body: "", mediaCount: 0 }), ["journal-body-required"], "CP: empty entry must remain invalid");
assert.ok(journalEditor.includes("PROJECT_JOURNAL_MEDIA_MAX_ITEMS"));
assert.ok(journalEditor.includes("entry?.media.length"), "CQ: existing media must count toward the 12-item limit");
assert.ok(journalEditor.includes('status: "invalid"') && journalEditor.includes("draft.inspected &&"), "CR: invalid files must not enter the upload queue");
assert.ok(journalEditor.includes("URL.revokeObjectURL(draft.previewUrl)"));
assert.ok(journalEditor.includes("for (const url of previewUrlsRef.current) URL.revokeObjectURL(url)"), "CS: previews must be revoked on unmount");
let activeUploads = 0;
let maximumActiveUploads = 0;
const orderedUploads = await runBoundedPhotoUploads([0, 1, 2, 3, 4, 5], async (value) => {
  activeUploads += 1;
  maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
  await Promise.resolve();
  activeUploads -= 1;
  return value;
});
assert.ok(maximumActiveUploads <= 3, "CT: upload concurrency exceeded three");
assert.deepEqual(orderedUploads, [0, 1, 2, 3, 4, 5], "CU: bounded queue must preserve selection order");
assert.ok(journalEditor.includes("successfulIds") && journalEditor.includes('status: result.ok ? "success" : "error"'), "CV: upload outcomes must remain per-photo");
assert.ok(journalEditor.includes("uploadDrafts(targetEntryId, [draft])"), "CW: retry must target one failed draft");
assert.equal(journalEditor.includes("deleteJournalEntry"), false, "CX: media failure must not delete journal text");
assert.equal((detailPage.match(/createProjectJournalMediaDeliveries\(/g) ?? []).length, 1, "CY: project page must batch-sign photos once");
assert.ok(photoGallery.includes("unavailableIds") && photoGallery.includes('"photoUnavailable"'), "CZ: missing or expired signed photo must degrade per item");
assert.ok(detailPage.includes("project.journalEntries.flatMap((entry) => entry.media)"));
assert.ok(photoGallery.includes("deleteProjectJournalMedia(createClient(), projectId, photo.id)"), "DC: photo delete must use Phase 6B helper");
assert.ok(photoGallery.indexOf("if (!result.ok)") < photoGallery.indexOf("router.refresh()"), "DD: failed delete must keep the photo visible");
for (const contract of ["<dialog", 'event.key === "Escape"', "returnFocusRef.current?.focus()", 'document.body.style.overflow = "hidden"']) {
  assert.ok(photoGallery.includes(contract), `DE: lightbox contract missing ${contract}`);
}
assert.equal((journal + journalEditor + photoGallery).includes("storagePath"), false, "DF: Storage paths must never enter journal UI");
assert.ok(expectedShape.includes("Projects.Media.addPhotos") && expectedShape.includes("Projects.Media.cleanupRequired"), "DG: photo translations missing");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "DG: six-locale photo catalog shape differs");
const photoJournalSql = (await readFile(new URL("../database/expedition_project_photo_journal.sql", import.meta.url), "utf8")).toLowerCase();
assert.ok(photoJournalSql.includes("drop constraint expedition_project_journal_body_check"));
assert.ok(photoJournalSql.includes("check (char_length(body) <= 12000)"), "CO: media-only deployment contract missing");

// Day-first journal timeline: journal media inherits its day exclusively through
// the existing nullable journal entry relationship.
assert.ok(detailPage.includes("entry.projectDayId === day.id") && detailPage.includes("projectDayId={day.id}"), "DI: each day must render and create only its own journal entries");
assert.ok(detailPage.includes("entry.projectDayId === null") && detailPage.includes("projectJournalEntries"), "DJ: nullable entries must remain available as secondary project notes");
assert.ok(journalEditor.includes("projectDayId: projectDayId ?? null"), "DK: day creation must persist project_day_id");
assert.ok(journalEditor.includes("projectDayId === undefined ? entry.projectDayId : projectDayId"), "DL: editing must preserve the entry day association");
assert.ok(dayEditor.includes("journalContent") && detailPage.includes("dayJournalTitle"), "DM: journal timeline must be composed inside the day card");
assert.ok(detailPage.includes('key={`day-weather-${day.id}`}') && detailPage.includes('key={`day-journal-${day.id}`}'),
  "ProjectDayEditor render-prop children must retain stable day-derived keys");
assert.equal(/journal_entry_id[^\n]*project_day_id|media[^\n]*projectDayId/i.test(mediaSource), false, "DN: media must not gain a second day relationship");
assert.ok(expectedShape.includes("Projects.Detail.dayJournalTitle") && expectedShape.includes("Projects.Mutations.newDayJournal"), "DO: day journal translations missing");

// Day journal photos are grouped locally for presentation while retaining their
// journal/media ownership and the project-wide signed-delivery batch.
const presentationBaseEntry = emptyBodyPhotoJournal.journalEntries[0];
const presentationBasePhoto = {
  ...presentationBaseEntry.media[0],
  signedUrl: "https://signed.invalid/photo",
  deliveryState: "ready",
};
const dayOnePhotoOnly = { ...presentationBaseEntry, id: "day-one-photo-only", projectDayId: ids.day, title: null, body: "" };
const dayOneMixed = { ...presentationBaseEntry, id: "day-one-mixed", projectDayId: ids.day, title: "Camp", body: "Notes" };
const dayOneTextOnly = { ...presentationBaseEntry, id: "day-one-text", projectDayId: ids.day, title: null, body: "Weather changed", media: [] };
const dayTwoPhotoOnly = { ...presentationBaseEntry, id: "day-two-photo-only", projectDayId: "day-two", title: null, body: "" };
const presentationDeliveries = [
  { ...presentationBasePhoto, id: "photo-day-two", journalEntryId: dayTwoPhotoOnly.id },
  { ...presentationBasePhoto, id: "photo-mixed", journalEntryId: dayOneMixed.id },
  { ...presentationBasePhoto, id: "photo-only", journalEntryId: dayOnePhotoOnly.id },
];
const dayOnePresentation = buildDayJournalPresentation(
  [dayOnePhotoOnly, dayOneMixed, dayOneTextOnly],
  presentationDeliveries,
);
assert.deepEqual(dayOnePresentation.media.map((photo) => photo.id), ["photo-mixed", "photo-only"],
  "Day gallery must collect all same-day photos in deterministic entry order");
assert.equal(dayOnePresentation.media.some((photo) => photo.id === "photo-day-two"), false,
  "Day 2 photos must not appear in the Day 1 gallery");
assert.deepEqual(dayOnePresentation.textEntries.map((entry) => entry.id), [dayOneMixed.id, dayOneTextOnly.id],
  "Photo-only entries must not render cards while text and mixed entries remain");
assert.equal(new Set(dayOnePresentation.media.map((photo) => photo.id)).size, dayOnePresentation.media.length,
  "Text-entry photos must appear only once in the day gallery");
assert.ok(journal.includes("buildDayJournalPresentation(entries, deliveries)") && journal.includes("compact && dayMedia.length > 0"),
  "Day journal must render one locally grouped day gallery");
assert.ok(journal.includes("showExistingPhotos={!compact}") && journal.includes("{!compact && <ProjectPhotoGallery"),
  "Compact text entries must not duplicate photos inside their cards or editor");
assert.ok(photoGallery.includes("deleteProjectJournalMedia(createClient(), projectId, photo.id)"),
  "Grouped thumbnails must retain exact individual media deletion");
assert.equal((journal.match(/\.from\(/g) ?? []).length, 0, "Day presentation must not add a Supabase query");
assert.equal((detailPage.match(/createProjectJournalMediaDeliveries\(/g) ?? []).length, 1,
  "Day galleries must retain one globally batched signed-delivery operation");
assert.ok(expectedShape.includes("Projects.Media.photosFromThisDay"), "Day photo gallery translation missing");

// Phase 6D DX-EY: validated video media, hybrid resumable transport, mixed
// day presentation, private delivery, accessible playback, and locale parity.
const validVideoMetadata = { mimeType: "video/mp4", sizeBytes: 1024, width: 1920, height: 1080, durationSeconds: 30, sortOrder: 0 };
assert.equal(validateProjectJournalMediaMetadata(validVideoMetadata).ok, true, "DX: valid MP4 rejected");
assert.equal(validateProjectJournalMediaMetadata({ ...validVideoMetadata, mimeType: "video/webm" }).ok, true, "DY: valid WebM rejected");
assert.equal(validateProjectJournalMediaMetadata({ ...validVideoMetadata, mimeType: "video/quicktime" }).ok, false, "DZ: unsupported video MIME accepted");
assert.equal(validateProjectJournalMediaMetadata({ ...validVideoMetadata, sizeBytes: 100 * 1024 * 1024 + 1 }).ok, false, "EA: oversized video accepted");
assert.equal(validateProjectJournalMediaMetadata({ ...validVideoMetadata, durationSeconds: 301 }).ok, false, "EB: overlong video accepted");
assert.equal(validateProjectJournalMediaMetadata({ ...validVideoMetadata, width: 3841 }).ok, false, "EC: oversized video dimensions accepted");
assert.deepEqual(validateJournalEntry({ body: "", mediaCount: 1 }), [], "ED: video-only journal entry rejected");
assert.deepEqual(validateJournalEntry({ body: "", mediaCount: 2 }), [], "EE: mixed media-only journal entry rejected");
assert.equal(selectProjectMediaUploadTransport("video", PROJECT_VIDEO_TUS_THRESHOLD_BYTES), "standard", "EF: threshold selection changed");
assert.equal(selectProjectMediaUploadTransport("video", PROJECT_VIDEO_TUS_THRESHOLD_BYTES + 1), "tus", "EF: large video must use TUS");
assert.equal(selectProjectMediaUploadTransport("photo", PROJECT_VIDEO_TUS_THRESHOLD_BYTES + 1), "standard", "EF: photos must retain standard upload");
assert.ok(mediaUploadTransportSource.indexOf("supabase.auth.getSession()") < mediaUploadTransportSource.indexOf("new Upload("), "EG: TUS must authenticate before transfer");
assert.equal(uploadInputBlock.includes("userId"), false, "EH: upload caller supplied userId");
assert.equal(buildProjectJournalMediaPath({ userId: ids.user, projectId: ids.project, journalEntryId: ids.entry, mediaId: ids.media, mimeType: "video/mp4" }), `${ids.user}/${ids.project}/${ids.entry}/${ids.media}/original.mp4`, "EI: MP4 path is not canonical");
assert.equal(buildProjectJournalMediaPath({ userId: ids.user, projectId: ids.project, journalEntryId: ids.entry, mediaId: ids.media, mimeType: "video/webm" }), `${ids.user}/${ids.project}/${ids.entry}/${ids.media}/original.webm`, "EJ: WebM path is not canonical");
assert.equal(buildProjectJournalMediaPath({ userId: ids.user, projectId: ids.project, journalEntryId: ids.entry, mediaId: ids.media, mimeType: "video/mp4" }).includes("movie.mp4"), false, "EK: filename entered path");
assert.ok(mediaSource.indexOf("uploadProjectMediaObject(supabase") < mediaSource.indexOf("metadataError"), "EL: video metadata precedes upload");
assert.ok(mediaSource.includes("media-metadata-and-cleanup-failed") && mediaSource.includes("remove([storagePath])"), "EM: metadata failure lacks cleanup");
assert.ok(mediaUploadTransportSource.includes("retryDelays") && mediaSource.includes('"media-upload-failed", true'), "EN: resumable failure must be retryable");
assert.ok(mediaUploadTransportSource.includes("Math.min(100, Math.max(0"), "EO: progress is not bounded");
const presentationVideo = { ...presentationBasePhoto, id: "video-mixed", journalEntryId: dayOneMixed.id, mediaType: "video", mimeType: "video/mp4", durationSeconds: 30 };
const mixedPresentation = buildDayJournalPresentation([dayOnePhotoOnly, dayOneMixed], [...presentationDeliveries, presentationVideo]);
assert.deepEqual(mixedPresentation.media.map((media) => media.id), ["photo-mixed", "photo-only", "video-mixed"], "EP: day gallery omitted mixed media");
assert.equal(mixedPresentation.media.some((media) => media.id === "photo-day-two"), false, "EQ: mixed day isolation failed");
assert.equal((detailPage.match(/createProjectJournalMediaDeliveries\(/g) ?? []).length, 1, "ER: signing must remain globally batched");
assert.equal((mediaSource + mediaDeliverySource + photoGallery).includes("getPublicUrl"), false, "ES: public URL introduced");
assert.ok(photoGallery.includes('preload="metadata"') && !photoGallery.includes('autoPlay'), "ET/EU: video must use controls without eager preload or autoplay");
assert.ok(photoGallery.includes("<video") && photoGallery.includes("controls") && photoGallery.includes("playsInline"), "EU: accessible video viewer missing");
assert.ok(photoGallery.includes("deleteProjectJournalMedia(createClient(), projectId, photo.id)"), "EV: video deletion must reuse media helper");
assert.ok(journalEditor.includes("entry?.media.length") && journalEditor.includes("PROJECT_JOURNAL_MEDIA_MAX_ITEMS"), "EW: combined media limit missing");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "EX: Phase 6D locale shapes differ");

// Phase 6D.1 EZ-FM: lazy, bounded, in-memory video posters without changing
// media persistence, private delivery, photo tiles, or viewer behavior.
assert.ok(photoGallery.includes("aspect-[4/3]") && photoGallery.includes("ProjectVideoThumbnail"), "EZ: video poster left the compact media cell");
assert.ok(videoThumbnail.includes("IntersectionObserver") && videoThumbnail.includes("MAX_CONCURRENT_POSTERS = 2"), "FA: poster work must be lazy and bounded");
assert.ok(videoThumbnail.includes(".catch(() => undefined)") && videoThumbnail.includes("<Video aria-hidden"), "FB: poster failure must retain fallback tile");
assert.equal((videoThumbnail + photoGallery + journalEditor).includes("autoPlay"), false, "FC: poster presentation introduced autoplay");
assert.equal((photoGallery.match(/<video\b/g) ?? []).length, 1, "FD: grid must not instantiate persisted video players");
assert.equal(videoThumbnail.includes("<video"), false, "FD: poster component must use one imperative decoder only when activated");
assert.equal(formatProjectVideoDuration(8), "0:08", "FE: short duration format changed");
assert.equal(formatProjectVideoDuration(84), "1:24", "FE: minute duration format changed");
assert.equal(formatProjectVideoDuration(299), "4:59", "FE: maximum duration format changed");
assert.ok(photoGallery.includes("deleteProjectJournalMedia(createClient(), projectId, photo.id)"), "FF: exact media deletion changed");
assert.ok(photoGallery.includes("h-11 w-11") && photoGallery.includes("h-8 w-8") && photoGallery.includes('aria-label={t(photo.mediaType === "video" ? "deleteVideo"'), "FG: compact delete control lost its accessible target or label");
assert.ok(photoGallery.includes('className="h-full w-full object-contain"'), "FH: photo object-contain behavior changed");
assert.ok(photoGallery.includes("controls playsInline preload=\"metadata\"") && photoGallery.includes("videoRef.current?.pause()"), "FI: video viewer behavior changed");
assert.equal((videoThumbnail + photoGallery).includes("getPublicUrl"), false, "FJ: poster introduced a public URL");
assert.equal(/storage|\.upload\(|poster_path|poster_url/i.test(videoThumbnail), false, "FK: poster component must not persist generated frames");
assert.equal(/database|\.sql|rls/i.test(videoThumbnail), false, "FL: poster presentation must not touch SQL/RLS");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "FM: Phase 6D.1 locale shapes differ");

const mojibakePattern = /(?:Ã|Â|â[\u0080-\u00bf\u2010-\u203a]|Ð[\u0080-\u00bf\u2010-\u203a]|Ñ[\u0080-\u00bf\u2010-\u203a]|\ufffd)/u;
function translatedStrings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(translatedStrings);
}
for (const catalog of catalogs) {
  assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "DP: project catalog contains mojibake");
}

const diagnosticsSource = await readFile(new URL("../Lib/projects/mediaDiagnostics.ts", import.meta.url), "utf8");
assert.ok(diagnosticsSource.includes('process.env.NODE_ENV !== "development"'), "DQ: diagnostics must be development-only");
const previousNodeEnv = process.env.NODE_ENV;
const previousConsoleInfo = console.info;
const diagnosticLogs = [];
try {
  process.env.NODE_ENV = "development";
  console.info = (...values) => diagnosticLogs.push(values);
  const diagnostic = createProjectMediaDiagnostic("storage-upload", { code: "403", statusCode: 403, message: "private detail" }, true);
  assert.deepEqual(diagnostic, { stage: "storage-upload", safeCode: "403", status: 403, cleanupSucceeded: null, retryable: true });
} finally {
  console.info = previousConsoleInfo;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}
assert.equal(diagnosticLogs.length, 1, "DQ: development failure must emit one safe diagnostic");
const diagnosticPayload = diagnosticLogs[0][1];
for (const forbidden of ["userId", "projectId", "journalEntryId", "storagePath", "filename", "signedUrl", "token"]) {
  assert.equal(Object.hasOwn(diagnosticPayload, forbidden), false, `DR: diagnostic exposed ${forbidden}`);
}
for (const stage of ["auth", "ownership-query", "file-validation", "storage-upload", "metadata-insert", "compensation-delete", "media-delete-storage", "media-delete-metadata", "journal-media-cleanup"]) {
  assert.ok(mediaSource.includes(`"${stage}"`), `DS: upload failure stage missing ${stage}`);
}
assert.ok(journalEditor.includes('mediaT("uploadFailed")') && journalEditor.includes('mediaT("uploadPartialFailure")'), "DT: UI errors must remain localized and generic");
assert.deepEqual(catalogs.map((catalog) => catalogShape(catalog)), Array(catalogs.length).fill(expectedShape), "DU: locale shapes must remain identical");
for (const counter of ["rawNestedMediaCount", "normalizedMediaCount", "pathsRequestedForSigning", "signedDeliveryCount"]) {
  assert.ok(displayDiagnosticSources.includes(counter), `DV: display diagnostic counter missing ${counter}`);
}
assert.ok(displayDiagnosticSources.includes("journalEntriesWithMediaCount"));
assert.ok(displayDiagnosticSources.includes("dayJournalEntryCount"));
assert.ok(displayDiagnosticSources.includes("photoDeliveryMatchCount"));
assert.ok(displayDiagnosticSources.includes("photoDeliveryAvailable"));
assert.ok(diagnosticsSource.includes('process.env.NODE_ENV !== "development"'), "DV: display diagnostics must be development-only");
const displayDiagnosticCalls = displayDiagnosticSources.match(/logProjectMediaDisplayDiagnostic\([\s\S]*?\}\);/g) ?? [];
assert.equal(displayDiagnosticCalls.length, 5, "DW: expected query, normalized, empty/non-empty delivery, and journal diagnostics");
for (const forbidden of ["userId", "projectId", "journalEntryId", "mediaId", "storagePath", "signedUrl", "filename", "token", "body"]) {
  assert.equal(displayDiagnosticCalls.some((call) => call.includes(`${forbidden}:`)), false, `DW: display diagnostic exposed ${forbidden}`);
}

// Phase 7A FN-GM: saved-track linking remains relational, private, bounded,
// day-stable, and separate from the canonical account importer.
const projectQueries = await readFile(new URL("../Lib/projects/queries.ts", import.meta.url), "utf8");
const projectMutations = await readFile(new URL("../Lib/projects/mutations.ts", import.meta.url), "utf8");
const trackEvidenceUi = await readFile(new URL("../components/projects/ProjectDayTrackEvidence.tsx", import.meta.url), "utf8");
const projectTracks = await readFile(new URL("../Lib/projects/tracks.ts", import.meta.url), "utf8");
const projectDetailPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");
const trackImportPage = await readFile(new URL("../app/[locale]/account/tracks/import/page.tsx", import.meta.url), "utf8");
assert.ok(dayTracksSql.includes("create table if not exists public.expedition_project_day_tracks"), "FN: relation SQL missing");
assert.equal(dayTracksSql.includes("__gps_activity_id_type__"), false, "FO: resolved Phase 7A SQL must not retain an activity ID placeholder");
assert.ok(dayTracksSql.includes("gps_activity_id bigint not null"), "FO: relation activity ID must match deployed bigint/int8");
assert.ok(dayTracksSql.includes("constraint gps_activities_phase7a_id_user_id_unique unique (id, user_id)"), "FQ: composite activity ownership FK requires its narrowly named supporting unique constraint");
const qualifiedDayTrackInsertPredicate = "d.id = expedition_project_day_tracks.project_day_id and d.project_id = expedition_project_day_tracks.project_id";
assert.ok(dayTracksSql.includes(qualifiedDayTrackInsertPredicate), "FQ: INSERT must bind the day to the outer relation project explicitly");
assert.ok(dayTracksPolicyRepairSql.includes(qualifiedDayTrackInsertPredicate), "FQ: repair and source INSERT predicates must agree");
for (const policySql of [dayTracksSql, dayTracksPolicyRepairSql]) {
  for (const selfComparison of ["d.project_id = d.project_id", "d.id = d.id", "p.id = p.id", "p.user_id = p.user_id", "a.id = a.id", "a.user_id = a.user_id"]) {
    assert.equal(policySql.includes(selfComparison), false, `FQ: Phase 7A policy contains accidental self-comparison: ${selfComparison}`);
  }
  assert.equal(/\b([a-z][a-z0-9_]*)\.(id|project_id|project_day_id|gps_activity_id|user_id)\s*=\s*\1\.\2\b/.test(policySql), false, "FQ: Phase 7A policy contains an equivalent alias self-comparison");
}
for (const outerReference of ["expedition_project_day_tracks.user_id", "expedition_project_day_tracks.project_id", "expedition_project_day_tracks.project_day_id", "expedition_project_day_tracks.gps_activity_id"]) {
  assert.ok(dayTracksSql.includes(outerReference), `FQ: source policies must explicitly qualify ${outerReference}`);
}
assert.match(dayTracksPolicyRepairSql, /^--[\s\S]*?begin;/, "FQ: policy repair must be transactional");
assert.ok(dayTracksPolicyRepairSql.trimEnd().endsWith("commit;"), "FQ: policy repair must commit atomically");
assert.equal((dayTracksPolicyRepairSql.match(/drop policy/g) ?? []).length, 1, "FQ: repair must replace only the proven affected policy");
assert.equal((dayTracksPolicyRepairSql.match(/create policy/g) ?? []).length, 1, "FQ: repair must recreate only the proven affected policy");
assert.ok(dayTracksPolicyRepairSql.includes("for insert to authenticated with check"), "FQ: repaired policy must remain authenticated INSERT-only");
assert.equal(/(?:insert into|update |delete from|alter table|grant |revoke )/.test(dayTracksPolicyRepairSql), false, "FQ: repair must not mutate data, schema, or grants");
assert.ok(dayTracksSql.includes("foreign key (project_id, project_day_id) references public.expedition_project_days(project_id, id) on delete cascade"), "FP: project/day integrity missing");
assert.ok(dayTracksSql.includes("foreign key (gps_activity_id, user_id) references public.gps_activities(id, user_id) on delete cascade"), "FQ/FU: activity ownership cascade missing");
assert.ok(dayTracksSql.includes("unique (project_day_id, gps_activity_id)"), "FR: duplicate same-day link not prevented");
assert.equal(dayTracksSql.includes("unique (project_day_id)"), false, "FS: multiple tracks per day blocked");
assert.equal(dayTracksSql.includes("unique (gps_activity_id)"), false, "FT: one activity must remain linkable to multiple days");
assert.ok(projectMutations.includes('rpc("unlink_expedition_project_day_track"') && projectMutations.includes("unlinkTrackFromProjectDay"), "FV: unlink relation mutation missing");
assert.ok(projectQueries.includes('.from("gps_activities")') && projectQueries.includes('.eq("user_id", userId)'), "FW: picker must load owned tracks only");
assert.ok(projectMutations.includes("linkExistingTrackToProjectDay") && !/linkExistingTrackToProjectDay[\s\S]{0,180}userId/.test(projectMutations), "FX: link input must not accept userId");
assert.ok(dayTracksSql.includes("user_id = auth.uid()") && dayTracksSql.includes("for insert to authenticated with check"), "FY: cross-user link boundary missing");
assert.ok(projectQueries.includes("listProjectDayTrackEvidence") && projectQueries.includes("gps_activities!expedition_project_day_tracks_activity_owner_fk"), "FZ: evidence query must be bounded and nested");
assert.ok(trackEvidenceUi.includes("track.distanceM") && projectTracks.includes("track.detectionStatus"), "GA/GB: stored stats and detection must be reused");
assert.equal((projectMutations + trackEvidenceUi).includes("user_ascents"), false, "GC: project evidence must not mutate global ascents");
assert.ok(trackEvidenceUi.includes('href={`/account/tracks/${track.activityId}`}'), "GD: canonical account route missing");
assert.ok(projectDetailPage.includes('from("activity-tracks").createSignedUrls') && !trackEvidenceUi.includes("getPublicUrl"), "GE: GeoJSON must remain private");
assert.ok(trackEvidenceUi.includes("expanded && signedUrl &&") && trackEvidenceUi.includes("<ActivityTrackMap"), "GF: map must mount only after expansion");
assert.ok(projectDetailPage.includes("track.projectDayId === day.id"), "GG: day isolation missing");
assert.ok(dayTracksSql.includes("project_day_id uuid not null") && !dayTracksSql.includes("day_number"), "GH: linkage must survive day reordering");
assert.ok(trackEvidenceUi.includes("window.confirm") && trackEvidenceUi.includes("unlinkTrackConfirm"), "GI: unlink confirmation missing");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "GJ: Phase 7A locale shapes differ");
assert.equal(trackEvidenceUi.includes("parseGpxFile") || trackEvidenceUi.includes(".upload("), false, "GK: project-day GPX upload introduced");
assert.ok(trackImportPage.includes("importGpxActivity") && !trackImportPage.includes("parseGpxFile(selectedFile)"), "GL: account page must use the canonical shared importer");
assert.equal((trackEvidenceUi + projectMutations).includes("watchPosition"), false, "GM: live GPS recording reintroduced");
assert.equal(deriveProjectTrackVerification({ processingStatus: "ready", gpsVerified: true, detectionStatus: "detected", detectedMountainId: 1, detectionConfidence: 0.8 }), "verified");
assert.equal(deriveProjectTrackVerification({ processingStatus: "ready", gpsVerified: false, detectionStatus: "detected", detectedMountainId: 1, detectionConfidence: 0.4 }), "likely");
assert.equal(deriveProjectTrackVerification({ processingStatus: "processing", gpsVerified: false, detectionStatus: null, detectedMountainId: null, detectionConfidence: null }), "unavailable");

// Phase 7B GN-HJ: the existing account flow delegates to one reusable import
// transaction without changing its canonical persistence or navigation result.
const sharedGpxImporter = await readFile(new URL("../Lib/tracks/importGpxActivity.ts", import.meta.url), "utf8");
assert.ok(sharedGpxImporter.includes("export async function importGpxActivity"), "GN: shared GPX importer missing");
assert.ok(trackImportPage.includes("await importGpxActivity({"), "GO: account page does not call shared importer");
for (const duplicateOperation of ['.from("gps_activities")', '.from("activity-tracks")', ".upload(", ".remove(", "parseGpxFile(", "detectMountainFromTrack("]) {
  assert.equal(trackImportPage.includes(duplicateOperation), false, `GP/HI: account page duplicates import operation ${duplicateOperation}`);
}
assert.ok(sharedGpxImporter.includes("supabase.auth.getUser()"), "GQ: importer must authenticate internally");
assert.equal(/GpxImportInput[\s\S]{0,220}userId/.test(sharedGpxImporter), false, "GR: caller must not provide userId");
assert.ok(sharedGpxImporter.includes('GPX_ACTIVITY_BUCKET = "activity-tracks"'), "GS: private activity-tracks bucket changed");
assert.deepEqual(buildGpxActivityPaths("user", 42), { originalPath: "user/42/original.gpx", geoJsonPath: "user/42/track.geojson" }, "GT/GY: canonical paths changed");
assert.ok(sharedGpxImporter.includes("dependencies.parse(file)") && sharedGpxImporter.includes("parse: parseGpxFile"), "GU: existing parser not reused");
assert.ok(sharedGpxImporter.includes("dependencies.detect({ supabase, geojson: track.geojson })") && sharedGpxImporter.includes("detect: detectMountainFromTrack"), "GV: existing detector not reused");
for (const field of ["started_at", "finished_at", "duration_seconds", "distance_m", "elevation_gain_m", "minimum_elevation_m", "maximum_elevation_m"]) assert.ok(sharedGpxImporter.includes(field), `GW: statistic field missing ${field}`);
for (const field of ["detected_mountain_id", "detection_distance_m", "detection_confidence", "detection_status", "gps_verified"]) assert.ok(sharedGpxImporter.includes(field), `GX: detection field missing ${field}`);
assert.ok(sharedGpxImporter.indexOf('.insert({') < sharedGpxImporter.indexOf("originalUploadAttempted = true"), "GZ: activity row must precede upload");
assert.ok(sharedGpxImporter.includes("originalUploadAttempted ? originalPath") && sharedGpxImporter.includes("geoJsonUploadAttempted ? geoJsonPath"), "HA-HC: cleanup must track attempted objects");
assert.ok(sharedGpxImporter.includes('failureReason = "metadata-update"') && sharedGpxImporter.includes("compensateFailedImport"), "HD: metadata failure must compensate");
assert.ok(sharedGpxImporter.includes('reason: "cleanup-required"'), "HE: cleanup failure result missing");
assert.ok(sharedGpxImporter.includes("gpsActivityId: activityId"), "HF: success must return activity ID");
assert.ok(trackImportPage.includes('router.push(`/account/tracks/${result.gpsActivityId}`)'), "HG: account success navigation changed");
assert.equal(sharedGpxImporter.includes("expedition_project_day_tracks"), false, "HH: Phase 7B must not link project days");
assert.equal(sharedGpxImporter.includes("watchPosition"), false, "HJ: shared importer introduced live GPS recording");

// Phase 7C HK-IC: project-day upload composes the shared importer with the
// existing relation mutation and preserves the canonical track on link failure.
assert.ok(trackEvidenceUi.includes("await importGpxActivity({") && trackEvidenceUi.includes('source: "other"'), "HK: day upload must use the shared importer and existing generic source");
for (const duplicateOperation of ['.from("gps_activities")', '.from("activity-tracks")', ".upload(", "parseGpxFile(", "detectMountainFromTrack("]) assert.equal(trackEvidenceUi.includes(duplicateOperation), false, `HL-HN: project component duplicates GPX transaction operation ${duplicateOperation}`);
assert.ok(trackEvidenceUi.includes("result.gpsActivityId") && trackEvidenceUi.includes("linkExistingTrackToProjectDay"), "HO: import result must flow into existing link helper");
assert.ok(trackEvidenceUi.indexOf("if (!result.ok)") < trackEvidenceUi.indexOf("setImportedActivityId(result.gpsActivityId)"), "HP: import failure must stop before linking");
assert.ok(trackEvidenceUi.includes("uploadDialogRef.current?.close()") && trackEvidenceUi.includes("router.refresh()"), "HQ: import/link success must refresh project");
assert.equal(trackEvidenceUi.includes('router.push(`/account/tracks/'), false, "HR: day upload must not navigate to account track");
assert.ok(trackEvidenceUi.includes("setImportedActivityId(result.gpsActivityId)") && trackEvidenceUi.includes('setUploadState("link-failed")'), "HS: link failure must retain imported activity ID");
const retryFunction = trackEvidenceUi.match(/async function retryImportedLink\(\)[\s\S]*?\n  }/)?.[0] ?? "";
assert.ok(retryFunction.includes("linkImportedTrack(importedActivityId)") && !retryFunction.includes("importGpxActivity"), "HT: retry must link only");
assert.ok(trackEvidenceUi.includes('t("trackAvailableInAccount")'), "HU: canonical activity availability after link failure must be communicated");
assert.ok(trackEvidenceUi.includes('result.reason !== "conflict"'), "HV: duplicate relation must normalize as success");
assert.ok(projectMutations.includes('rpc("unlink_expedition_project_day_track"') && !projectMutations.includes('from("gps_activities").delete()'), "HW: unlink must remain relation-only");
assert.ok(dayTracksSql.includes("references public.gps_activities(id, user_id) on delete cascade"), "HX: account deletion cascade changed");
assert.ok(trackImportPage.includes("await importGpxActivity({"), "HY: account import must still use shared importer");
assert.equal((trackEvidenceUi.match(/await importGpxActivity\(/g) ?? []).length, 1, "HZ: project UI must invoke one canonical GPX importer");
assert.equal(trackEvidenceUi.includes("watchPosition"), false, "IA: day upload introduced live GPS recording");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "IB: Phase 7C locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "IC: Phase 7C catalog contains mojibake");

// Phase 8 ID-IZ: reversible lifecycle reporting is derived entirely from the
// already-loaded private project graph.
const evidenceBase = { relationId: "r1", projectDayId: "d1", activityId: 10, title: "Track", sourceType: "other", startedAt: null, distanceM: 12000, durationSeconds: 3600, elevationGainM: 900, processingStatus: "ready", detectedMountainId: 1, detectedMountainName: null, detectionConfidence: 0.8, detectionStatus: "detected", gpsVerified: true, geoJsonPath: "private" };
const completionProject = { ...detail, days: [
  { ...detail.days[0], trackEvidence: [evidenceBase] },
  { ...detail.days[0], id: "d2", dayNumber: 2, mountains: [detail.mountains[0]], trackEvidence: [{ ...evidenceBase, relationId: "r2", projectDayId: "d2" }] },
], journalEntries: [{ id: "j1", projectId: "p1", userId: "u1", projectDayId: "d1", entryDate: "2026-01-01", title: null, body: "note", createdAt: "2026-01-01", updatedAt: "2026-01-01", media: [
  { id: "m1", journalEntryId: "j1", projectId: "p1", userId: "u1", mediaType: "photo", storagePath: "x", originalFilename: "x", mimeType: "image/jpeg", sizeBytes: 1, width: 1, height: 1, durationSeconds: null, sortOrder: 0, createdAt: "2026-01-01" },
  { id: "m2", journalEntryId: "j1", projectId: "p1", userId: "u1", mediaType: "video", storagePath: "y", originalFilename: "y", mimeType: "video/mp4", sizeBytes: 1, width: 1, height: 1, durationSeconds: 1, sortOrder: 1, createdAt: "2026-01-01" },
] }] };
const completion = buildProjectCompletionSummary(completionProject);
assert.equal(completion.uniqueTrackCount, 1, "ID-IF: duplicate activity must count once");
assert.equal(completion.totalDistanceM, 12000, "IG: ready canonical distance must count once");
assert.equal(completion.totalElevationGainM, 900);
assert.equal(completion.totalDurationSeconds, 3600);
assert.equal(completion.photoCount, 1, "IH: photo total incorrect");
assert.equal(completion.videoCount, 1, "IH: video total incorrect");
assert.equal(completion.journalEntryCount, 1, "II: journal total incorrect");
assert.equal(completion.mountainEvidence.find((item) => item.mountainId === 1)?.state, "verified", "IJ/IK: verified evidence must aggregate and outrank likely");
assert.equal(completion.mountainEvidence.find((item) => item.mountainId === 2)?.state, "not-detected", "IL: unmatched evidence state must remain distinct");
assert.equal(completion.daysWithGpsEvidence, 2, "IM: days-with-evidence incorrect");
const completionSource = await readFile(new URL("../Lib/projects/completion.ts", import.meta.url), "utf8");
const statusControlSource = await readFile(new URL("../components/projects/ProjectStatusControl.tsx", import.meta.url), "utf8");
const projectsListSource = await readFile(new URL("../app/[locale]/projects/page.tsx", import.meta.url), "utf8");
assert.equal(completionSource.includes("weather"), false, "IN: weather must not affect completion");
assert.ok(completionSource.includes("readyToComplete: project.days.length > 0 && project.mountains.length > 0"), "IO: media must not be required for completion");
assert.ok(statusControlSource.includes("<dialog") && statusControlSource.includes("completeProjectConfirm"), "IP: completion confirmation missing");
assert.ok(statusControlSource.includes("completionEvidenceMissing") && statusControlSource.includes("void change(next)"), "IQ: evidence warning must not block completion");
assert.equal(projectDetailPage.includes('status === "completed"') && projectDetailPage.includes("ProjectDayEditor"), true, "IR: completed projects must remain editable");
assert.equal(projectMutations.includes("function archiveProject"), false, "IS: archive must remain a reversible status update, not a delete mutation");
assert.ok(statusControlSource.includes("PROJECT_STATUSES.filter") && statusControlSource.includes("allowArchive"), "IT: owner restore remains available while editor archive is excluded");
assert.equal((projectDetailPage + projectsListSource).includes("getPublicUrl"), false, "IU/IV: lifecycle must remain private");
assert.ok(projectDetailPage.includes("buildProjectCompletionSummary(project)"), "IW: report must derive from loaded project without N+1");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "IX: Phase 8 locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "IY: Phase 8 catalog contains mojibake");
assert.equal(completionSource.includes("parseGpxFile"), false, "IZ: completion totals must not reparse GPX");
assert.ok(projectsListSource.includes("lifecycleOrder") && projectsListSource.includes('data-lifecycle-group'), "Phase 8: project list lifecycle ordering missing");

// Phase 9 JA-KF: private printable report composes the Phase 8 summary and the
// established bounded delivery/query architecture.
const reportPage = await readFile(new URL("../app/[locale]/projects/[projectId]/report/page.tsx", import.meta.url), "utf8");
const reportModelSource = await readFile(new URL("../Lib/projects/report.ts", import.meta.url), "utf8");
const printButtonSource = await readFile(new URL("../components/projects/ProjectReportPrintButton.tsx", import.meta.url), "utf8");
const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
assert.ok(reportPage.includes("ProjectReportPage"), "JA: private report route missing");
assert.ok(reportPage.includes("requireProjectAccess") && reportPage.includes("getAccessibleProject"), "JB: private report collaboration boundary missing");
assert.ok(reportModelSource.includes("buildProjectCompletionSummary(project)"), "JC/JD: report must compose the sole completion summary");
const reportModel = buildProjectExpeditionReport(completionProject);
assert.equal(reportModel.summary.uniqueTrackCount, 1, "JE: report deduplication must remain authoritative");
assert.equal(reportPage.includes("parseGpxFile"), false, "JF: report must not parse GPX");
assert.ok(reportPage.includes('t("planned")') && reportPage.includes('t("actual")'), "JG: planned and actual must remain distinct");
assert.ok(reportPage.includes("report.summary.mountainEvidence"), "JH: mountain outcomes must reuse Phase 8 aggregation");
assert.deepEqual(reportModel.days.map((item) => item.day.dayNumber), [1, 2], "JI: report days must remain deterministic");
assert.ok(reportModelSource.includes("entry.projectDayId === day.id"), "JJ-JL: journal and media must remain day-scoped");
assert.ok(reportPage.includes("entry.body.trim()||entry.title"), "JM: media-only entries must not create empty text cards");
assert.ok(reportPage.includes("createProjectJournalMediaDeliveries") && reportPage.includes("deliveryById"), "JN: report must use private signed delivery");
assert.equal(reportPage.includes("getPublicUrl"), false, "JO: report introduced a public URL");
assert.equal(reportPage.includes("signed_url") || reportPage.includes("signedUrl:") && reportPage.includes("insert"), false, "JP: report must not persist signed URLs");
assert.ok(printButtonSource.includes("window.print()"), "JQ/JR: report export must use browser print");
assert.ok(globalCss.includes("@media print") && globalCss.includes(".project-report-control"), "JS: interactive controls must hide in print");
assert.ok(globalCss.includes(".project-report video") && reportPage.includes('t("video")'), "JT/JU: printed videos must be static tiles");
assert.ok(globalCss.includes("report-media-grid") && reportPage.includes("grid-cols-3"), "JV: compact print photo grid missing");
assert.ok(reportPage.includes('t("mediaUnavailable")'), "JW: unavailable media fallback missing");
assert.equal((reportPage.match(/listProjectDayTrackEvidence/g) ?? []).length, 2, "JX: report must use one imported bounded evidence query and one call");
assert.equal(reportPage.includes("ActivityTrackMap"), false, "JY: report must not eagerly mount maps");
assert.ok(reportModelSource.includes('project.status === "completed" ? "completed" : "preview"'), "JZ/KA: report state distinction missing");
assert.equal(reportModelSource.includes("archived"), false, "KB: archived reports must remain available through preview path");
assert.equal((dayTracksSql + reportModelSource).includes("expedition_reports"), false, "KC: report snapshots are forbidden");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "KD: Phase 9 locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "KE: Phase 9 catalog contains mojibake");
assert.equal(reportPage.includes("/share/") || reportPage.includes("/public/"), false, "KF: public sharing introduced");

// Phase 10 KG-LL: public sharing is an explicit, revocable server-mediated
// projection. Private source tables and Storage remain inaccessible to anon.
const publicReportSource = await readFile(new URL("../Lib/projects/publicReport.ts", import.meta.url), "utf8");
const adminClientSource = await readFile(new URL("../Lib/supabase/admin.ts", import.meta.url), "utf8");
const sharingSource = await readFile(new URL("../Lib/projects/sharing.ts", import.meta.url), "utf8");
const sharingControlSource = await readFile(new URL("../components/projects/ProjectSharingControl.tsx", import.meta.url), "utf8");
const publicPageSource = await readFile(new URL("../app/[locale]/expeditions/[slug]/page.tsx", import.meta.url), "utf8");
const publicMediaSource = await readFile(new URL("../app/api/public-expeditions/[slug]/media/[handle]/route.ts", import.meta.url), "utf8");
assert.ok(projectSharesSql.includes("create table if not exists public.expedition_project_shares"), "KG: share table missing");
assert.ok(projectSharesSql.includes("alter table public.expedition_project_shares enable row level security"), "KH: share RLS missing");
assert.ok(projectSharesSql.includes("revoke all on public.expedition_project_shares from public, anon"), "KI: anon table access must be revoked");
assert.equal(projectSharesSql.includes("to anon"), false, "KJ: sharing SQL must not add anon policies");
assert.ok(projectSharesSql.includes("p.status in ('completed','archived')"), "KK: only terminal projects may resolve publicly");
assert.ok(projectSharesSql.includes("grant execute on function public.resolve_public_expedition_share(text) to service_role"), "KL: resolver must remain server-only");
assert.ok(projectSharesSql.includes("create or replace function public.get_public_expedition_report") && projectSharesSql.includes("returns jsonb"), "KL: sanitized report RPC missing");
const publicRpcPayload = projectSharesSql.split("jsonb_build_object(")[1]?.split(")\n  from")[0] ?? "";
assert.equal(/user_id|project_id|storage_path/.test(publicRpcPayload), false, "KL: sanitized report RPC exposes private identifiers");
assert.ok(adminClientSource.includes('import "server-only"') && adminClientSource.includes("SUPABASE_SECRET_KEY") && adminClientSource.includes("SUPABASE_SERVICE_ROLE_KEY"), "KM: privileged client boundary missing");
assert.equal((sharingSource + sharingControlSource).includes("createAdminClient"), false, "KN: privileged client reached owner browser code");
assert.ok(sharingSource.includes("crypto.getRandomValues(new Uint8Array(24))"), "KO: high-entropy slug generation missing");
assert.ok(sharingSource.includes('.in("status", ["completed", "archived"])'), "KP: owner enable flow lacks lifecycle guard");
assert.ok(sharingSource.includes("is_enabled: false") && sharingControlSource.includes("disableSharing"), "KQ: revocation control missing");
assert.ok(publicPageSource.includes("loadPublicExpeditionReport(slug)") && publicPageSource.includes("index: true, follow: true"), "KR: public route or indexing metadata missing");
assert.equal(publicPageSource.includes("requireProjectUser") || publicPageSource.includes("getUserProject"), false, "KS: public page must consume only the sanitized model");
for (const privateField of ["projectId", "ownerId", "userId", "storagePath", "originalFilename", "activityId", "mountainId"]) assert.equal(publicPageSource.includes(privateField), false, `KT: public page exposes private field ${privateField}`);
assert.ok(publicReportSource.includes("type PublicSummary") && !/type PublicSummary[\s\S]{0,800}mountainEvidence/.test(publicReportSource), "KU: public summary must omit identifier-bearing evidence");
assert.ok(publicMediaSource.includes("resolvePublicPhoto(slug, handle,") && publicReportSource.includes('.eq("project_id", resolved.projectId)'), "KV: media proxy must revalidate share and project membership");
assert.equal(publicMediaSource.includes("storage_path") || publicMediaSource.includes("createSignedUrl") || publicMediaSource.includes("getPublicUrl"), false, "KW: media response must not expose private delivery data");
assert.ok(publicPageSource.includes("videoUnavailable") && !publicPageSource.includes("<video"), "KX: unsafe public video streaming must use a placeholder");
assert.equal(publicPageSource.includes("ActivityTrackMap") || publicReportSource.includes("geoJsonPath"), false, "KY: public report must not expose private track geometry");
assert.ok(projectDetailPage.includes("ProjectSharingControl") && projectDetailPage.includes('status === "completed" || project.status === "archived"'), "KZ: owner sharing controls lack lifecycle boundary");
assert.equal((projectSharesSql + publicReportSource + publicPageSource).includes("getPublicUrl"), false, "LA: public buckets or URLs are forbidden");
assert.equal(projectSharesSql.includes("expedition_project_journal_media") || projectSharesSql.includes("gps_activities"), false, "LB: sharing SQL must not loosen private source tables");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "LC: Phase 10 locale shapes differ");
assert.ok(publicReportSource.includes("listProjectDayTrackEvidence") && publicReportSource.includes("getUserProject"), "LD: public report must reuse bounded canonical queries");
assert.ok(publicPageSource.includes("report.days.map") && publicPageSource.includes("report.mountains.map"), "LE: sanitized report is incomplete");
assert.equal(publicReportSource.includes("signedUrl") || publicReportSource.includes("public_slug:"), false, "LF: public projection must not return delivery URLs or slug fields");
assert.ok(projectSharesSql.includes("project_id uuid not null unique") && projectSharesSql.includes("on delete cascade"), "LG: one share per project and lifecycle cleanup missing");
assert.ok(projectSharesSql.includes("public_slug ~ '^[a-za-z0-9_-]{32,128}$'"), "LH: slug format constraint missing");
assert.ok(publicMediaSource.includes('"Cache-Control": "private, no-store"') && publicMediaSource.includes('"X-Content-Type-Options": "nosniff"'), "LI: proxy response hardening missing");
assert.equal(publicPageSource.includes('href="/account/') || publicPageSource.includes('href="/projects/'), false, "LJ: public report links into private account surfaces");
assert.ok(sharingSource.includes("existing") && sharingSource.includes("public_slug") && sharingSource.includes("?? createPublicSlug()"), "LK: disable/re-enable must preserve stable slug");
assert.equal(publicReportSource.includes("weather"), false, "LL: Phase 10 must not expand into weather publication");

// Phase 10.1 LM-MF: the contact sheet requests bounded lazy thumbnails while
// originals remain behind the same immediately revocable authorization path.
assert.ok(publicPageSource.includes('loading="lazy"') && publicPageSource.includes("?variant=thumb"), "LM/LN: public grid must lazily request thumbnails");
assert.ok(publicMediaSource.includes('requestedVariant !== "thumb" && requestedVariant !== "original"'), "LO/LP: media variants must use a closed server-defined allowlist");
assert.equal(publicMediaSource.includes("searchParams.get(\"width\")") || publicMediaSource.includes("searchParams.get(\"height\")") || publicMediaSource.includes("searchParams.get(\"quality\")"), false, "LP: anonymous callers must not choose transform dimensions");
assert.ok(publicReportSource.includes('variant === "thumb"') && publicReportSource.includes("width: 256") && publicReportSource.includes("height: 256") && publicReportSource.includes('resize: "contain"'), "LO: canonical thumbnail transform missing");
assert.ok(publicMediaSource.includes('?? "original"') && publicMediaSource.includes("resolvePublicPhoto(slug, handle,"), "LQ: original delivery must remain on the validated proxy");
assert.equal((publicPageSource + publicMediaSource).includes("storage_path") || (publicPageSource + publicMediaSource).includes("getPublicUrl"), false, "LR/LS: public route must not expose Storage paths or URLs");
assert.equal(projectSharesSql.includes("storage.objects") || projectSharesSql.includes("to anon"), false, "LT: Phase 10.1 must not add anonymous Storage access");
const mediaResolverSource = publicReportSource.match(/async function resolveMediaShare[\s\S]*?\n}/)?.[0] ?? "";
assert.ok(mediaResolverSource.includes("resolve_public_expedition_share") && !mediaResolverSource.includes("get_public_expedition_report") && !mediaResolverSource.includes("getUserProject"), "LU: photo proxy must use the narrow share resolver");
assert.ok(publicReportSource.includes('.eq("project_id", resolved.projectId)') && publicReportSource.includes('.eq("media_type", "photo")'), "LV: same-project photo membership check missing");
assert.ok(mediaResolverSource.includes("resolve_public_expedition_share"), "LW: every media request must revalidate enabled share status");
assert.ok(publicReportSource.includes("10 * 1024 * 1024") && publicReportSource.includes('["image/jpeg", "image/png", "image/webp"]'), "LX: photo MIME/size bounds missing");
assert.ok(publicPageSource.includes("videoUnavailable") && !publicPageSource.includes("<video"), "LY: public video behavior changed");
assert.equal(publicPageSource.includes("ActivityTrackMap") || publicReportSource.includes("geoJsonPath"), false, "LZ: track geometry became public");
assert.equal(mediaResolverSource.includes("getUserProject") || mediaResolverSource.includes("listProjectDayTrackEvidence"), false, "MA: media resolver rebuilds the project graph");
assert.ok(publicMediaSource.includes('process.env.NODE_ENV === "development"') && publicMediaSource.includes('"[PublicMedia DEV]"'), "MB: timing diagnostics must remain development-only");
for (const forbiddenDiagnostic of ["slug,", "handle,", "mediaId", "projectId", "userId", "storagePath", "filename", "signedUrl", "serviceKey"]) assert.equal(publicMediaSource.split('"[PublicMedia DEV]"')[1]?.includes(forbiddenDiagnostic) ?? false, false, `MC: diagnostic exposes ${forbiddenDiagnostic}`);
assert.ok(publicPageSource.includes("index: true, follow: true"), "MD: public report indexing changed");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "ME: Phase 10.1 locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "MF: Phase 10.1 catalog contains mojibake");

// Phase 11A MG-NK: membership and invitations establish collaboration roles
// without broadening the owner-only private project graph before Phase 11B.
const collaborationSource = await readFile(new URL("../Lib/projects/collaboration.ts", import.meta.url), "utf8");
const teamSource = await readFile(new URL("../components/projects/ProjectTeam.tsx", import.meta.url), "utf8");
const invitationsSource = await readFile(new URL("../components/projects/ProjectInvitations.tsx", import.meta.url), "utf8");
assert.ok(collaborationSql.includes("create table if not exists public.expedition_project_members") && collaborationSql.includes("create table if not exists public.expedition_project_invitations"), "MG/MH: collaboration schemas missing");
assert.ok(collaborationSql.includes("check (role in ('editor', 'viewer'))"), "MI: closed member role constraint missing");
assert.ok(collaborationSql.includes("unique (project_id, user_id)"), "MJ: duplicate membership protection missing");
assert.ok(collaborationSql.includes("where status = 'pending'"), "MK: duplicate pending invitation protection missing");
assert.ok((collaborationSql.match(/references public\.expedition_projects\(id\) on delete cascade/g) ?? []).length >= 2, "ML: project cascade missing");
assert.ok(collaborationSql.includes("project.user_id <> actor") && collaborationSql.includes("p.user_id = auth.uid()"), "MM/MN: owner authorization is not independently proven");
assert.ok(collaborationSql.includes("inviter_user_id, invitee_user_id") && collaborationSql.includes("values(requested_project_id, actor, requested_invitee_id"), "MO: inviter must derive from auth.uid()");
assert.ok(collaborationSql.includes("invitation.invitee_user_id <> actor") && collaborationSql.includes("invitee_user_id = auth.uid()"), "MP/MQ: invitee-only transitions missing");
const acceptFunction = collaborationSql.match(/create or replace function public\.accept_expedition_project_invitation[\s\S]*?end;\$function\$/)?.[0] ?? "";
assert.ok(acceptFunction.includes("for update") && acceptFunction.includes("insert into public.expedition_project_members") && acceptFunction.includes("status = 'accepted'"), "MR/MS: atomic acceptance contract missing");
assert.ok(acceptFunction.includes("invitation.status <> 'pending'"), "MT: cancelled or declined invitations can be accepted");
assert.ok(collaborationSql.includes("requested_invitee_id = actor") && collaborationSql.includes("already a member"), "MU/MV: owner and existing-member invitation guards missing");
assert.ok(collaborationSql.includes("change_expedition_project_member_role") && collaborationSql.includes("p.user_id = auth.uid()"), "MW: role change is not owner-only");
assert.equal(canManageProjectMembers("editor"), false, "MX: editor can manage membership");
assert.equal(canManageProjectMembers("viewer"), false, "MY: viewer can manage membership");
assert.equal(canManageProjectMembers("owner"), true, "MZ: owner cannot manage membership");
assert.ok(collaborationSql.includes("delete from public.expedition_project_members where project_id = requested_project_id and user_id = auth.uid()") && collaborationSql.includes("project owners cannot leave"), "NA/NB: member leave or owner guard missing");
assert.equal(/delete from (auth\.users|public\.gps_activities)/.test(collaborationSql), false, "NC: member removal deletes global resources");
assert.deepEqual([canViewProject("owner"), canViewProject("editor"), canViewProject("viewer"), canEditProject("viewer")], [true, true, true, false], "ND: central access-role helper behavior changed");
assert.equal(projectSharesSql.includes("expedition_project_members") || collaborationSql.includes("resolve_public_expedition_share"), false, "NE: Phase 10 and collaboration authorization became coupled");
assert.ok(collaborationSql.includes("revoke all on public.expedition_project_members, public.expedition_project_invitations from public, anon, authenticated"), "NF: anonymous table privileges not revoked");
assert.equal((teamSource + invitationsSource).includes("service_role") || (teamSource + invitationsSource).includes("SUPABASE_SECRET_KEY"), false, "NG: privileged key reached browser code");
assert.ok(collaborationSource.includes('.from("profiles").select("id,username,display_name,avatar_url").in('), "NH: team profile lookup must be batched");
assert.equal(collaborationSource.includes("email") || collaborationSource.includes("auth_metadata"), false, "NI: collaboration identity exposes private account data");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "NJ: Phase 11A locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "NK: Phase 11A catalog contains mojibake");

// Phase 11B NL-PE: accepted members can use the private workspace without
// weakening owner controls, account-track privacy, or Phase 10 sharing.
const projectAuthSource = await readFile(new URL("../Lib/projects/auth.ts", import.meta.url), "utf8");
const trackEvidenceSource = await readFile(new URL("../components/projects/ProjectDayTrackEvidence.tsx", import.meta.url), "utf8");
const journalSource = await readFile(new URL("../components/projects/ProjectJournal.tsx", import.meta.url), "utf8");
const sharedProjectsSource = await readFile(new URL("../components/projects/SharedProjects.tsx", import.meta.url), "utf8");
assert.ok(collaborationAccessSql.includes("expedition_projects_collaborator_select") && collaborationAccessSql.includes("m.user_id = auth.uid()"), "NL/NM: editor/viewer project SELECT missing");
assert.ok(projectAuthSource.includes('role === "none"') && projectAuthSource.includes("notFound()"), "NN: non-member route disclosure guard missing");
assert.equal(canEditProject("viewer"), false, "NO: viewer can mutate");
assert.equal(canEditProject("editor"), true, "NP: editor cannot edit planning content");
assert.equal(canManageProjectMembers("editor"), false, "NQ: editor can manage members");
assert.equal(canManageSharing("editor"), false, "NR: editor can manage public sharing");
assert.equal(canDeleteProject("editor"), false, "NS: editor can delete project");
assert.equal(canChangeLifecycle("editor", "archived"), false, "NT: editor can archive");
assert.deepEqual([canViewProject("owner"), canEditProject("owner"), canManageSharing("owner")], [true, true, true], "NU: owner authorization changed");
assert.ok(sharedProjectsSource.includes('href={`/projects/${project.projectId}`}'), "NV: shared project cards do not navigate");
assert.ok(reportPage.includes("requireProjectAccess") && reportPage.includes("getAccessibleProject"), "NW/NX: viewer/editor private report access missing");
for (const policy of ["expedition_project_mountains_collaboration_select", "expedition_project_days_collaboration_select", "expedition_project_day_mountains_collaboration_select", "expedition_project_journal_collaboration_select", "expedition_project_journal_media_collaboration_select", "expedition_project_day_tracks_collaboration_select"]) assert.ok(collaborationAccessSql.includes(policy), `NY: membership-aware SELECT missing for ${policy}`);
assert.ok(collaborationAccessSql.includes("create or replace function public.add_expedition_project_day") && collaborationAccessSql.includes("can_edit_expedition_project(requested_project_id)"), "NZ/OA: editor/viewer atomic-day boundary missing");
assert.ok(collaborationAccessSql.includes("expedition_project_mountains_editor_insert") && collaborationAccessSql.includes("can_edit_expedition_project"), "OB/OC: mountain role boundary missing");
assert.ok(collaborationAccessSql.includes("expedition_project_journal_entries.user_id = auth.uid()"), "OD: journal author does not derive from auth.uid()");
assert.ok(collaborationAccessSql.includes("expedition_project_journal_author_update") && collaborationAccessSql.includes("user_id = auth.uid()"), "OE/OF: journal author-only rewriting missing");
assert.ok(collaborationAccessSql.includes("expedition_project_journal_author_or_owner_delete"), "OG: owner journal moderation missing");
assert.ok(collaborationAccessSql.includes("expedition_project_journal_media_collaboration_select") && collaborationAccessSql.includes("expedition_project_journal_media_editor_insert"), "OH/OI/OJ: collaborator media access missing");
assert.ok(collaborationAccessSql.includes("expedition_media_objects_editor_insert") && collaborationAccessSql.includes("foldername(storage.objects.name))[1] = auth.uid()::text"), "OK/OL: Storage upload is not uploader-bound");
assert.ok(collaborationAccessSql.includes("media.storage_path = storage.objects.name") && collaborationAccessSql.includes("can_view_expedition_project(media.project_id)"), "OM/ON: media SELECT is not exact-project scoped");
assert.ok(collaborationAccessSql.includes("expedition_project_day_tracks_activity_owner_fk") || dayTracksSql.includes("expedition_project_day_tracks_activity_owner_fk"), "OO: editor track link lost activity ownership FK");
assert.ok(collaborationAccessSql.includes("a.user_id = auth.uid()") && collaborationAccessSql.includes("gps_activities_linked_project_select"), "OP/OQ: own-link or linked-evidence boundary missing");
assert.ok(collaborationAccessSql.includes("activity.geojson_url = storage.objects.name"), "OR: linked geometry is not relation-aware");
assert.ok(projectQueries.includes('.eq("user_id", userId)') && projectQueries.includes("listOwnedProjectTrackOptions"), "OS: picker enumerates collaborator tracks");
assert.ok(trackEvidenceSource.includes("importGpxActivity") && trackEvidenceSource.includes("editable"), "OT: editor GPX importer or viewer guard missing");
assert.ok(projectMutations.includes('rpc("unlink_expedition_project_day_track"') && !projectMutations.includes("delete().eq(\"id\", input.gpsActivityId)"), "OU: unlink deletes underlying account activity");
assert.equal(collaborationAccessSql.includes("references public.expedition_project_members") || collaborationAccessSql.includes("delete from public.expedition_project_journal_entries where user_id"), false, "OV: membership removal cascades contributed content");
assert.ok(collaborationAccessSql.includes("p.status <> 'archived'") && collaborationAccessSql.includes("current_status = 'archived'"), "OW: archived editor writes are not rejected");
assert.equal(canChangeLifecycle("editor", "completed"), true, "OX: completed editor contribution lifecycle changed");
assert.ok(routeLayout.includes("robots: { index: false, follow: false }"), "OY: private report indexing changed");
assert.equal(collaborationAccessSql.includes("resolve_public_expedition_share") || projectSharesSql.includes("expedition_project_members"), false, "OZ: Phase 10 and member authorization coupled");
assert.equal(collaborationAccessSql.includes("to anon"), false, "PA: anonymous collaboration access introduced");
assert.equal((projectDetailPage + trackEvidenceSource + journalSource).includes("service_role"), false, "PB: service role reached client code");
assert.ok(projectQueries.includes("getAccessibleProject") && !projectQueries.includes("for (const member"), "PC: project graph or author lookup is N+1");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "PD: Phase 11B locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "PE: Phase 11B catalog contains mojibake");

// Phase 11B recursion repair PF-PU: project policies may inspect membership,
// but membership/invitation owner resolution must cross a proven definer
// boundary rather than querying the project table through RLS again.
const memberSelectPolicy = collaborationSql.split("create policy expedition_project_members_scoped_select")[1]?.split("drop policy if exists expedition_project_invitations_scoped_select")[0] ?? "";
const invitationSelectPolicy = collaborationSql.split("create policy expedition_project_invitations_scoped_select")[1]?.split("revoke all on public.expedition_project_members")[0] ?? "";
const ownerHelper = collaborationSql.split("create or replace function public.is_expedition_project_owner")[1]?.split("$function$;")[0] ?? "";
assert.equal(memberSelectPolicy.includes("from public.expedition_projects"), false, "PF: member SELECT policy directly re-enters project RLS");
assert.equal(invitationSelectPolicy.includes("from public.expedition_projects"), false, "PG: invitation SELECT policy directly re-enters project RLS");
assert.ok(memberSelectPolicy.includes("public.is_expedition_project_owner(expedition_project_members.project_id)"), "PH: member owner check does not use the recursion boundary");
assert.ok(invitationSelectPolicy.includes("public.is_expedition_project_owner(expedition_project_invitations.project_id)"), "PI: invitation owner check does not use the recursion boundary");
assert.ok(ownerHelper.includes("security definer") && ownerHelper.includes("set search_path = ''"), "PJ/PK: owner helper lacks definer hardening");
assert.ok(ownerHelper.includes("auth.uid()") && ownerHelper.includes("public.expedition_projects p") && !ownerHelper.includes("requested_user"), "PL: owner helper identity contract is unsafe");
for (const signature of ["is_expedition_project_owner(uuid)", "can_view_expedition_project(uuid)", "can_edit_expedition_project(uuid)", "get_expedition_project_access_role(uuid)"]) assert.ok((collaborationSql + collaborationAccessSql).includes(`alter function public.${signature} owner to postgres`), `PM: ${signature} owner is not explicit`);
assert.ok(collaborationAccessSql.includes("expedition_projects_collaborator_select") && collaborationAccessSql.includes("from public.expedition_project_members m"), "PN: project member SELECT semantics changed");
assert.ok(collaborationAccessSql.includes("public.is_expedition_project_owner(requested_project_id)") && collaborationAccessSql.includes("m.role = 'editor'"), "PO: view/edit role semantics changed");
assert.ok(collaborationRecursionRepairSql.startsWith("-- phase 11b") && collaborationRecursionRepairSql.includes("begin;") && collaborationRecursionRepairSql.trimEnd().endsWith("commit;"), "PP: incremental repair is not transactional");
assert.ok(collaborationRecursionRepairSql.includes("rolbypassrls") && collaborationRecursionRepairSql.includes("relforcerowsecurity") && collaborationRecursionRepairSql.includes("relowner"), "PQ: deployed ownership/RLS preflight missing");
assert.ok(collaborationRecursionRepairSql.includes("owner to postgres") && !collaborationRecursionRepairSql.includes("owner to supabase_admin"), "PR: repair uses an unapproved function owner");
assert.equal(collaborationRecursionRepairSql.includes("disable row level security") || collaborationRecursionRepairSql.includes("using (true)"), false, "PS: repair weakens RLS");
for (const selfComparison of ["expedition_project_members.project_id = expedition_project_members.project_id", "expedition_project_invitations.project_id = expedition_project_invitations.project_id"]) assert.equal((collaborationSql + collaborationRecursionRepairSql).includes(selfComparison), false, `PT: ambiguous self-comparison introduced: ${selfComparison}`);
assert.equal(collaborationRecursionRepairSql.includes("expedition_project_shares") || collaborationRecursionRepairSql.includes("resolve_public_expedition_share"), false, "PU: recursion repair touched Phase 10 sharing");

// Phase 11B recursion repair #2 PV-QI: gps_activities may inspect linked day
// tracks, so the canonical day-track SELECT path must terminate at the verified
// can_view_expedition_project SECURITY DEFINER boundary and never query GPS.
const canonicalDayTrackSelectPolicy = collaborationAccessSql.split("create policy expedition_project_day_tracks_collaboration_select")[1]?.split("drop policy if exists expedition_project_day_tracks_editor_insert")[0] ?? "";
const linkedGpsSelectPolicy = collaborationAccessSql.split("create policy gps_activities_linked_project_select")[1]?.split("drop policy if exists activity_tracks_linked_project_select")[0] ?? "";
assert.equal(dayTracksSql.includes("create policy expedition_project_day_tracks_select_owned"), false, "PV: base schema recreates the obsolete recursive day-track SELECT policy");
assert.ok(canonicalDayTrackSelectPolicy.includes("for select to authenticated") && canonicalDayTrackSelectPolicy.includes("public.can_view_expedition_project(expedition_project_day_tracks.project_id)"), "PW/PX: canonical day-track collaboration SELECT path is missing or non-terminating");
assert.equal(canonicalDayTrackSelectPolicy.includes("public.gps_activities"), false, "PY: canonical day-track SELECT policy directly re-enters gps_activities RLS");
assert.ok(linkedGpsSelectPolicy.includes("public.expedition_project_day_tracks relation") && linkedGpsSelectPolicy.includes("public.can_view_expedition_project(relation.project_id)"), "PZ/QA: linked GPS evidence authorization contract changed");
assert.ok(dayTracksGpsRecursionRepairSql.startsWith("-- phase 11b") && dayTracksGpsRecursionRepairSql.includes("begin;") && dayTracksGpsRecursionRepairSql.trimEnd().endsWith("commit;"), "QB: GPS recursion repair is not transactional");
assert.ok(dayTracksGpsRecursionRepairSql.includes("drop policy if exists expedition_project_day_tracks_select_owned") && dayTracksGpsRecursionRepairSql.includes("on public.expedition_project_day_tracks"), "QC: GPS recursion repair does not remove the proven recursive policy");
assert.equal(dayTracksGpsRecursionRepairSql.includes("create policy expedition_project_day_tracks_select_owned") || dayTracksGpsRecursionRepairSql.includes("from public.gps_activities"), false, "QD: GPS recursion repair recreates a day-track to GPS policy edge");
assert.ok(dayTracksGpsRecursionRepairSql.includes("expedition_project_day_tracks_collaboration_select") && dayTracksGpsRecursionRepairSql.includes("can_view_expedition_project"), "QE: repair preflight does not preserve the terminating collaboration policy");
assert.ok(dayTracksGpsRecursionRepairSql.includes("gps_activities_linked_project_select"), "QF: repair preflight does not preserve linked GPS evidence authorization");
assert.equal(dayTracksGpsRecursionRepairSql.includes("disable row level security") || dayTracksGpsRecursionRepairSql.includes("using (true)"), false, "QG: GPS recursion repair weakens RLS");
assert.equal(/drop policy(?: if exists)? expedition_project_day_tracks_collaboration_select|drop policy(?: if exists)? gps_activities_linked_project_select/.test(dayTracksGpsRecursionRepairSql), false, "QH: GPS recursion repair drops collaboration authorization");
assert.equal(dayTracksGpsRecursionRepairSql.includes("expedition_project_shares") || dayTracksGpsRecursionRepairSql.includes("resolve_public_expedition_share") || dayTracksGpsRecursionRepairSql.includes("public-expeditions"), false, "QI: GPS recursion repair touched Phase 10 sharing");

// Phase 11C QJ-RN: immutable, private, bounded activity history is written only
// by trusted mutation functions/triggers and remains absent from Phase 10.
const activitySource = await readFile(new URL("../Lib/projects/activity.ts", import.meta.url), "utf8");
const activityUi = await readFile(new URL("../components/projects/ProjectActivity.tsx", import.meta.url), "utf8");
assert.ok(activitySql.includes("create table public.expedition_project_activity") && activitySql.includes("project_id uuid not null references public.expedition_projects(id) on delete cascade"), "QJ/QK: activity table or project cascade missing");
assert.ok(activitySql.includes("actor_user_id uuid not null") && !/actor_user_id uuid[^\n]*references/.test(activitySql), "QL: actor history does not survive account removal");
assert.ok(activitySql.includes("check (action_type in") && activitySql.includes("check (resource_type in"), "QM/QN: activity vocabularies are not finite");
for (const action of ["project.status_changed","project.archived","project.restored","mountain.added","mountain.removed","mountain.assigned_to_day","mountain.unassigned_from_day","day.created","day.updated","day.deleted","day.reordered","journal.created","journal.updated","journal.deleted","media.photo_uploaded","media.video_uploaded","media.deleted","track.linked","track.imported_and_linked","track.unlinked","member.joined","member.role_changed","member.removed","member.left","sharing.enabled","sharing.disabled"]) assert.ok(activitySql.includes(`'${action}'`), `QO: missing activity action ${action}`);
for (const resource of ["project","mountain","day","journal","media","track","member","sharing"]) assert.ok(activitySql.includes(`'${resource}'`), `QP: missing activity resource ${resource}`);
assert.ok(activitySql.includes("metadata jsonb not null default '{}'::jsonb") && activitySql.includes("octet_length(metadata::text) <= 1024"), "QQ: activity metadata is not bounded");
assert.ok(activitySql.includes("requested_metadata ?| array['body','title','notes','description','storage_path','filename','email','token','slug','geometry','geojson','gpx']"), "QR: private metadata denylist missing");
assert.equal(activitySql.includes("to_jsonb(new)") || activitySql.includes("row_to_json") || activitySql.includes("original_filename") || activitySql.includes("geojson_url"), false, "QS: activity logging serializes private rows or paths");
assert.ok(activitySql.includes("alter table public.expedition_project_activity enable row level security") && activitySql.includes("expedition_project_activity_collaboration_select") && activitySql.includes("can_view_expedition_project(expedition_project_activity.project_id)"), "QT/QU: private terminating activity SELECT policy missing");
assert.ok(activitySql.includes("revoke all on public.expedition_project_activity from public, anon, authenticated") && activitySql.includes("grant select on public.expedition_project_activity to authenticated"), "QV: append-only table grants changed");
assert.equal(/grant (insert|update|delete)[^;]*expedition_project_activity/.test(activitySql), false, "QW: authenticated activity writes are possible");
assert.ok(activitySql.includes("declare actor uuid := auth.uid()") && !activitySql.includes("requested_actor"), "QX: activity actor is client supplied");
assert.ok(activitySql.includes("revoke all on function public.record_expedition_project_activity") && activitySql.includes("from public, anon, authenticated"), "QY: generic activity fabrication helper is executable");
assert.equal(activitySql.includes("grant execute on function public.record_expedition_project_activity"), false, "QZ: generic activity helper was exposed");
for (const table of ["expedition_projects","expedition_project_mountains","expedition_project_days","expedition_project_day_mountains","expedition_project_journal_entries","expedition_project_journal_media","expedition_project_day_tracks","expedition_project_members","expedition_project_shares"]) assert.ok(activitySql.includes(`on public.${table}`), `RA: missing atomic activity trigger for ${table}`);
assert.ok(activitySql.includes("set_expedition_project_status") || activitySql.includes("capture_expedition_project_status_activity"), "RB: lifecycle changes are not logged atomically");
assert.ok(activitySql.includes("set_config('app.expedition_skip_day_update_activity','on',true)") && activitySql.includes("jsonb_build_object('daycount',actual_count)"), "RC: reorder logging is not one atomic event");
assert.ok(projectMutations.includes("link_imported_expedition_project_day_track") && activitySql.includes("app.expedition_imported_track_link"), "RD: imported GPX links are not distinguished safely");
assert.ok(activitySql.includes("member.left") && activitySql.includes("auth.uid()=old.user_id"), "RE: member leave/removal actor semantics missing");
assert.ok(activitySql.includes("sharing.enabled") && activitySql.includes("sharing.disabled") && !activitySql.includes("public_slug"), "RF: sharing log leaks a slug or lacks actions");
assert.ok(activitySource.includes("PROJECT_ACTIVITY_PAGE_SIZE = 12") && activitySource.includes("boundedLimit + 1") && activitySource.includes('.order("created_at"') && activitySource.includes('.order("id"'), "RG: activity pagination is unbounded or nondeterministic");
assert.ok(activitySource.includes('.from("profiles").select("id,username,display_name,avatar_url").in('), "RH: actor profiles are not batch resolved safely");
assert.equal(projectQueries.includes("expedition_project_activity"), false, "RI: unbounded activity was embedded in the project graph");
assert.ok(projectDetailPage.includes("listProjectActivity") && projectDetailPage.includes("<ProjectActivity"), "RJ: private project activity UI is not wired");
assert.ok(activityUi.includes("<ol") && activityUi.includes("<li") && activityUi.includes("<time") && activityUi.includes('type="button"'), "RK: activity timeline semantics or Show more button missing");
assert.equal((publicReportSource + publicPageSource + publicMediaSource + projectSharesSql).includes("expedition_project_activity"), false, "RL: Phase 10 exposes private activity");
assert.equal(activitySql.includes("to anon") || activitySql.includes("using (true)"), false, "RM: activity grants public access");
for (const catalog of catalogs) assert.deepEqual(catalogShape(catalog), expectedShape, "RN: Phase 11C locale shapes differ");
for (const catalog of catalogs) assert.equal(translatedStrings(catalog).some((value) => mojibakePattern.test(value)), false, "RN: Phase 11C catalog contains mojibake");

console.log("Expedition Projects Phase 1 database/domain contract validation passed.");
console.log("Cases A-O passed, including six-locale shape and private Phase 2 route contracts.");
console.log("Cases P-AF passed, including mutation, validation, localization, and scope contracts.");
console.log("Cases AG-AT passed, including shared picker, auth, duplicate, map, and detail contracts.");
console.log("Cases AU-BH passed, including deduplicated exact-date weather and server presentation contracts.");
console.log("Cases BI-CC passed, including private Phase 6A media SQL and unchanged Phase 1-5 UI contracts.");
console.log("Phase 6B BI-CN passed, including media domain, compensation, deletion, and batched private delivery contracts.");
console.log("Phase 6C CO-DH passed, including photo queues, private gallery delivery, lightbox, deletion, and locale parity.");
console.log("Day-first journal DI-DO passed, including scoped creation, nullable project notes, and inherited media association.");
console.log("Diagnostics and locale DP-DU passed, including DEV-only safe stages and mojibake rejection.");
console.log("Display diagnostics DV-DW passed with count/boolean-only payloads.");
console.log("Phase 7A FN-GM passed, including private bounded saved-track linking and lazy day evidence maps.");
console.log("Phase 7B GN-HJ passed, including one shared compensating GPX import transaction.");
console.log("Phase 7C HK-IC passed, including direct day import, retained partial success, and link-only retry.");
console.log("Phase 8 ID-IZ passed, including reversible lifecycle summaries and deduplicated canonical evidence totals.");
console.log("Phase 9 JA-KF passed, including private derived report, batched media delivery, and browser-print export.");
console.log("Phase 10 KG-LL passed, including revocable server-mediated sharing and sanitized public media delivery.");
console.log("Phase 10.1 LM-MF passed, including lazy canonical thumbnails and narrow per-request media authorization.");
console.log("Phase 11A MG-NK passed, including atomic invitations, owner-managed roles, bounded identity resolution, and Phase 10 isolation.");
console.log("Phase 11B NL-PE passed, including role-aware private access, author ownership, scoped Storage, and linked-track privacy.");
console.log("Phase 11B recursion repair PF-PU passed, including explicit postgres ownership and an acyclic project/member policy graph.");
console.log("Phase 11B recursion repair #2 PV-QI passed, including an acyclic GPS/day-track policy graph and Phase 10 isolation.");
console.log("Phase 11C QJ-RN passed, including immutable activity, atomic coverage, bounded UI queries, and Phase 10 isolation.");
const notificationSql = (await readFile(new URL("../database/expedition_project_notifications.sql", import.meta.url), "utf8")).toLowerCase();
const notificationSource = await readFile(new URL("../Lib/projects/notifications.ts", import.meta.url), "utf8");
const notificationUi = await readFile(new URL("../components/projects/ProjectNotifications.tsx", import.meta.url), "utf8");
for (const invariant of ["recipient_user_id = auth.uid()","grant select on public.expedition_project_notifications","mark_expedition_project_notification_read","mark_all_expedition_project_notifications_read","after insert on public.expedition_project_activity","on conflict do nothing","totalunreadprojectnotifications"]) assert.ok(notificationSql.includes(invariant), `Phase 11D missing invariant: ${invariant}`);
assert.equal(notificationSql.includes("grant update on public.expedition_project_notifications"), false, "Phase 11D exposes arbitrary notification updates");
assert.equal(notificationSql.includes(" to anon"), false, "Phase 11D exposes notifications anonymously");
assert.ok(notificationSource.includes("PROJECT_NOTIFICATION_PAGE_SIZE = 20") && notificationSource.includes("bounded+1") && notificationSource.includes('.order("created_at"') && notificationSource.includes('.order("id"'), "Phase 11D pagination is unbounded or unstable");
assert.ok(notificationSource.includes('.from("profiles").select("id,username,display_name")') && notificationSource.includes('.from("expedition_projects").select("id")'), "Phase 11D does not batch profiles/access checks");
assert.ok(notificationSource.includes("PROJECT_NOTIFICATION_TRANSLATION_KEYS") && notificationSource.includes("satisfies Record<ProjectNotificationType, string>"), "Phase 11D notification translation mapping is not exhaustive");
assert.ok(notificationUi.includes("mark_expedition_project_notification_read") && notificationUi.includes("mark_all_expedition_project_notifications_read") && notificationUi.includes("<ol") && notificationUi.includes("<time"), "Phase 11D inbox/read semantics are incomplete");
assert.ok(notificationUi.includes("PROJECT_NOTIFICATION_TRANSLATION_KEYS[item.type]") && !notificationUi.includes("types.${item.type}"), "Phase 11D passes an untrusted domain type to next-intl");
const notificationCatalogs = await Promise.all(localeNames.map(async (locale) =>
  JSON.parse(await readFile(new URL(`../messages/${locale}/notifications.json`, import.meta.url), "utf8")),
));
const notificationShape = catalogShape(notificationCatalogs[0]);
for (const catalog of notificationCatalogs) assert.deepEqual(catalogShape(catalog), notificationShape, "Phase 11D locale shapes differ");
function assertMessageKeysHaveNoDots(value, path = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = [...path, key];
    assert.equal(key.includes("."), false, `Invalid next-intl message key: ${keyPath.join(" > ")}`);
    assertMessageKeysHaveNoDots(child, keyPath);
  }
}
for (const locale of localeNames) {
  const catalogFiles = (await readdir(new URL(`../messages/${locale}/`, import.meta.url))).filter((file) => file.endsWith(".json"));
  for (const file of catalogFiles) {
    const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}/${file}`, import.meta.url), "utf8"));
    assertMessageKeysHaveNoDots(catalog, [locale, file]);
  }
}
console.log("Phase 11D RO-SD passed, including recipient-only durable notifications, transactional fan-out, bounded inbox, read RPCs, and locale parity.");
const conflictSql = (await readFile(new URL("../database/expedition_project_conflict_safety.sql", import.meta.url), "utf8")).toLowerCase();
const conflictUi = await readFile(new URL("../components/projects/ProjectConflictNotice.tsx", import.meta.url), "utf8");
for (const invariant of ["updated_at=expected_updated_at","reorder_expedition_project_days_if_current","expected_updated_ats","can_edit_expedition_project","status','conflict","security definer set search_path=''","owner to postgres","revoke all on function public.expedition_mutation_denial(uuid) from public,anon,authenticated"]) assert.ok(conflictSql.includes(invariant), `Phase 11E missing invariant: ${invariant}`);
assert.ok(mutationSource.includes("expectedUpdatedAt: string") && mutationSource.includes("expected_day_ids") && mutationSource.includes("expected_updated_ats"), "Phase 11E client does not carry concurrency tokens");
assert.ok(conflictUi.includes('role="status"') && conflictUi.includes("tabIndex={-1}") && conflictUi.includes("reloadLatest"), "Phase 11E conflict notice lacks accessible recovery");
assert.ok((await readFile(new URL("../components/projects/ProjectJournalEditor.tsx", import.meta.url), "utf8")).includes("expectedUpdatedAt: entry.updatedAt"), "Phase 11E journal does not preserve a version token");
assert.ok((await readFile(new URL("../components/projects/ProjectDayEditor.tsx", import.meta.url), "utf8")).includes("expectedUpdatedAt: day.updatedAt"), "Phase 11E day does not preserve a version token");
console.log("Phase 11E SE-TB passed, including row CAS, reorder fingerprints, structured conflicts, preserved drafts, and safe definer grants.");
const discoverySql=(await readFile(new URL("../database/public_expedition_discovery.sql",import.meta.url),"utf8")).toLowerCase();
const discoverySource=await readFile(new URL("../Lib/projects/discovery.ts",import.meta.url),"utf8");
const explorePage=await readFile(new URL("../app/[locale]/explore/page.tsx",import.meta.url),"utf8");
for(const invariant of ["search_public_expeditions","s.is_enabled=true","p.status in ('completed','archived')","security definer set search_path=''","owner to postgres","limit least(greatest","count(distinct dt.gps_activity_id)","grant execute on function public.search_public_expeditions"]) assert.ok(discoverySql.includes(invariant),`Phase 12 missing discovery invariant: ${invariant}`);
for(const forbidden of ["grant select on public.expedition_projects to anon","storage_path","geojson_url","user_id text","activity_id bigint","expedition_project_activity","expedition_project_notifications","expedition_project_members"]) assert.equal(discoverySql.includes(forbidden),false,`Phase 12 discovery leaks private contract: ${forbidden}`);
assert.ok(discoverySql.includes("c.name ilike")&&discoverySql.includes("unnest(c.mountain_names)")&&discoverySql.includes("order by f.sort_value desc,f.public_slug desc"),"Phase 12 search or deterministic order missing");
assert.ok(discoverySource.includes("slice(0,80)")&&discoverySource.includes("PUBLIC_EXPEDITION_PAGE_SIZE=20")&&discoverySource.includes("PUBLIC_EXPEDITION_PAGE_SIZE+1"),"Phase 12 URL validation or bounds missing");
assert.ok(explorePage.includes("createClient()")&&!explorePage.includes("createAdminClient")&&explorePage.includes('method="get"')&&explorePage.includes('href={`/expeditions/${card.slug}`}'),"Phase 12 anonymous server route boundary missing");
assert.equal(explorePage.includes("loadPublicExpeditionReport"),false,"Phase 12 performs a full report query per card");
assert.ok(explorePage.includes("placeholderImage")&&!explorePage.includes("storage_path"),"Phase 12 placeholder/media privacy contract missing");
const exploreCatalogs=await Promise.all(localeNames.map(async(locale)=>JSON.parse(await readFile(new URL(`../messages/${locale}/explore.json`,import.meta.url),"utf8"))));
const exploreShape=catalogShape(exploreCatalogs[0]);for(const catalog of exploreCatalogs)assert.deepEqual(catalogShape(catalog),exploreShape,"Phase 12 locale shapes differ");
console.log("Phase 12 TC-UC passed, including enabled-share discovery, compact bounded search, deterministic cursors, privacy isolation, and locale parity.");
console.log("mountains.id PostgreSQL type contract confirmed as bigint (int8).");
