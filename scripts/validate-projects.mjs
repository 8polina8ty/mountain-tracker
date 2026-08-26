import { readFile, unlink, writeFile } from "node:fs/promises";

// Phase 9 legacy adapter.
//
// The historical project validator still contains valuable SQL/domain regression
// coverage, but some source-string assertions predate the ProjectDetailView
// decomposition and bounded workspace loader. Keep the historical suite intact
// while translating only those stale presentation assertions at execution time.
// Production code must not carry test-only compatibility markers.

const legacyUrl = new URL("./validate-projects-legacy.mjs", import.meta.url);
const runtimeUrl = new URL(
  `./.validate-projects-runtime-${process.pid}-${Date.now()}.mjs`,
  import.meta.url,
);

let source = await readFile(legacyUrl, "utf8");

function replaceExact(search, replacement, expectedCount = 1) {
  const actualCount = source.split(search).length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(
      `Legacy validator migration drift: expected ${expectedCount} occurrence(s), found ${actualCount}: ${search}`,
    );
  }
  source = source.replaceAll(search, replacement);
}

replaceExact(
  'const detailPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");',
  'const detailPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");\nconst detailView = await readFile(new URL("../components/projects/ProjectDetailView.tsx", import.meta.url), "utf8");',
);
replaceExact(
  'assert.ok(detailPage.includes("getAccessibleProject(supabase, projectId)"));',
  'assert.ok(detailPage.includes("getAccessibleProjectWorkspace(supabase, projectId)"));',
);
replaceExact(
  'assert.ok(detailPage.includes("if (!project) notFound()"));',
  'assert.ok(detailPage.includes("if (!workspace) notFound()"));\nassert.ok(detailPage.includes("<ProjectDetailView"), "detail route must delegate presentation to ProjectDetailView");',
);
replaceExact(
  '(detailPage + statusControl + mountainActions + dayEditor + journal)',
  '(detailPage + detailView + statusControl + mountainActions + dayEditor + journal)',
  2,
);
replaceExact(
  'const projectPresentation = detailPage + projectDayWeather + projectWeatherSummary;',
  'const projectPresentation = detailPage + detailView + projectDayWeather + projectWeatherSummary;',
);
replaceExact(
  `assert.equal(detailPage.includes('"use client"'), false, "BF: project detail must remain a Server Component");`,
  `assert.equal(detailPage.includes('"use client"'), false, "BF: project detail route must remain a Server Component");\nassert.equal(detailView.includes('"use client"'), false, "BF: ProjectDetailView must remain server-rendered");`,
);
replaceExact(
  'assert.ok(detailPage.includes(mutationComponent), `BG: ${mutationComponent} must remain wired`);',
  'assert.ok(detailView.includes(mutationComponent), `BG: ${mutationComponent} must remain wired in ProjectDetailView`);',
);
replaceExact(
  'assert.ok(detailPage.includes("entry.projectDayId === day.id") && detailPage.includes("projectDayId={day.id}"), "DI: each day must render and create only its own journal entries");',
  'assert.ok(detailView.includes("entry.projectDayId === day.id") && detailView.includes("projectDayId={day.id}"), "DI: each day must render and create only its own journal entries");',
);
replaceExact(
  'assert.ok(detailPage.includes("entry.projectDayId === null") && detailPage.includes("projectJournalEntries"), "DJ: nullable entries must remain available as secondary project notes");',
  'assert.ok(detailView.includes("entry.projectDayId === null") && detailView.includes("projectJournalEntries"), "DJ: nullable entries must remain available as secondary project notes");',
);
replaceExact(
  'assert.ok(dayEditor.includes("journalContent") && detailPage.includes("dayJournalTitle"), "DM: journal timeline must be composed inside the day card");',
  'assert.ok(dayEditor.includes("journalContent") && detailView.includes("dayJournalTitle"), "DM: journal timeline must be composed inside the day card");',
);
replaceExact(
  'journal.includes("buildDayJournalPresentation(entries, deliveries)")',
  'journal.includes("buildDayJournalPresentation(loadedEntries, loadedDeliveries)")',
);
replaceExact("detailPage.includes('key={`", "detailView.includes('key={`", 2);
replaceExact(
  'assert.ok(projectDetailPage.includes("track.projectDayId === day.id"), "GG: day isolation missing");',
  'assert.ok(detailView.includes("track.projectDayId === day.id"), "GG: day isolation missing");',
);
replaceExact(
  `assert.equal(projectDetailPage.includes('status === "completed"') && projectDetailPage.includes("ProjectDayEditor"), true, "IR: completed projects must remain editable");`,
  `assert.equal(detailView.includes('projectWithEvidence.status === "completed"') && detailView.includes("ProjectDayEditor"), true, "IR: completed projects must remain editable");`,
);
replaceExact(
  '(projectDetailPage + projectsListSource).includes("getPublicUrl")',
  '(projectDetailPage + detailView + projectsListSource).includes("getPublicUrl")',
);
replaceExact(
  'assert.ok(projectDetailPage.includes("buildProjectCompletionSummary(project)"), "IW: report must derive from loaded project without N+1");',
  'assert.ok(detailView.includes("buildProjectCompletionSummary(projectWithEvidence)"), "IW: report must derive from the loaded project without N+1");',
);
replaceExact(
  `assert.ok(projectDetailPage.includes("ProjectSharingControl") && projectDetailPage.includes('status === "completed" || project.status === "archived"'), "KZ: owner sharing controls lack lifecycle boundary");`,
  `assert.ok(detailView.includes("ProjectSharingControl") && detailView.includes('projectWithEvidence.status === "completed" || projectWithEvidence.status === "archived"'), "KZ: owner sharing controls lack lifecycle boundary");`,
);
replaceExact(
  '(projectDetailPage + trackEvidenceSource + journalSource).includes("service_role")',
  '(projectDetailPage + detailView + trackEvidenceSource + journalSource).includes("service_role")',
);
replaceExact(
  'assert.ok(projectDetailPage.includes("listProjectActivity") && projectDetailPage.includes("<ProjectActivity"), "RJ: private project activity UI is not wired");',
  'assert.ok(projectDetailPage.includes("listProjectActivity") && detailView.includes("<ProjectActivity"), "RJ: private project activity UI is not wired");',
);
replaceExact(
  'const projectsListSource = await readFile(new URL("../app/[locale]/projects/page.tsx", import.meta.url), "utf8");',
  'const projectsListSource = await readFile(new URL("../app/[locale]/projects/page.tsx", import.meta.url), "utf8");\nconst projectsListPresentation = await readFile(new URL("../components/projects/ProjectsClient.tsx", import.meta.url), "utf8");',
);
replaceExact(
  'assert.ok(projectsListSource.includes("lifecycleOrder") && projectsListSource.includes(\'data-lifecycle-group\'), "Phase 8: project list lifecycle ordering missing");',
  'assert.ok(projectsListSource.includes("lifecycleOrder") && projectsListPresentation.includes(\'data-lifecycle-group\'), "Phase 8: project list lifecycle ordering missing");',
);
replaceExact(
  'const explorePage=await readFile(new URL("../app/[locale]/explore/page.tsx",import.meta.url),"utf8");',
  'const explorePage=await readFile(new URL("../app/[locale]/explore/page.tsx",import.meta.url),"utf8");\nconst explorePresentation=await readFile(new URL("../components/explore/ExploreClient.tsx",import.meta.url),"utf8");',
);
replaceExact(
  'assert.ok(explorePage.includes("createClient()")&&!explorePage.includes("createAdminClient")&&explorePage.includes(\'method="get"\')&&explorePage.includes(\'href={`/expeditions/${card.slug}`}\'),"Phase 12 anonymous server route boundary missing");',
  'assert.ok(explorePage.includes("createClient()")&&!explorePage.includes("createAdminClient")&&explorePage.includes("parsePublicExpeditionSearch")&&explorePage.includes("searchPublicExpeditions"),"Phase 12 anonymous server route boundary missing");\nassert.ok(explorePresentation.includes(\'method="get"\')&&["q","year","minDistance","maxDistance","evidence","status","sort"].every((name)=>explorePresentation.includes(`name="${name}"`))&&explorePresentation.includes(\'href={`/expeditions/${card.slug}`}\'),"Phase 12 Explore GET presentation contract missing");',
);
replaceExact(
  'assert.ok(explorePage.includes("placeholderImage")&&!explorePage.includes("storage_path"),"Phase 12 placeholder/media privacy contract missing");',
  'assert.ok(explorePresentation.includes("placeholderImage")&&!(explorePage+explorePresentation).includes("storage_path"),"Phase 12 placeholder/media privacy contract missing");',
);

