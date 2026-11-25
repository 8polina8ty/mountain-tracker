"use client";

import { useEffect, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { getCountryName, isCountryCode } from "@/Lib/countries";
import { Link } from "@/i18n/navigation";
import BackButton from "@/components/navigation/BackButton";

type Row = { user_id: string; username: string; ascents_count: number; total_height: number;
  highest_mountain_height: number; highest_mountain_name: string | null; achievements_count: number; position: number };
type Ranking = { countryCode: string | null; items: Row[]; hasMore: boolean };

function parseRanking(value: unknown): Ranking | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Ranking;
  if (!(row.countryCode === null || isCountryCode(row.countryCode)) || !Array.isArray(row.items) || row.items.length > 50 || typeof row.hasMore !== "boolean") return null;
  if (!row.items.every((item) => typeof item.user_id === "string" &&
    (item.username === null || typeof item.username === "string") &&
    [item.ascents_count, item.total_height, item.highest_mountain_height, item.achievements_count, item.position].every((n) => typeof n === "number" && Number.isFinite(n)))) return null;
  return row;
}

export default function CountryRanking() {
  const t = useTranslations("Country");
  const rankingT = useTranslations("Ranking");
  const locale = useLocale();
  const format = useFormatter();
  const [query, setQuery] = useState({ search: "", sort: "ascents", offset: 0, revision: 0 });
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<Ranking | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "signed-out">("loading");
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus("loading");
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { if (!cancelled) { setResult(null); setStatus("signed-out"); } return; }
        const { data, error } = await supabase.rpc("get_my_country_ranking", {
          search: query.search, sort_mode: query.sort, page_offset: query.offset, result_limit: 20,
        });
        if (cancelled) return;
        const parsed = error ? null : parseRanking(data);
        setResult(parsed); setStatus(parsed ? "ready" : "error");
      } catch { if (!cancelled) { setResult(null); setStatus("error"); } }
    }
    void load();
    return () => { cancelled = true; };
  }, [query]);

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => { createClient().auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null)); }, []);
  const podium = () => {
    if (!result) return null;
    const top = result.items.slice(0, 3);
    if (top.length===0) return null;
    const metric = (r: typeof top[number]) => query.sort==="total-height"?`${format.number(r.total_height)} m`:query.sort==="highest-mountain"?`${format.number(r.highest_mountain_height)} m`:query.sort==="achievements"?`${format.number(r.achievements_count)}`:`${format.number(r.ascents_count)}`;
    const accents: Record<number,{card:string,base:string,rankBg:string}> = {
      1:{card:"border-[var(--color-ochre)] bg-[var(--color-surface)]",base:"bg-[var(--color-ochre)] text-white border-[var(--color-ochre-deep)]",rankBg:"bg-[var(--color-ochre)]"},
      2:{card:"border-[var(--color-granite)] bg-[var(--color-surface)]",base:"bg-[var(--color-granite)] text-white",rankBg:"bg-[var(--color-granite)]"},
      3:{card:"border-[var(--color-stone)] bg-[var(--color-surface)]",base:"bg-[var(--color-stone)] text-white",rankBg:"bg-[var(--color-stone)]"},
    };
    const baseH: Record<number,string> = {1:"h-[138px] sm:h-[142px]",2:"h-[96px] sm:h-[108px]",3:"h-[76px] sm:h-[88px]"};
    if (top.length<3) {
      return <section aria-label="Top 3" className="grid gap-3 sm:grid-cols-3 sm:items-end">
        {top.map((r)=>{
          const pos=r.position;
          return <Link key={r.user_id} href={`/users/${r.user_id}`} className={`ui-pressable flex flex-col items-center gap-2 rounded-[var(--radius-card)] border-2 p-4 text-center shadow-[var(--shadow-xs)] ${accents[pos].card} ${currentUserId===r.user_id ? "ring-2 ring-[var(--color-forest)] ring-offset-2" : ""}`}>
            <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold text-white ${accents[pos].rankBg}`}>{pos}</span>
            <span className="max-w-[14ch] truncate text-sm font-bold">{r.username ?? rankingT("Status.unknownUser")}</span>
            {currentUserId===r.user_id && <span className="rounded-full bg-[var(--color-forest)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">You</span>}
            <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{metric(r)}</span>
          </Link>;
        })}
      </section>;
    }
    const order=[top[1], top[0], top[2]];
    return <section aria-label="Top 3" className="grid grid-cols-3 items-end gap-2 sm:gap-4">
      {order.map((r)=>{
        const pos=r.position;
        return <div key={r.user_id} className="flex flex-col items-center">
          <Link href={`/users/${r.user_id}`} className={`ui-pressable flex w-full flex-col items-center gap-1.5 rounded-[var(--radius-card)] border-2 p-2 text-center shadow-[var(--shadow-card)] sm:gap-2 sm:p-3 ${accents[pos].card} ${currentUserId===r.user_id ? "ring-2 ring-[var(--color-forest)] ring-offset-2" : ""}`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold text-white sm:h-7 sm:w-7 ${accents[pos].rankBg}`}>{pos}</span>
            <span className="max-w-[8ch] truncate text-[11px] font-bold sm:max-w-[11ch] sm:text-xs">{r.username ?? rankingT("Status.unknownUser")}</span>
            {currentUserId===r.user_id && <span className="rounded-full bg-[var(--color-forest)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">You</span>}
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)] sm:text-[11px]">{metric(r)}</span>
          </Link>
          <div className={`mt-2 flex w-full items-center justify-center rounded-t-[var(--radius-control)] border border-b-0 text-xs font-bold tabular-nums shadow-inner ${accents[pos].base} ${baseH[pos]}`}>{pos}</div>
        </div>;
      })}
    </section>;
  };
  return <section className="space-y-6" aria-busy={status === "loading"}>
    <BackButton fallback="/account" />
    <h1 className="text-[28px] font-bold tracking-tight">{t("countryRanking")}</h1>
    {status === "loading" ? <p role="status">{t("loading")}</p> : status === "error" ? <div role="alert"><p>{t("error")}</p>
      <button type="button" onClick={() => setQuery((current) => ({ ...current, revision: current.revision + 1 }))} className="ui-pressable min-h-11 px-3 text-[var(--color-forest)] underline">{t("retry")}</button></div> :
      status === "signed-out" ? <Link href="/auth/login?returnTo=/ranking" className="ui-pressable inline-flex min-h-11 items-center text-[var(--color-forest)] underline">{t("signInRequired")}</Link> :
      result?.countryCode ? <>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)]">
          <span aria-hidden="true" className="text-lg">{String.fromCodePoint(...[...result.countryCode].map((c)=>0x1f1a5+c.charCodeAt(0)))}</span>
          <p className="text-sm font-semibold text-[var(--color-text)]">{t("countryRankingDescription", { country: getCountryName(result.countryCode, locale) ?? result.countryCode })}</p>
          <Link href="/account/country-mountains" className="ui-pressable ml-auto inline-flex min-h-9 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 text-xs font-semibold hover:bg-[var(--color-surface)]">{t("countryMountains")}</Link>
        </div>
        {podium()}
        <form onSubmit={(event) => { event.preventDefault(); setQuery((current) => ({ ...current, search: draft.trim(), offset: 0 })); }} className="flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)]">
          <label className="min-w-0 flex-1 space-y-2"><span className="block text-sm font-semibold">{t("searchUsers")}</span><input type="search" value={draft} maxLength={100} onChange={(event) => setDraft(event.target.value)} className="ui-field min-h-11 w-full px-3" /></label>
          <label className="space-y-2"><span className="block text-sm font-semibold">{rankingT("Sorting.label")}</span>
            <select value={query.sort} onChange={(event) => setQuery((current) => ({ ...current, sort: event.target.value, offset: 0 }))} className="ui-field min-h-11 px-3">
              <option value="ascents">{rankingT("Sorting.ascents")}</option><option value="total-height">{rankingT("Sorting.totalHeight")}</option><option value="highest-mountain">{rankingT("Sorting.highestMountain")}</option><option value="achievements">{rankingT("Sorting.achievements")}</option>
            </select></label>
          <button type="submit" className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)]">{t("applyFilters")}</button>
        </form>
        {result.items.length === 0 ? <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center"><p role="status" className="text-sm text-[var(--color-text-muted)]">{t("emptyResults")}</p></div> : <ol className="space-y-3" start={query.offset + 1}>
          {result.items.map((row) => <li key={row.user_id} className={`rounded-[var(--radius-card)] border bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)] sm:p-5 ${currentUserId===row.user_id ? "border-[var(--color-forest)] ring-1 ring-[var(--color-forest)]/20" : "border-[var(--color-border-soft)]"}`}>
            <div className="flex items-center gap-3"><span className="text-lg font-bold tabular-nums text-[var(--color-forest)]">{format.number(row.position)}</span>
              <Link href={`/users/${row.user_id}`} className="ui-pressable inline-flex min-h-11 items-center break-all font-semibold text-[var(--color-forest)] hover:underline">{row.username ?? rankingT("Status.unknownUser")}</Link>{currentUserId===row.user_id && <span className="rounded-full bg-[var(--color-forest)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">You</span>}</div>
            <dl className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div><dt className="text-[var(--color-text-muted)]">{rankingT("Table.ascents")}</dt><dd className="mt-1 font-semibold tabular-nums">{format.number(row.ascents_count)}</dd></div>
              <div><dt className="text-[var(--color-text-muted)]">{rankingT("Table.totalElevation")}</dt><dd className="mt-1 font-semibold tabular-nums">{format.number(row.total_height)} m</dd></div>
              <div><dt className="text-[var(--color-text-muted)]">{rankingT("Table.highestPoint")}</dt><dd className="mt-1 font-semibold">{row.highest_mountain_name ?? t("notAvailable")} · {format.number(row.highest_mountain_height)} m</dd></div>
              <div><dt className="text-[var(--color-text-muted)]">{rankingT("Table.achievements")}</dt><dd className="mt-1 font-semibold tabular-nums">{format.number(row.achievements_count)}</dd></div>
            </dl>
          </li>)}
        </ol>}
        <nav aria-label={t("pagination")} className="flex gap-4">
          <button type="button" disabled={query.offset === 0} onClick={() => setQuery((current) => ({ ...current, offset: Math.max(0, current.offset - 20) }))} className="ui-pressable min-h-11 px-4 text-[var(--color-forest)] disabled:opacity-40">{t("previous")}</button>
          <button type="button" disabled={!result.hasMore} onClick={() => setQuery((current) => ({ ...current, offset: current.offset + 20 }))} className="ui-pressable min-h-11 px-4 text-[var(--color-forest)] disabled:opacity-40">{t("next")}</button>
        </nav>
      </> : <div><p>{t("legacyPrompt")}</p><Link href="/account/settings" className="ui-pressable inline-flex min-h-11 items-center text-[var(--color-forest)] underline">{t("choose")}</Link></div>}
  </section>;
}
