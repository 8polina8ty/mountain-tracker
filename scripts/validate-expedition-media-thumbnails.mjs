import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import sharp from "sharp";
import { processExpeditionThumbnail, ThumbnailDecodeError } from "../Lib/projects/thumbnailProcessor.ts";
import { readVersionedPhoto, ThumbnailStorageError } from "../Lib/projects/thumbnailStorage.ts";

const execFileAsync = promisify(execFile);
const load = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const assertInvalid = (promise) => assert.rejects(promise, (error) => error instanceof ThumbnailDecodeError && error.kind === "invalid_source");
const createImage = (width, height) => sharp({ create: { width, height, channels: 3, background: "#577894" } });

function noiseBytes(size, seed) {
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < bytes.length; offset++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[offset] = seed >>> 24;
  }
  return bytes;
}

test("static JPEG, PNG and WebP resize to bounded, metadata-free WebP", async () => {
  const inputs = [
    ["image/jpeg", await createImage(600, 300).jpeg().withMetadata({ orientation: 6 }).toBuffer(), [128, 256]],
    ["image/png", await createImage(600, 300).png().toBuffer(), [256, 128]],
    ["image/webp", await createImage(70, 40).webp().toBuffer(), [70, 40]],
  ];
  assert.equal((await sharp(inputs[0][1]).metadata()).orientation, 6);
  assert.ok((await sharp(inputs[0][1]).metadata()).exif);
  const measured = [];
  for (const [mime, bytes, dimensions] of inputs) {
    const result = await processExpeditionThumbnail(bytes, mime);
    const output = await sharp(result.bytes).metadata();
    assert.deepEqual([result.width, result.height], dimensions);
    assert.deepEqual([output.width, output.height], dimensions);
    assert.equal(output.format, "webp");
    assert.ok(result.bytes.length <= 65_536);
    for (const field of ["exif", "iptc", "xmp", "orientation"]) assert.equal(output[field], undefined);
    measured.push({ mime, inputBytes: bytes.length, outputBytes: result.bytes.length, elapsedMs: result.elapsedMs, peakRss: result.peakRss });
  }
  const noisy = noiseBytes(768 * 768 * 3, 12345);
  const noisyPng = await sharp(noisy, { raw: { width: 768, height: 768, channels: 3 } }).png().toBuffer();
  const result = await processExpeditionThumbnail(noisyPng, "image/png");
  assert.ok(noisyPng.length > 512 * 1024 && result.bytes.length <= 65_536);
  measured.push({ mime: "image/png", inputBytes: noisyPng.length, outputBytes: result.bytes.length, elapsedMs: result.elapsedMs, peakRss: result.peakRss });
  const alpha = sharp(noiseBytes(256 * 256 * 4, 44109), { raw: { width: 256, height: 256, channels: 4 } });
  const initial = await alpha.clone().webp({ quality: 76, alphaQuality: 76, effort: 3 }).toBuffer();
  assert.ok(initial.length > 65_536, "Fixture must exercise the quality fallback");
  const constrained = await processExpeditionThumbnail(await alpha.png().toBuffer(), "image/png");
  assert.ok(constrained.bytes.length >= 1 && constrained.bytes.length <= 65_536);
  console.log("Thumbnail WebP budget", JSON.stringify({ initial: initial.length, final: constrained.bytes.length }));
  console.log("Thumbnail decoder measurements", JSON.stringify(measured));
});

test("decoder rejects mismatched MIME, truncation, animation and encoded/pixel/dimension limits", async () => {
  const png = await createImage(32, 19).png().toBuffer();
  const jpeg = await createImage(32, 19).jpeg().toBuffer();
  await assertInvalid(processExpeditionThumbnail(png, "image/jpeg"));
  await assertInvalid(processExpeditionThumbnail(png.subarray(0, -8), "image/png"));
  await assertInvalid(processExpeditionThumbnail(jpeg.subarray(0, -2), "image/jpeg"));
  await assertInvalid(processExpeditionThumbnail(Buffer.alloc(10 * 1024 * 1024 + 1), "image/webp"));
  await assertInvalid(processExpeditionThumbnail(await createImage(8193, 1).png().toBuffer(), "image/png"));
  await assertInvalid(processExpeditionThumbnail(await createImage(6400, 6300).png().toBuffer(), "image/png"));
  const fakeAnimatedChunk = Buffer.from("000000086163544c000000020000000000000000", "hex");
  await assertInvalid(processExpeditionThumbnail(Buffer.concat([png.subarray(0, 33), fakeAnimatedChunk, png.subarray(33)]), "image/png"));
  const animatedWebp = await sharp(
    [png, await sharp(png).flop().modulate({ brightness: 0.5 }).png().toBuffer()],
    { join: { across: 1, animated: true } },
  ).webp({ delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animatedWebp).metadata()).pages, 2);
  await assertInvalid(processExpeditionThumbnail(animatedWebp, "image/webp"));
  await assert.rejects(processExpeditionThumbnail(png, "image/png", AbortSignal.abort()));
});

