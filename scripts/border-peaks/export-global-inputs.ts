#!/usr/bin/env ts-node
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { once } from "node:events";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required. Use node --env-file=.env.local.",
  );
}

const pageSize = 1000;
const mountainOutput = resolve("data/border-peaks/mountains-global.jsonl");
const membershipOutput = resolve(
  "data/border-peaks/existing-memberships-global.jsonl",
);

const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

async function writeLine(
  stream: ReturnType<typeof createWriteStream>,
  value: unknown,
): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) {
    await once(stream, "drain");
  }
}

async function exportMountains(path: string): Promise<number> {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  const stream = createWriteStream(temporary, { encoding: "utf8" });
  let count = 0;
  let lastId = -1;

  try {
    for (;;) {
      const { data, error } = await supabase
        .from("mountains")
        .select("id,name,name_de,latitude,longitude,height,country_code")
        .gt("id", lastId)
        .not("latitude", "is", null)
        .not("longitude", "is", null)
        .not("country_code", "is", null)
        .order("id", { ascending: true })
        .limit(pageSize);
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) {
        const id = Number(row.id);
        if (!Number.isSafeInteger(id) || id <= lastId) {
          throw new Error(`Mountain export order/ID invariant failed at ${row.id}`);
        }
        await writeLine(stream, {
          id,
          name: row.name ?? null,
          name_de: row.name_de ?? null,
          latitude: row.latitude,
          longitude: row.longitude,
          height: row.height ?? null,
          primaryCountryCode: row.country_code,
        });
        lastId = id;
        count += 1;
      }

      process.stdout.write(`mountains: ${count}\r`);
      if (data.length < pageSize) break;
    }
  } finally {
    stream.end();
    await once(stream, "close");
  }

  await rename(temporary, path);
  process.stdout.write(`mountains: ${count}\n`);
  return count;
}

async function exportMemberships(path: string): Promise<number> {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  const stream = createWriteStream(temporary, { encoding: "utf8" });
  let count = 0;
  let offset = 0;

  try {
    for (;;) {
      const { data, error } = await supabase
        .from("mountain_countries")
        .select("mountain_id,country_code,is_primary")
        .order("mountain_id", { ascending: true })
        .order("country_code", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) {
        await writeLine(stream, {
          mountain_id: Number(row.mountain_id),
          country_code: row.country_code,
          is_primary: Boolean(row.is_primary),
        });
        count += 1;
      }

      offset += data.length;
      process.stdout.write(`memberships: ${count}\r`);
      if (data.length < pageSize) break;
    }
  } finally {
    stream.end();
    await once(stream, "close");
  }

  await rename(temporary, path);
  process.stdout.write(`memberships: ${count}\n`);
  return count;
}

async function main(): Promise<void> {
  await mkdir(dirname(mountainOutput), { recursive: true });
  const mountainCount = await exportMountains(mountainOutput);
  const membershipCount = await exportMemberships(membershipOutput);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "read-only-public-api-export",
        mountainCount,
        membershipCount,
        mountainOutput,
        membershipOutput,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
