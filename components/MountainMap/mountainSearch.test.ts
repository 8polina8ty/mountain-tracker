import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_MAP_FILTERS, matchesMountainFilters, retainVisiblePeak } from "./mountainFilters.ts";
import { searchMountains } from "./mountainSearch.ts";
import type { MountainRow } from "./types.ts";

const viewerId = "11111111-1111-4111-8111-111111111111";
type Fixture = MountainRow & { country_code: string; memberships: string[]; climbed?: boolean };
function peak(id: number, name: string, height: number, options: Partial<Fixture> = {}): Fixture {
  return {
    id, osm_id: id * 10, name, name_de: null, height, latitude: 47, longitude: 11,
    wikipedia: null, wikidata: null, region_source: null, country_code: "AT", memberships: [], ...options,
  };
}
const peaks = [
  peak(1, "Zugspitze", 2962, { latitude: 47.421, longitude: 10.986, memberships: ["AT", "DE"], climbed: true }),
  peak(2, "Großglockner", 3798, { latitude: 47.074, longitude: 12.694 }),
  peak(3, "Mont Blanc / Monte Bianco", 4807, { latitude: 45.833, longitude: 6.865, country_code: "IT" }),
  peak(4, "Zugspitze Vorsummit", 3100),
  peak(5, "Piz Bernina", 4049, { name_de: "Berninaspitze", country_code: "CH" }),
  peak(6, "Peak (A), \"North\" *", 3500),
];

function fixtureClient(handle?: (url: URL) => Response | Promise<Response>) {
  const queries: URL[] = [];
  const supabase = createClient("https://mountains.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      queries.push(url);
      assert.equal(url.pathname, "/rest/v1/mountains");
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(url.searchParams.get("order"), "height.desc,id.asc");
      assert.equal(url.searchParams.has("latitude") || url.searchParams.has("longitude"), false);
      if (handle) return handle(url);

      const allOr = url.searchParams.getAll("or");
      const [names, countryPredicate] = allOr;
      const compiled = names.slice("(name.imatch.".length, names.lastIndexOf(",name_de.imatch."));
      const name = new RegExp(JSON.parse(compiled) as string, "iu");
      const min = Number(url.searchParams.get("height")?.slice(4));
      const max = Number(url.searchParams.getAll("height")[1].slice(4));
      const country = url.searchParams.get("search_country.country_code")?.slice(3);
      if (country) {
        assert.match(url.searchParams.get("select") ?? "", /search_country:mountain_countries\(\)/);
        assert.equal(countryPredicate, `(country_code.eq.${country},search_country.not.is.null)`);
      }
      const ascent = url.searchParams.get("search_ascent");
      if (ascent) assert.equal(url.searchParams.get("search_ascent.user_id"), `eq.${viewerId}`);

      return Response.json(peaks.filter((row) =>
        (name.test(row.name ?? "") || name.test(row.name_de ?? ""))
        && row.height >= min && row.height <= max
        && (!country || row.country_code === country || row.memberships.includes(country))
        && (!ascent || Boolean(row.climbed) === (ascent === "not.is.null")),
      ).sort((a, b) => b.height - a.height || a.id - b.id).slice(0, 1));
    } },
  });
  return { supabase, queries };
}

function find(query: string, client = fixtureClient(), overrides: Partial<Parameters<typeof searchMountains>[0]> = {}) {
  return searchMountains({ supabase: client.supabase, query, filters: DEFAULT_MAP_FILTERS, countryCode: "",
    climbedMountainIds: new Set([1]), signal: new AbortController().signal, ...overrides });
}

test("global search finds Zugspitze from Fichtelgebirge and prefers the exact match", async () => {
  const client = fixtureClient();
  const mountain = await find("Zugspitze", client, { filters: { ...DEFAULT_MAP_FILTERS, minHeight: 860 } });
  assert.equal(mountain?.id, 1);
  assert.equal(mountain?.climbed, true);
  assert.deepEqual([mountain?.longitude, mountain?.latitude], [10.986, 47.421]);
  assert.equal(client.queries.length, 1);
});

test("no country restriction finds Großglockner from Germany and Mont Blanc from a distant map", async () => {
  assert.equal((await find("Großglockner"))?.id, 2);
  assert.equal((await find("Mont Blanc"))?.id, 3);
  assert.equal((await find("zUgSpItZe"))?.id, 1);
  assert.equal((await find("glock"))?.id, 2);
});