test("exact-version transport fails closed on ignored query, changed MIME, size and missing version", async () => {
  const credentials = { url: "https://supabase.example", secret: "sb_secret_synthetic" };
  const signal = AbortSignal.timeout(1000);
  const object = {
    bucket: "expedition-media", path: "item/original.png", version: "00000000-0000-4000-8000-000000000001",
    size: 3, mime: "image/png",
  };
  for (const entry of [
    { status: 200, data: new Uint8Array([1, 2, 3]), mime: "image/png", ok: true },
    { status: 200, data: new Uint8Array([1, 2]), mime: "image/png" },
    { status: 200, data: new Uint8Array([1, 2, 3, 4]), mime: "image/png" },
    { status: 200, data: new Uint8Array([1, 2, 3]), mime: "image/jpeg" },
    { status: 404, data: null, mime: "image/png" },
    { status: 200, ignored: true, data: null, mime: "image/png" },
  ]) {
    let calls = 0;
    const request = async (url, init) => {
      calls++;
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/storage/v1/object/authenticated/expedition-media/item/original.png");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.equal(init.headers.apikey, credentials.secret);
      const version = parsed.searchParams.get("versionId");
      if (calls === 1) {
        assert.ok(version && version !== object.version);
        return new Response(null, { status: entry.ignored ? 200 : 404 });
      }
      assert.equal(version, object.version);
      return new Response(entry.data, { status: entry.status, headers: { "Content-Type": entry.mime } });
    };
    const download = readVersionedPhoto(credentials, object, signal, request);
    if (entry.ok) assert.deepEqual(await download, entry.data);
    else await assert.rejects(download);
    assert.equal(calls, entry.ignored ? 1 : 2);
  }
  await assert.rejects(readVersionedPhoto(credentials, { ...object, version: "null" }, signal, () => {
    assert.fail("invalid version reached Storage");
  }));
});

test("exact-version Storage reads accept only the observed wrapped missing-key response", async () => {
  const credentials = { url: "https://staging.example.invalid", secret: "sb_secret_test" };
  const object = {
    bucket: "expedition-media", path: "item/original.png", version: "00000000-0000-4000-8000-000000000001",
    size: 3, mime: "image/png",
  };
  const missing = { code: "NoSuchKey", error: "not_found", statusCode: "404" };
  const wrap = (body) => Response.json(body, { status: 400 });
  const bytes = new Uint8Array([1, 2, 3]);
  const exact = () => new Response(bytes, { headers: { "Content-Type": object.mime } });
  const read = (...responses) => readVersionedPhoto(credentials, object, AbortSignal.timeout(1000), () => {
    assert.ok(responses.length, "unexpected Storage request");
    return responses.shift();
  });

  assert.deepEqual(await read(wrap(missing), exact()), bytes);
  await assert.rejects(read(wrap(missing), wrap(missing)), { kind: "source_changed" });
  for (const mutation of [
    { ...missing, code: "AccessDenied" },
    { ...missing, error: "invalid_request" },
    { ...missing, statusCode: "400" },
    { ...missing, message: "x".repeat(1024) },
  ]) {
    await assert.rejects(read(wrap(mutation)), { kind: "storage" });
  }
  await assert.rejects(read(new Response("invalid", {
    status: 400, headers: { "Content-Type": "application/json" },
  })), { kind: "storage" });
});

