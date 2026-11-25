import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COUNTRY_CODES } from "../Lib/countries.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const sql = await read("database/auth_country_progress.sql");
const lower = sql.toLowerCase();
const codes = sql.match(/'((?:[A-Z]{2} ){248}[A-Z]{2})'/)?.[1].split(" ");
assert.deepEqual(codes, COUNTRY_CODES, "DB allow-list must exactly match the canonical residence catalog");
assert.ok(!codes.includes("XK"));
assert.ok(sql.includes("^[A-Za-z0-9_][A-Za-z0-9_.-]{1,18}[A-Za-z0-9_]$"));
assert.ok(lower.includes("pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.lower(clean_username), 73021))"));
assert.ok(lower.includes("pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.lower(new.username), 73021))"));
assert.ok(lower.includes("where id = actor for update"));
assert.ok(lower.includes("and p.id <> actor"));
assert.ok(lower.includes("profile_already_completed"));
assert.ok(lower.includes("new.id, null, null, true"), "Auth trigger must create a safe placeholder independently of metadata");
assert.ok(lower.includes("default false"));
assert.ok(lower.includes("set default true"));
assert.ok(!/update\s+public\.profiles\s+set[^;]*where\s+country_code\s+is\s+null/s.test(lower), "No country backfill");
assert.ok(!/create\s+(?:or\s+replace\s+)?function\s+public\.get_user_ranking\s*\(/.test(lower));
assert.ok(!/create\s+unique\s+index/.test(lower));
assert.ok(lower.includes("from public.get_user_ranking() r join public.profiles p on p.id = r.user_id"));
assert.ok(lower.includes("where p.country_code = country"));
assert.ok(lower.includes("count(distinct a.mountain_id)"));
assert.ok(lower.includes("exists (select 1 from public.mountain_countries mc where mc.mountain_id = m.id and mc.country_code = country)"),
  "Country progress/list must use mountain_countries EXISTS membership (border peaks)");
assert.ok(!lower.includes("where m.country_code = country") || lower.includes("mountain_countries"),
  "Direct m.country_code filter must be replaced by mountain_countries membership after multi-country migration");
assert.ok(lower.includes("where a.user_id = actor"));
assert.ok(lower.includes("case when total > 0"));
assert.ok(lower.includes("least(greatest(coalesce(result_limit, 20), 1), 50)"));
assert.ok(lower.includes("order by id limit page_size + 1"));
assert.ok(lower.includes("revoke truncate on table public.profiles from anon, authenticated"));
assert.ok(!/revoke\s+(?:all|update)\s+on\s+(?:table\s+)?public\.profiles/.test(lower), "Keep avatar UPDATE grants");
assert.ok(lower.includes("current_user in ('anon', 'authenticated')"));
assert.ok(lower.includes("new.country_code is distinct from old.country_code"));
assert.ok(lower.includes("new.onboarding_required is distinct from old.onboarding_required"));
assert.ok(lower.includes("before insert or update or delete on %i.%i for each statement"));
assert.ok(lower.includes("as restrictive for insert to authenticated"));
assert.ok(!lower.includes("requested_user_id"));
for (const match of sql.matchAll(/create or replace function ([\s\S]*?)\$fn\$;/g)) {
  if (match[1].includes("security definer")) {
    assert.ok(match[1].includes("set search_path = ''"));
    assert.ok(!/\bfrom\s+(profiles|mountains|ascents)\b/.test(match[1]));
  }
}
const countryUpdate = sql.split("create or replace function public.update_my_residence_country")[1].split("$fn$;")[0];
assert.ok(countryUpdate.includes("where id = actor"));
assert.ok(!/\b(ascents|social_posts|expedition_projects)\b/.test(countryUpdate));
const callback = await read("app/[locale]/auth/callback/route.ts");
assert.ok(callback.includes("exchangeCodeForSession(code)"));
assert.ok(callback.includes("profileDestination"));
assert.ok(callback.includes("getUser()"));
assert.ok(!callback.includes("provider_token"));
const signup = await read("app/[locale]/auth/sign-up/page.tsx");
assert.ok(signup.includes("if (!data.session)"));
assert.ok(signup.includes("checkRegistrationInput"));
assert.ok(signup.includes("completeProfile"));
assert.ok(signup.includes("country_code: country"));
for (const file of ["login", "sign-up"]) assert.ok((await read(`app/[locale]/auth/${file}/page.tsx`)).includes("GoogleAuthButton"));
const english = JSON.parse(await read("messages/en/country.json")).Country;
for (const locale of ["de", "en", "ru", "fr", "it", "es"]) {
  const translated = JSON.parse(await read(`messages/${locale}/country.json`)).Country;
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort());
  for (const [key, value] of Object.entries(translated)) assert.ok(typeof value === "string" && value.length > 0, `${locale}.${key}`);
}
console.log("Auth/country static contracts and six-locale parity passed. Live OAuth, DB concurrency and production deployment are not verified by this validator.");
