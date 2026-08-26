import type { Metadata } from "next";
import { createClient } from "@/Lib/supabase/server";
import { parsePublicExpeditionSearch, searchPublicExpeditions } from "@/Lib/projects/discovery";
import type { Locale } from "@/i18n/locales";
import ExploreClient from "@/components/explore/ExploreClient";

export const metadata: Metadata = { robots: { index: true, follow: true }, alternates: { canonical: "./" } };

export default async function ExplorePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await params;
  const search = parsePublicExpeditionSearch(await searchParams);
  const supabase = await createClient();
  let result: { cards: Awaited<ReturnType<typeof searchPublicExpeditions>>["cards"]; next: Awaited<ReturnType<typeof searchPublicExpeditions>>["next"] } = { cards: [], next: null };
  try {
    result = await searchPublicExpeditions(supabase, search);
  } catch {}
  const query = new URLSearchParams();
  if (search.q) query.set("q", search.q);
  if (search.year) query.set("year", String(search.year));
  if (search.minDistanceKm !== null) query.set("minDistance", String(search.minDistanceKm));
  if (search.maxDistanceKm !== null) query.set("maxDistance", String(search.maxDistanceKm));
  if (search.evidence) query.set("evidence", "1");
  if (search.status) query.set("status", search.status);
  query.set("sort", search.sort);

  return (
    <ExploreClient
      search={search}
      result={result}
      query={query.toString()}
    />
  );
}