test("worker route gates disabled and unauthenticated requests before service access", async () => {
  const secret = "test-only-worker-secret-with-enough-characters";
  const oldSecret = process.env.EXPEDITION_THUMBNAIL_WORKER_SECRET;
  const oldFlag = process.env.EXPEDITION_THUMBNAIL_WORKER_ENABLED;
  let calls = 0;
  const key = Symbol.for("expedition-thumbnail-worker-test");
  globalThis[key] = async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    calls++;
    return { status: "busy" };
  };
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/Lib/projects/thumbnailJobs") return {
        url: "data:text/javascript," + encodeURIComponent('export const runExpeditionThumbnailWorker = globalThis[Symbol.for("expedition-thumbnail-worker-test")]'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    },
  });
  try {
    process.env.EXPEDITION_THUMBNAIL_WORKER_SECRET = secret;
    delete process.env.EXPEDITION_THUMBNAIL_WORKER_ENABLED;
    const { POST } = await import("../app/api/internal/expedition-media/thumbnails/route.ts");
    const request = (token) => new Request("https://example.test/worker", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal((await POST(request(secret))).status, 404);
    process.env.EXPEDITION_THUMBNAIL_WORKER_ENABLED = "1";
    assert.equal((await POST(request("wrong"))).status, 401);
    assert.equal(calls, 0);
    const response = await POST(request(secret));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { status: "busy" });
    assert.equal(calls, 1);
  } finally {
    hook.deregister();
    delete globalThis[key];
    if (oldSecret === undefined) delete process.env.EXPEDITION_THUMBNAIL_WORKER_SECRET;
    else process.env.EXPEDITION_THUMBNAIL_WORKER_SECRET = oldSecret;
    if (oldFlag === undefined) delete process.env.EXPEDITION_THUMBNAIL_WORKER_ENABLED;
    else process.env.EXPEDITION_THUMBNAIL_WORKER_ENABLED = oldFlag;
  }
});

test("worker fences uploads, binds published bytes and completes a single attempt", async () => {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const input = await createImage(64, 32).png().toBuffer();
  const job = {
    media_id: id(1), project_id: id(2), attempt_id: id(3), processing_version: 1,
    source_path: `${id(4)}/${id(2)}/${id(5)}/${id(1)}/original.png`, source_mime: "image/png",
    source_size: input.length, source_object_id: id(6), source_version: id(7), derivative_key: `${id(1)}/v1/${id(3)}.webp`,
  };
  let events, scenario, uploaded, fences;
  const success = (data) => ({ data, error: null });
  const db = {
    async rpc(name, args) {
      const suffix = name.replace("expedition_thumbnail_", "");
      events.push(suffix);
      switch (suffix) {
        case "worker_acquire": return success(scenario === "busy" ? null : id(8));
        case "claim_cleanup": return success([]);
        case "worker_claim": return success([job]);
        case "may_upload": return success(++fences < 2 || scenario !== "replaced");
        case "complete":
          assert.equal(args.p_source_id, job.source_object_id);
          assert.equal(args.p_source_version, job.source_version);
          assert.equal(args.p_derivative_id, id(9));
          assert.equal(args.p_derivative_version, id(10));
          assert.equal(args.p_size_bytes, uploaded.length);
          return success(true);
        case "fail":
          assert.equal(args.p_error, scenario === "replaced" ? "source_changed" : "storage");
          return success(true);
        case "worker_release":
          assert.equal(args.p_token, id(8));
          return success(true);
        default: assert.fail("Unexpected worker database call");
      }
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "expedition-media-thumbnails");
        return {
          async upload(path, bytes, options) {
            events.push("upload");
            assert.equal(path, job.derivative_key);
            assert.equal(options.upsert, false);
            uploaded = bytes;
            return success({ id: id(9) });
          },
          async info(path) {
            events.push("info");
            assert.equal(path, job.derivative_key);
            return success({ id: id(scenario === "wrong-output" ? 99 : 9), version: id(10) });
          },
        };
      },
    },
  };
  const key = Symbol.for("expedition-thumbnail-jobs-test");
  globalThis[key] = {
    createClient: () => db,
    getSupabaseAdminCredentials: () => ({ url: "https://example.test", secret: "synthetic" }),
    ThumbnailStorageError,
    async readVersionedPhoto(_credentials, object) {
      if (object.bucket === "expedition-media") {
        events.push("source");
        assert.equal(object.path, job.source_path);
        assert.equal(object.version, job.source_version);
        return new Uint8Array(input);
      }
      events.push("derivative");
      assert.equal(object.version, id(10));
      return new Uint8Array(uploaded);
    },
  };
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.endsWith("/thumbnailJobs.ts")) return nextResolve(specifier, context);
      const fixture = 'globalThis[Symbol.for("expedition-thumbnail-jobs-test")]';
      const mapped = {
        "server-only": "export {}",
        "@supabase/supabase-js": `export const { createClient } = ${fixture}`,
        "../supabase/admin.ts": `export const { getSupabaseAdminCredentials } = ${fixture}`,
        "./thumbnailStorage.ts": `export const EXPEDITION_THUMBNAIL_BUCKET = 'expedition-media-thumbnails'; export const { readVersionedPhoto, ThumbnailStorageError } = ${fixture}`,
      }[specifier];
      return mapped ? { url: "data:text/javascript," + encodeURIComponent(mapped), shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  try {
    const { runExpeditionThumbnailWorker } = await import("../Lib/projects/thumbnailJobs.ts");
    const prefix = ["worker_acquire", "claim_cleanup", "worker_claim", "may_upload", "source", "may_upload"];
    for (const [name, outcome, calls] of [
      ["ready", "ready", [...prefix, "upload", "info", "derivative", "complete", "worker_release"]],
      ["replaced", "fenced", [...prefix, "fail", "worker_release"]],
      ["wrong-output", "storage", [...prefix, "upload", "info", "fail", "worker_release"]],
      ["busy", undefined, ["worker_acquire"]],
    ]) {
      scenario = name;
      events = [];
      fences = 0;
      uploaded = null;
      const result = await runExpeditionThumbnailWorker(AbortSignal.timeout(10_000));
      assert.equal(result.generation?.outcome, outcome);
      assert.deepEqual(events, calls);
    }
  } finally {
    hook.deregister();
    delete globalThis[key];
  }
});

