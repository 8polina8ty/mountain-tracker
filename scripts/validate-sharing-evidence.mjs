import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { canEnableProjectSharing, disableProjectSharing, enableProjectSharing } from "../Lib/projects/sharing.ts";

const sharingSource = await readFile(new URL("../Lib/projects/sharing.ts", import.meta.url), "utf8");
const sharesSql = (await readFile(new URL("../database/expedition_project_shares.sql", import.meta.url), "utf8")).toLowerCase();
const discoverySql = (await readFile(new URL("../database/public_expedition_discovery.sql", import.meta.url), "utf8")).toLowerCase();
const detailView = await readFile(new URL("../components/projects/ProjectDetailView.tsx", import.meta.url), "utf8");
const sharingControl = await readFile(new URL("../components/projects/ProjectSharingControl.tsx", import.meta.url), "utf8");

const detailPage = await readFile(new URL("../app/[locale]/projects/[projectId]/page.tsx", import.meta.url), "utf8");
const publicPage = await readFile(new URL("../app/[locale]/expeditions/[slug]/page.tsx", import.meta.url), "utf8");
const sqlBlock = (start) => sharesSql.split(start)[1]?.split("$function$;")[0] ?? "";
const eligible = sqlBlock("create or replace function expedition_sharing_private.is_eligible");
const mutation = sqlBlock("create or replace function public.set_expedition_sharing");
assert.match(eligible, /select exists[\s\S]*dt\.user_id = p\.user_id[\s\S]*ga\.user_id = dt\.user_id[\s\S]*p\.status in \('completed', 'archived'\) and ga\.processing_status = 'ready'/);
assert.doesNotMatch(eligible, /\blimit\b/);
assert.doesNotMatch(sharingSource, /\blimit\(|expedition_project_day_tracks/i);
assert.match(sharesSql, /create policy expedition_project_shares_update_owned[^;]+using \(user_id = auth\.uid\(\)\) with check \([^;]+case when is_enabled then expedition_sharing_private\.is_eligible\(project_id, user_id\) else true end/);
assert.match(mutation, /security invoker[\s\S]*p\.id = target_project_id and p\.user_id = actor[\s\S]*errcode = '42501'/);
assert.match(mutation, /set is_enabled = false[^;]+s\.project_id = target_project_id and s\.user_id = actor and s\.is_enabled[^;]+returning[\s\S]*if not found and exists/);
assert.match(sqlBlock("create or replace function public.can_enable_expedition_sharing"), /is_eligible\(target_project_id, auth\.uid\(\)\)/);
assert.match(sqlBlock("create or replace function public.resolve_public_expedition_share"), /s\.is_enabled = true\s+and expedition_sharing_private\.is_eligible/);
assert.match(sqlBlock("create or replace function public.get_public_expedition_report"), /from public\.resolve_public_expedition_share\(requested_slug\)/);
assert.match(discoverySql, /s\.is_enabled=true\s+and expedition_sharing_private\.is_eligible\(s\.project_id, s\.user_id\)/);
assert.match(detailPage, /canEnableProjectSharing\(supabase, project\.id\)/);
assert.match(detailView, /canEnable=\{shareEligibility\}/);
assert.match(sharingControl, /const canRevoke = share\?\.enabled === true \|\| shareReadFailed;/);
assert.match(sharingControl, /\{canRevoke \? \([\s\S]*void disable\(\)[\s\S]*: canEnable === true/);
assert.match(publicPage, /dynamic = "force-dynamic"/);

// i18n keys
for (const locale of ["de","en","ru","fr","it","es"]) {
  const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}/projects.json`, import.meta.url), "utf8"));
  assert.ok(typeof catalog.Projects.Sharing.evidenceRequired === "string" && catalog.Projects.Sharing.evidenceRequired.trim().length > 0, `${locale} evidenceRequired missing`);
}

const slug = "A".repeat(32);
const projectId = "00000000-0000-4000-8000-000000000001";

test("owner controls use RPC results and never infer success from an empty response", async () => {
  const supabase = {
    rpc: async (name, args) => {
      assert.equal(args.target_project_id, projectId);
      if (name === "can_enable_expedition_sharing") return { data: true, error: null };
      assert.equal(name, "set_expedition_sharing");
      if (args.enable_sharing) {
        assert.match(args.proposed_slug, /^[A-Za-z0-9_-]{32}$/);
        return { data: { enabled: true, slug }, error: null };
      }
      assert.deepEqual(args, { target_project_id: projectId, enable_sharing: false });
      return { data: { enabled: false }, error: null };
    },
  };
  assert.equal(await canEnableProjectSharing(supabase, projectId), true);
  assert.deepEqual(await enableProjectSharing(supabase, projectId), { ok: true, slug });
  assert.deepEqual(await disableProjectSharing(supabase, projectId), { ok: true });
  const denied = { rpc: async () => ({ data: null, error: { code: "42501" } }) };
  const empty = { rpc: async () => ({ data: null, error: null }) };
  for (const client of [denied, empty]) {
    assert.equal(await canEnableProjectSharing(client, projectId), null);
    assert.deepEqual(await enableProjectSharing(client, projectId), { ok: false });
    assert.deepEqual(await disableProjectSharing(client, projectId), { ok: false });
  }
  assert.equal(await canEnableProjectSharing({ rpc: async () => ({ data: false, error: null }) }, projectId), false);
});

test("revoking a share blocks the public report before private graph loading", async () => {
  const mediaId = "00000000-0000-4000-8000-000000000002";
  const ownerId = "00000000-0000-4000-8000-000000000003";
  const project = {
    status: "completed", mountains: [],
    days: [{ id: "day", dayNumber: 1, mountains: [] }],
    journalEntries: [{ projectDayId: "day", body: "", media: [{ id: mediaId, mediaType: "photo" }] }],
  };
  let mode = "enabled";
  let reads = 0;
  const key = Symbol.for("mountain-tracker-expedition-test");
  globalThis[key] = {
    admin: {
      async rpc(name, args) {
        assert.deepEqual(args, { requested_slug: slug });
        if (mode === "error") return { data: null, error: { code: "fixture-error" } };
        return name === "get_public_expedition_report"
          ? { data: mode === "enabled" ? { name: "Fixture", status: "completed" } : null }
          : { data: mode === "enabled" ? [{ project_id: projectId, owner_id: ownerId }] : [] };
      },
    },
    getUserProject: async () => { reads++; return project; },
    listProjectDayTrackEvidence: async () => [{ projectDayId: "day", activityId: 1, processingStatus: "ready" }],
  };
  const previous = process.env.PUBLIC_EXPEDITION_MEDIA_SECRET;
  process.env.PUBLIC_EXPEDITION_MEDIA_SECRET = "synthetic-expedition-test-only";
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fixture = 'globalThis[Symbol.for("mountain-tracker-expedition-test")]';
      const replacements = {
        "server-only": "export {}",
        "@/Lib/supabase/admin": "export const getSupabaseAdminCredentials = () => ({}); export const createAdminClient = () => " + fixture + ".admin",
        "./queries.ts": "export const { getUserProject, listProjectDayTrackEvidence } = " + fixture,
      };
      if (Object.hasOwn(replacements, specifier)) {
        return { url: "data:text/javascript," + encodeURIComponent(replacements[specifier]), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const { loadPublicExpeditionReport } = await import("../Lib/projects/publicReport.ts");
    const report = await loadPublicExpeditionReport(slug);
    assert.equal(report?.name, "Fixture");
    assert.equal(report.summary.uniqueTrackCount, 1);
    assert.match(report.days[0].journal[0].media[0].handle, /^[A-Za-z0-9_-]{60}$/);
    assert.equal(reads, 1);
    for (const state of ["revoked", "error"]) {
      mode = state;
      assert.equal(await loadPublicExpeditionReport(slug), null);
      assert.equal(reads, 1);
    }
  } finally {
    hook.deregister();
    delete globalThis[key];
    if (previous === undefined) delete process.env.PUBLIC_EXPEDITION_MEDIA_SECRET;
    else process.env.PUBLIC_EXPEDITION_MEDIA_SECRET = previous;
  }
});
