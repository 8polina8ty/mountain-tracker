import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publicReportSource = await readFile(new URL("../Lib/projects/publicReport.ts", import.meta.url), "utf8");
const publicMediaRoute = await readFile(new URL("../app/api/public-expeditions/[slug]/media/[handle]/route.ts", import.meta.url), "utf8");
const publicPage = await readFile(new URL("../app/[locale]/expeditions/[slug]/page.tsx", import.meta.url), "utf8");

assert.ok(publicReportSource.includes('createCipheriv("aes-256-gcm"') && publicReportSource.includes('createDecipheriv("aes-256-gcm"'),
  "PUBLIC A: public media handles must use authenticated opaque encryption.");
assert.ok(publicReportSource.includes("cipher.setAAD") && publicReportSource.includes("decipher.setAAD")
  && publicReportSource.includes("cipher.getAuthTag()") && publicReportSource.includes("decipher.setAuthTag(tag)"),
  "PUBLIC A: media handles must bind authenticated encryption to the share slug.");
assert.ok(publicReportSource.includes("PUBLIC_MEDIA_HANDLE_VERSION = 2") && publicReportSource.includes("token[0] !== PUBLIC_MEDIA_HANDLE_VERSION"),
  "PUBLIC B: public media handle format must remain explicitly versioned.");
assert.equal(publicReportSource.includes("createHmac") || publicReportSource.includes("timingSafeEqual"), false,
  "PUBLIC B: legacy scan-and-compare media handles must not return.");

const photoResolver = publicReportSource.match(/export async function resolvePublicPhoto[\s\S]*$/)?.[0] ?? "";
assert.ok(photoResolver.includes("const mediaId = mediaIdFromHandle(slug, handle)"),
  "PUBLIC C: opaque handle must resolve to one authenticated media identifier before lookup.");
assert.ok(photoResolver.includes('.eq("id", mediaId)') && photoResolver.includes('.eq("project_id", resolved.projectId)')
  && photoResolver.includes('.eq("media_type", "photo")') && photoResolver.includes(".maybeSingle()"),
  "PUBLIC C: public photo lookup must be an exact project-scoped single-row query.");
assert.equal(photoResolver.includes(".limit(1000)") || photoResolver.includes("(data ?? []).find"), false,
  "PUBLIC D: public media delivery must not scan a bounded project photo list.");
assert.ok(photoResolver.indexOf("resolveMediaShare(slug)") < photoResolver.indexOf('.storage\n    .from("expedition-media")'.replace("\\n", "\n"))
  || photoResolver.indexOf("resolveMediaShare(slug)") < photoResolver.indexOf('.from("expedition-media")'),
  "PUBLIC E: enabled-share authorization must be revalidated before Storage download.");
assert.ok(photoResolver.includes("10 * 1024 * 1024") && photoResolver.includes('["image/jpeg", "image/png", "image/webp"]'),
  "PUBLIC F: public photo MIME and size bounds must remain enforced.");
assert.equal(photoResolver.includes("getPublicUrl"), false, "PUBLIC F: public media must never expose a Storage public URL.");

assert.ok(publicReportSource.includes("const [project, evidence] = await Promise.all([")
  && publicReportSource.includes("getUserProject(resolved.admin, resolved.ownerId, resolved.projectId)")
  && publicReportSource.includes("listProjectDayTrackEvidence(resolved.admin, resolved.ownerId, resolved.projectId)"),
  "PUBLIC G: private report graph and GPS evidence should load in parallel after share resolution.");
assert.ok(publicReportSource.includes("const projectWithEvidence: ExpeditionProject = {")
  && publicReportSource.includes("days: project.days.map((day) => ({"),
  "PUBLIC H: public projection must derive evidence-enriched days without mutating the canonical project object.");

for (const header of [
  '"Cache-Control": "private, no-store"',
  '"X-Content-Type-Options": "nosniff"',
  '"Cross-Origin-Resource-Policy": "same-origin"',
  '"Referrer-Policy": "no-referrer"',
]) {
  assert.ok(publicMediaRoute.includes(header), `PUBLIC I: hardened media response header missing ${header}`);
}
assert.equal(publicMediaRoute.includes("storage_path") || publicMediaRoute.includes("createAdminClient"), false,
  "PUBLIC I: route layer must not expose Storage metadata or privileged client access.");
assert.ok(publicPage.includes("media.handle") && publicPage.includes("?variant=thumb"),
  "PUBLIC J: public page must continue to consume only opaque media handles.");
assert.equal(publicPage.includes("mediaId") || publicPage.includes("storagePath"), false,
  "PUBLIC J: private media identifiers must not reach the public page model.");

console.log("Public expedition report and media hardening contracts passed.");
