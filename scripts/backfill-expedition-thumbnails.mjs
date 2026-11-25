import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const stagingUrl = "https://fsnkqmpsnohwbncwlxnh.supabase.co";
const counters = ["scanned", "photos", "ready", "stale", "pending", "failed", "unqueued", "enqueued", "missing", "invalid", "unavailable"];
const emptyCounts = () => Object.fromEntries(counters.map((key) => [key, 0]));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function validCounts(value) {
  return value && counters.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

async function loadCheckpoint(file, apply) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.version !== 1 || value.stagingUrl !== stagingUrl || value.apply !== apply
      || !["published", "other", "done"].includes(value.cohort)
      || (value.after !== null && !uuid.test(value.after))
      || !validCounts(value.published) || !validCounts(value.other)) {
      throw new Error("Invalid checkpoint, or checkpoint from another mode");
    }
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, stagingUrl, apply, cohort: "published", after: null, published: emptyCounts(), other: emptyCounts() };
  }
}

async function saveCheckpoint(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" }, "dry-run": { type: "boolean" }, apply: { type: "boolean" },
      "published-only": { type: "boolean" }, checkpoint: { type: "string" }, pages: { type: "string", default: "4" },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/backfill-expedition-thumbnails.mjs --checkpoint <file> [--dry-run | --apply] [--published-only] [--pages 1..20]");
    return;
  }
  const pages = Number(values.pages);
  if (!values.checkpoint || (values.apply && values["dry-run"]) || !Number.isInteger(pages) || pages < 1 || pages > 20) {
    throw new Error("Specify a checkpoint, a single mode and a page limit from 1 through 20");
  }
  if (process.env.EXPEDITION_THUMBNAIL_BACKFILL_URL !== stagingUrl || !process.env.EXPEDITION_THUMBNAIL_STAGING_SECRET) {
    throw new Error("The explicit staging URL and staging server key are required");
  }
  const db = createClient(stagingUrl, process.env.EXPEDITION_THUMBNAIL_STAGING_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (resource, init) => fetch(resource, { ...init, redirect: "error", cache: "no-store" }) },
  });
  const apply = values.apply === true;
  const file = resolve(values.checkpoint);
  const state = await loadCheckpoint(file, apply);
  for (let page = 0; page < pages && state.cohort !== "done"; page += 1) {
    if (values["published-only"] && state.cohort !== "published") break;
    const { data, error } = await db.rpc("expedition_thumbnail_backfill_page", {
      p_after: state.after, p_published: state.cohort === "published", p_apply: apply,
    }).abortSignal(AbortSignal.timeout(10_000));
    if (error || !validCounts(data) || (data.next_after !== null
      && (!uuid.test(data.next_after) || data.next_after === state.after))) {
      throw new Error("Backfill page failed. Resume from the last saved checkpoint");
    }
    for (const key of counters) state[state.cohort][key] += data[key];
    state.after = data.next_after;
    if (!state.after) state.cohort = state.cohort === "published" ? "other" : "done";
    await saveCheckpoint(file, state);
  }
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run", progress: state.cohort, published: state.published, other: state.other,
    publishedCoverage: state.published.photos ? state.published.ready / state.published.photos : null,
  }));
}

main().catch((error) => {
  // Publish fixed failure messages only. Paths, cursors and service errors stay local.
  const known = ["Invalid checkpoint, or checkpoint from another mode", "Backfill page failed. Resume from the last saved checkpoint",
    "The explicit staging URL and staging server key are required", "Specify a checkpoint, a single mode and a page limit from 1 through 20"];
  console.error(known.includes(error.message) ? error.message : "Thumbnail backfill stopped");
  process.exitCode = 1;
});
