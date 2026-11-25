"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/Lib/supabase/client";
import { normalizeCountryProgress, type CountryProgress } from "@/Lib/countryProgress";
import CountryProgressCard from "./CountryProgressCard";

export default function AccountCountrySummary({ userId }: { userId: string }) {
  const t = useTranslations("Country");
  const [state, setState] = useState<{ data: CountryProgress | null; error: boolean }>({ data: null, error: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data, error } = await createClient().rpc("get_my_country_mountain_progress");
        const result = error ? null : normalizeCountryProgress(data);
        if (!cancelled) setState({ data: result, error: !result });
      } catch { if (!cancelled) setState({ data: null, error: true }); }
    }
    void load();
    return () => { cancelled = true; };
  }, [userId, revision]);
  if (state.error) return <div role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-5">
    <p>{t("error")}</p><button type="button" className="ui-pressable mt-2 min-h-11 px-3 text-[var(--color-forest)] underline" onClick={() => setRevision((value) => value + 1)}>{t("retry")}</button>
  </div>;
  return state.data ? <CountryProgressCard progress={state.data} /> : <p role="status">{t("loading")}</p>;
}