const projectsClientSource = await readFile(
  new URL("../components/projects/ProjectsClient.tsx", import.meta.url),
  "utf8",
);
const sharedProjectsSource = await readFile(
  new URL("../components/projects/SharedProjects.tsx", import.meta.url),
  "utf8",
);
const projectInvitationsSource = await readFile(
  new URL("../components/projects/ProjectInvitations.tsx", import.meta.url),
  "utf8",
);

function staticTranslationKeys(componentSource, functionName, namespace = "") {
  const pattern = new RegExp(`\\b${functionName}\\(\\s*["']([^"']+)["']`, "g");
  return [...componentSource.matchAll(pattern)].map((match) =>
    namespace ? `${namespace}.${match[1]}` : match[1],
  );
}

const referencedProjectsKeys = new Set([
  ...staticTranslationKeys(projectsClientSource, "t"),
  ...staticTranslationKeys(sharedProjectsSource, "t", "Team"),
  ...staticTranslationKeys(sharedProjectsSource, "shared", "TeamShared"),
  ...staticTranslationKeys(sharedProjectsSource, "status", "Status"),
  ...staticTranslationKeys(projectInvitationsSource, "t", "Team"),
  ...["planning", "ready", "active", "completed", "archived"].map((key) => `Status.${key}`),
  ...["owner", "editor", "viewer"].map((key) => `Team.${key}`),
]);

for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
  const catalog = JSON.parse(
    await readFile(new URL(`../messages/${locale}/projects.json`, import.meta.url), "utf8"),
  ).Projects;
  const missingKeys = [...referencedProjectsKeys].filter((key) =>
    key.split(".").reduce((value, segment) => value?.[segment], catalog) === undefined,
  );
  if (missingKeys.length > 0) {
    throw new Error(
      `Projects translation references missing for ${locale}: ${missingKeys.join(", ")}`,
    );
  }
}

const currentPage = await readFile(
  new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url),
  "utf8",
);
if (currentPage.includes("Legacy validate-projects presentation markers")) {
  throw new Error("Project detail route still contains legacy validator compatibility markers.");
}
if (!currentPage.includes("<ProjectDetailView")) {
  throw new Error("Project detail route no longer delegates to ProjectDetailView.");
}

await writeFile(runtimeUrl, source, "utf8");
try {
  await import(`${runtimeUrl.href}?run=${Date.now()}`);
} finally {
  await unlink(runtimeUrl).catch(() => undefined);
}