test("localized aliases are searchable and can appear in the viewport after a reload", async () => {
  const mountain = await find("berNINAsPITZE");
  assert.equal(mountain?.name, "Piz Bernina");
  assert.ok(mountain && matchesMountainFilters(mountain, DEFAULT_MAP_FILTERS, new Set(), "berninaspitze"));
});

test("primary and secondary country filters work before the result limit", async () => {
  assert.equal((await find("Zugspitze", fixtureClient(), { countryCode: "DE" }))?.id, 1);
  assert.equal((await find("Großglockner", fixtureClient(), { countryCode: "AT" }))?.id, 2);
  assert.equal(await find("Großglockner", fixtureClient(), { countryCode: "DE" }), null);
});

test("both height limits apply and unknown names return no match", async () => {
  assert.equal(await find("Zugspitze", fixtureClient(), { filters: { ...DEFAULT_MAP_FILTERS, maxHeight: 2500 } }), null);
  assert.equal(await find("Großglockner", fixtureClient(), { filters: { ...DEFAULT_MAP_FILTERS, minHeight: 4000 } }), null);
  assert.equal(await find("Unknown mountain fixture"), null);
});

test("climbed and unclimbed results use the signed-in user's ascents before the limit", async () => {
  const client = fixtureClient();
  client.supabase.auth.getUser = async () => ({ data: { user: {
    id: viewerId, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01",
  } }, error: null });
  const climbed = await find("Zugspitze", client, {
    filters: { ...DEFAULT_MAP_FILTERS, ascentStatus: "climbed" }, climbedMountainIds: new Set(),
  });
  assert.equal(climbed?.id, 1);
  assert.equal(climbed?.climbed, true);
  const unclimbed = await find("Zugspitze", client, { filters: { ...DEFAULT_MAP_FILTERS, ascentStatus: "unclimbed" } });
  assert.equal(unclimbed?.id, 4);
  assert.equal(unclimbed?.climbed, false);
});

test("search treats punctuation literally and rejects a network error as a failure", async () => {
  assert.equal((await find('Peak (A), "North" *'))?.id, 6);
  assert.equal(await find(".*"), null);
  await assert.rejects(find("Zugspitze", fixtureClient(() => { throw new TypeError("offline"); })), /offline/);
});

test("an aborted earlier request cannot return a peak after a later search succeeds", { timeout: 2000 }, async () => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const slow = fixtureClient(() => new Promise((resolve) => {
    finish = resolve;
    started();
  }));
  const controller = new AbortController();
  const stale = find("Zugspitze", slow, { signal: controller.signal });
  await requestStarted;
  controller.abort();
  assert.equal((await find("Großglockner"))?.id, 2);
  finish(Response.json([peaks[0]]));
  await assert.rejects(stale, { name: "AbortError" });
});

test("the selected search result survives a reload and remains wired to flyTo and details", async () => {
  const chosen = await find("Zugspitze");
  assert.ok(chosen);
  assert.equal(retainVisiblePeak(chosen, { type: "FeatureCollection", features: [] }), chosen);
  const hook = await readFile(new URL("./useMountainSearch.ts", import.meta.url), "utf8");
  assert.match(hook, /controller\.signal\.aborted \|\| activeRequest\.current !== controller/);
  assert.match(hook, /onPeakSelect\(peak\)/);
  assert.match(hook, /map\.flyTo\(\{ center: \[peak\.longitude, peak\.latitude\]/);
  const map = await readFile(new URL("./MountainMap.tsx", import.meta.url), "utf8");
  assert.match(map, /<PeakDetailsPanel[\s\S]*peak=\{selectedPeak\}/);
});

test("all six locales supply the new global search messages", async () => {
  for (const locale of ["de", "en", "es", "fr", "it", "ru"]) {
    const { Map: { Search } } = JSON.parse(await readFile(new URL(`../../messages/${locale}/map.json`, import.meta.url), "utf8"));
    for (const message of [Search.countryLabel, Search.allCountries, Search.status.searching, Search.status.requestError]) {
      assert.ok(message, locale);
      assert.doesNotMatch(message, /[?\uFFFD]/, locale);
    }
  }
});
