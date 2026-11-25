import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { StorageApiError } from "@supabase/supabase-js";
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
assert.doesNotMatch(sharingSource, /\blimit\(|expedition_project_day_tracks/);
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

test("public media authorizes both variants and only falls back on an unavailable transform", async () => {
  const mediaId = "00000000-0000-4000-8000-000000000002";
  const mediaPath = "fixture/private-photo.jpg";
  const ownerId = "00000000-0000-4000-8000-000000000003";
  let state = "enabled";
  let privateReads = 0;
  let transformError = null;
  let originalError = null;
  let revokeDuringTransform = false;
  let streamDownloads = 0;
  let streamCancelled = false;
  let derivativeReads = 0;
  let revokeDuringDerivative = false;
  const webp = Uint8Array.from(Buffer.from("RIFF0000WEBP"));
  const derivative = {
    object_key: `${mediaId}/v1/00000000-0000-4000-8000-000000000004.webp`,
    object_id: "00000000-0000-4000-8000-000000000005",
    object_version: "00000000-0000-4000-8000-000000000006",
    size_bytes: webp.length,
  };
  let ready = derivative;
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  let storedSize = jpeg.byteLength;
  let fallbackBytes = jpeg;
  const unavailable = new StorageApiError("feature not enabled for this tenant", 403, "403");
  const project = {
    status: "completed",
    mountains: [],
    days: [{ id: "day", dayNumber: 1, mountains: [] }],
    journalEntries: [{ projectDayId: "day", body: "", media: [{ id: mediaId, mediaType: "photo" }] }],
  };
  const admin = {
    rpc: async (name, args) => {
      if (name === "expedition_thumbnail_lookup") {
        assert.deepEqual(args, { p_project_id: projectId, p_media_id: mediaId });
        return { data: ready ? [ready] : [], error: null };
      }
      assert.deepEqual(args, { requested_slug: slug });
      if (state === "error") return { data: null, error: { code: "fixture-error" } };
      if (name === "get_public_expedition_report") {
        return { data: state === "enabled" ? { name: "Fixture", status: "completed" } : null };
      }
      assert.equal(name, "resolve_public_expedition_share");
      return { data: state === "enabled" ? [{ project_id: projectId, owner_id: ownerId }] : [] };
    },
    from(table) {
      privateReads++;
      assert.equal(table, "expedition_project_journal_media");
      const filters = {};
      const query = {
        select: () => query,
        eq: (key, value) => { filters[key] = value; return query; },
        maybeSingle: async () => {
          assert.deepEqual(filters, { id: mediaId, project_id: projectId, media_type: "photo" });
          return { data: { storage_path: mediaPath, mime_type: "image/jpeg", size_bytes: storedSize } };
        },
      };
      return query;
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "expedition-media");
        return { download: (path, options, parameters) => {
          assert.equal(path, mediaPath);
          assert.equal(parameters.cache, "no-store");
          if (options.transform && revokeDuringTransform) state = "revoked";
          const error = options.transform ? transformError : originalError;
          return Object.assign(Promise.resolve({
            data: error ? null : new Blob([options.transform ? "thumbnail" : jpeg], { type: "image/jpeg" }),
            error,
          }), {
            asStream: async () => {
              assert.deepEqual(options, {});
              assert.ok(parameters.signal);
              if (error) return { data: null, error };
              streamDownloads++;
              const stream = new ReadableStream({
                pull(controller) {
                  controller.enqueue(fallbackBytes);
                  if (fallbackBytes.byteLength <= storedSize) controller.close();
                },
                cancel() { streamCancelled = true; },
              });
              return { data: stream, error: null };
            },
          });
        } };
      },
    },
  };
  const fixtureKey = Symbol.for("mountain-tracker-expedition-test");
  globalThis[fixtureKey] = {
    admin,
    getUserProject: async () => { privateReads++; return project; },
    listProjectDayTrackEvidence: async () => [{ projectDayId: "day", activityId: 1, processingStatus: "ready" }],
    readVersionedPhoto: async (_credentials, object) => {
      assert.deepEqual(object, {
        bucket: "expedition-media-thumbnails", path: derivative.object_key, version: derivative.object_version,
        size: webp.length, mime: "image/webp",
      });
      derivativeReads++;
      if (revokeDuringDerivative) state = "revoked";
      return webp;
    },
  };
  const previousSecret = process.env.PUBLIC_EXPEDITION_MEDIA_SECRET;
  const previousDelivery = process.env.EXPEDITION_THUMBNAIL_DELIVERY;
  process.env.PUBLIC_EXPEDITION_MEDIA_SECRET = "synthetic-expedition-test-only";
  delete process.env.EXPEDITION_THUMBNAIL_DELIVERY;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fixture = 'globalThis[Symbol.for("mountain-tracker-expedition-test")]';
      const replacements = {
        "server-only": "export {}",
        "@/Lib/supabase/admin": "export const getSupabaseAdminCredentials = () => ({}); export const createAdminClient = () => " + fixture + ".admin",
        "./queries.ts": "export const { getUserProject, listProjectDayTrackEvidence } = " + fixture,
        "./thumbnailStorage.ts": "export const EXPEDITION_THUMBNAIL_BUCKET = 'expedition-media-thumbnails'; export const { readVersionedPhoto } = " + fixture,
      };
      if (specifier === "@/Lib/projects/publicReport") {
        return { url: new URL("../Lib/projects/publicReport.ts", import.meta.url).href, shortCircuit: true };
      }
      if (Object.hasOwn(replacements, specifier)) {
        return { url: "data:text/javascript," + encodeURIComponent(replacements[specifier]), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const { loadPublicExpeditionReport } = await import("../Lib/projects/publicReport.ts");
    const { GET } = await import("../app/api/public-expeditions/[slug]/media/[handle]/route.ts");
    const report = await loadPublicExpeditionReport(slug);
    assert.equal(report?.name, "Fixture");
    assert.equal(report.summary.uniqueTrackCount, 1);
    const handle = report.days[0].journal[0].media[0].handle;
    const photo = (variant = "original", photoSlug = slug, photoHandle = handle) => GET(
      new Request("https://example.test/photo?variant=" + variant),
      { params: Promise.resolve({ slug: photoSlug, handle: photoHandle }) },
    );
    const active = await photo();
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await active.arrayBuffer()), jpeg);
    const transformed = await photo("thumb");
    assert.equal(transformed.status, 200);
    assert.equal(await transformed.text(), "thumbnail");
    assert.equal(streamDownloads, 1);

    transformError = unavailable;
    const fallback = await photo("thumb");
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("cache-control"), "private, no-store");
    assert.equal(fallback.headers.get("content-type"), "image/jpeg");
    assert.equal(fallback.headers.get("location"), null);
    assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), jpeg);
    assert.equal(streamDownloads, 2);

    transformError = new StorageApiError("Access denied", 403, "403");
    assert.equal((await photo("thumb")).status, 404);
    originalError = unavailable;
    assert.equal((await photo()).status, 404);
    originalError = null;
    transformError = unavailable;
    storedSize = 512 * 1024 + 1;
    assert.equal((await photo("thumb")).status, 404);
    assert.equal(streamDownloads, 2);
    const largeOriginal = new Uint8Array(storedSize);
    largeOriginal.set(jpeg);
    fallbackBytes = largeOriginal;
    const large = await photo();
    assert.equal(large.status, 200);
    assert.equal((await large.arrayBuffer()).byteLength, largeOriginal.length);
    storedSize = jpeg.byteLength;
    fallbackBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9, 0);
    assert.equal((await photo("thumb")).status, 404);
    assert.equal(streamCancelled, true);
    fallbackBytes = Uint8Array.of(0x3c, 0x68, 0x31, 0x3e);
    assert.equal((await photo("thumb")).status, 404);
    assert.equal(streamDownloads, 5);
    fallbackBytes = jpeg;
    revokeDuringTransform = true;
    assert.equal((await photo("thumb")).status, 404);
    assert.equal(streamDownloads, 5);
    revokeDuringTransform = false;
    state = "enabled";
    const readsBeforeDenial = privateReads;
    assert.equal((await photo("thumb", "B".repeat(32))).status, 404);
    assert.equal(privateReads, readsBeforeDenial);
    for (const denied of ["revoked", "error"]) {
      state = denied;
      assert.equal(await loadPublicExpeditionReport(slug), null);
      assert.equal((await photo()).status, 404);
      assert.equal((await photo("thumb")).status, 404);
      assert.equal(privateReads, readsBeforeDenial);
      assert.equal(streamDownloads, 5);
    }
    process.env.EXPEDITION_THUMBNAIL_DELIVERY = "1";
    state = "enabled";
    const derivativeResponse = await photo("thumb");
    assert.equal(derivativeResponse.status, 200);
    assert.equal(derivativeResponse.headers.get("content-type"), "image/webp");
    assert.equal(derivativeResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(derivativeResponse.headers.get("location"), null);
    assert.deepEqual(new Uint8Array(await derivativeResponse.arrayBuffer()), webp);
    ready = null;
    assert.equal((await photo("thumb")).status, 404);
    ready = { ...derivative, object_key: derivative.object_key.replace(mediaId, ownerId) };
    assert.equal((await photo("thumb")).status, 404);
    assert.equal((await photo("thumb", slug, "malformed")).status, 404);
    ready = derivative;
    revokeDuringDerivative = true;
    assert.equal((await photo("thumb")).status, 404);
    revokeDuringDerivative = false;
    assert.equal((await photo("thumb")).status, 404);
    state = "enabled";
    assert.equal((await photo("thumb")).status, 200);
    assert.equal(privateReads, readsBeforeDenial);
    assert.equal(streamDownloads, 5);
    assert.equal(derivativeReads, 3);
  } finally {
    hook.deregister();
    delete globalThis[fixtureKey];
    if (previousSecret === undefined) delete process.env.PUBLIC_EXPEDITION_MEDIA_SECRET;
    else process.env.PUBLIC_EXPEDITION_MEDIA_SECRET = previousSecret;
    if (previousDelivery === undefined) delete process.env.EXPEDITION_THUMBNAIL_DELIVERY;
    else process.env.EXPEDITION_THUMBNAIL_DELIVERY = previousDelivery;
  }
});

console.log("Sharing SQL, UI and locale source contracts passed. Runtime cases use mocked Supabase responses.");