test("release wiring preserves service fences, the read-only delivery path and six locale keys", async () => {
  const [sql, worker, report, viewer, config, pkg] = await Promise.all([
    load("database/expedition_media_thumbnails.sql"), load("Lib/projects/thumbnailJobs.ts"),
    load("Lib/projects/publicReport.ts"), load("components/projects/PublicExpeditionPhotoViewer.tsx"),
    load("next.config.ts"), load("package.json").then(JSON.parse),
  ]);
  assert.match(sql, /o\.archived_at is null[\s\S]*limit 2[\s\S]*count\(\*\) from candidates\) = 1 and not c\.is_delete_marker/);
  assert.match(sql, /versioning_status = 'DISABLED'/);
  assert.doesNotMatch(sql, /delete\s+from\s+storage\.objects/i);
  assert.match(worker, /upsert: false/);
  const resolver = report.split("async function resolvePublicDerivative")[1].split("export async function resolvePublicPhoto")[0];
  assert.match(resolver, /expedition_thumbnail_lookup/);
  assert.doesNotMatch(resolver, /thumbnail_enqueue|thumbnail_complete|thumbnailProcessor|expedition-media["']/);
  assert.match(viewer, /aria-describedby=.*unavailable/);
  assert.match(config, /thumbnailDecodeWorker\.cjs/);
  assert.equal(pkg.dependencies.sharp, "0.35.5");
  assert.match(pkg.scripts["test:projects"], /test:thumbnails/);
  for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
    const messages = JSON.parse(await load(`messages/${locale}/projects.json`));
    assert.ok(messages.Projects.Media.thumbnailUnavailable);
  }
});

test("backfill CLI refuses missing or wrong environment before serving requests", async () => {
  const script = new URL("./backfill-expedition-thumbnails.mjs", import.meta.url);
  const path = fileURLToPath(script);
  const env = { ...process.env, EXPEDITION_THUMBNAIL_BACKFILL_URL: "https://wrong.example", EXPEDITION_THUMBNAIL_STAGING_SECRET: "" };
  const options = { env, timeout: 3000 };
  assert.match((await execFileAsync(process.execPath, [path, "--help"], options)).stdout, /--dry-run/);
  await assert.rejects(execFileAsync(process.execPath, [path, "--checkpoint", "should-not-be-created.json"], options),
    (error) => error.stderr.includes("explicit staging URL"));
});
