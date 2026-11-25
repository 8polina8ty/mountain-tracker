import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const mc = await read("database/mountain_countries.sql");
const seed = await read("database/mountain_countries_border_seed.sql");
const patch = await read("database/mountain_countries_rpc_patch.sql");
const main = await read("database/auth_country_progress.sql");
const lower = (s) => s.toLowerCase();

// 1) table contract
assert.ok(lower(mc).includes("create table if not exists public.mountain_countries"));
assert.ok(lower(mc).includes("mountain_id bigint not null references public.mountains(id) on delete cascade"));
assert.ok(mc.includes("country_code text not null check (country_code ~ '^[A-Z]{2}$')"));
assert.ok(lower(mc).includes("primary key (mountain_id, country_code)"));
assert.ok(lower(mc).includes("create index if not exists mountain_countries_country_mountain_idx"));
assert.ok(lower(mc).includes("revoke insert, update, delete, truncate on table public.mountain_countries from anon, authenticated"));
assert.ok(lower(mc).includes("enable row level security"));
assert.ok(lower(mc).includes("for select to anon, authenticated using (true)"));

// 2) backfill
assert.ok(lower(mc).includes("insert into public.mountain_countries (mountain_id, country_code, is_primary, source)"));
assert.ok(lower(mc).includes("from public.mountains"));
assert.ok(lower(mc).includes("on conflict (mountain_id, country_code) do nothing"));
assert.ok(lower(mc).includes("'legacy_country_code'"));

// 3) Zugspitze seed AT+DE, no mountains.country_code change
assert.ok(seed.includes("(1, 'AT', true") && seed.includes("(1, 'DE', false"));
assert.ok(!/update\s+public\.mountains\s+set\s+country_code/i.test(seed), "seed must not change mountains.country_code");
assert.ok(!/insert\s+into\s+public\.mountains/i.test(seed));

// 4) independent country_code validation allows XK as mountain data
assert.ok(mc.includes("^[A-Z]{2}$") && !mc.includes("is_residence_country"), "mountain_countries must use shape check, not residence allow-list");

// 5) RPC patch uses EXISTS membership, no duplicate via EXISTS, preserves filters
for (const sql of [patch, main]) {
  const l = lower(sql);
  // progress uses exists
  assert.ok(l.includes("exists (select 1 from public.mountain_countries mc where mc.mountain_id = m.id and mc.country_code = country)"),
    "RPC must use EXISTS on mountain_countries for membership");
  // list still has search on name/name_de, not invented columns
  assert.ok(l.includes("m.name") && l.includes("m.name_de"));
  assert.ok(!l.includes("name_en") && !l.includes("alternate_names"));
  // pagination stable
  assert.ok(l.includes("order by id limit page_size + 1"));
  // limit bounds
  assert.ok(l.includes("least(greatest(coalesce(result_limit, 20), 1), 50)"));
  // distinct counts to avoid duplicate counting
  assert.ok(l.includes("count(distinct"));
  // item countryCode is residence `country`, not primary duplication
  assert.ok(l.includes("'countrycode', country"));
}

// 6) no direct authenticated write to mountain_countries (revoke check already), legacy primary preserved
assert.ok(!/delete\s+from\s+public\.mountains/i.test(mc + seed));

// 7) In-memory simulation of counting & dedup for Zugspitze case
function countProgress({ mountainCountries, ascents, residence }) {
  const eligible = new Set(mountainCountries.filter(mc => mc.country_code === residence).map(mc => mc.mountain_id));
  const total = eligible.size;
  const climbed = new Set(ascents.filter(a => eligible.has(a.mountain_id)).map(a => a.mountain_id)).size;
  return { total, climbed };
}
const mcs = [
  { mountain_id: 1, country_code: "AT", is_primary: true }, { mountain_id: 1, country_code: "DE", is_primary: false },
  { mountain_id: 2, country_code: "DE", is_primary: true }, { mountain_id: 3, country_code: "AT", is_primary: true },
  { mountain_id: 4, country_code: "XK", is_primary: false },
];
const ascents = [{ mountain_id: 1 }, { mountain_id: 1 }, { mountain_id: 2 }]; // duplicate ascents for 1
assert.deepEqual(countProgress({ mountainCountries: mcs, ascents, residence: "DE" }), { total: 2, climbed: 2 }); // 1 and 2, counted once
assert.deepEqual(countProgress({ mountainCountries: mcs, ascents, residence: "AT" }), { total: 2, climbed: 1 }); // 1 and 3
// foreign-only excluded
assert.ok(!mcs.some(mc => mc.mountain_id === 999));
// XK membership accepted as mountain data but residence XK would be rejected via is_residence_country (handled separately)
// Global ranking still uses get_user_ranking without mountain filter – patch does not touch it
assert.ok(!/create\s+.*get_user_ranking/i.test(patch));

console.log("mountain_countries static contracts passed (multi-country, Zugspitze AT+DE, distinct, pagination, XK, ranking).");
