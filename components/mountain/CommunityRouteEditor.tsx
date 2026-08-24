"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "@/i18n/navigation";
import {
  COMMUNITY_ROUTE_BEST_SEASON_MAX, COMMUNITY_ROUTE_CONDITIONS_NOTES_MAX,
  COMMUNITY_ROUTE_DESCRIPTION_MAX, COMMUNITY_ROUTE_DIFFICULTY_SYSTEM_MAX,
  COMMUNITY_ROUTE_DIFFICULTY_VALUE_MAX, COMMUNITY_ROUTE_EQUIPMENT_MAX,
  COMMUNITY_ROUTE_START_LOCATION_MAX, COMMUNITY_ROUTE_SUMMARY_MAX,
  COMMUNITY_ROUTE_TITLE_MAX, COMMUNITY_ROUTE_WARNINGS_MAX,
  type CommunityRouteContent,
} from "@/Lib/tracks/communityRouteContent";

const fields: Array<{ key: keyof CommunityRouteContent; kind: "input" | "textarea"; max: number; section: string }> = [
  { key: "title", kind: "input", max: COMMUNITY_ROUTE_TITLE_MAX, section: "basics" },
  { key: "summary", kind: "textarea", max: COMMUNITY_ROUTE_SUMMARY_MAX, section: "basics" },
  { key: "description", kind: "textarea", max: COMMUNITY_ROUTE_DESCRIPTION_MAX, section: "description" },
  { key: "start_location", kind: "input", max: COMMUNITY_ROUTE_START_LOCATION_MAX, section: "routeInfo" },
  { key: "difficulty_system", kind: "input", max: COMMUNITY_ROUTE_DIFFICULTY_SYSTEM_MAX, section: "routeInfo" },
  { key: "difficulty_value", kind: "input", max: COMMUNITY_ROUTE_DIFFICULTY_VALUE_MAX, section: "routeInfo" },
  { key: "best_season", kind: "textarea", max: COMMUNITY_ROUTE_BEST_SEASON_MAX, section: "routeInfo" },
  { key: "equipment", kind: "textarea", max: COMMUNITY_ROUTE_EQUIPMENT_MAX, section: "preparation" },
  { key: "warnings", kind: "textarea", max: COMMUNITY_ROUTE_WARNINGS_MAX, section: "safety" },
  { key: "conditions_notes", kind: "textarea", max: COMMUNITY_ROUTE_CONDITIONS_NOTES_MAX, section: "conditions" },
];
const labelKey: Record<keyof CommunityRouteContent, string> = {
  title: "editTitle", summary: "summary", description: "description", start_location: "startLocation",
  route_type: "routeType", difficulty_system: "difficultySystem", difficulty_value: "difficultyValue",
  best_season: "bestSeason", equipment: "equipment", warnings: "warnings", conditions_notes: "conditionsNotes",
};

export default function CommunityRouteEditor({ routeId, initial }: { routeId: string; initial: CommunityRouteContent }) {
  const t = useTranslations("Mountain.CommunityRoutes");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  function change(key: keyof CommunityRouteContent, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }
  async function save() {
    setSaving(true); setMessage("");
    const response = await fetch(`/api/mountain-community-routes/${routeId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    const result = await response.json() as { error?: string };
    setSaving(false);
    if (!response.ok) {
      const key = result.error === "required" ? "required" : result.error === "too_long" ? "tooLong" : result.error === "invalid_route_type" ? "invalidRouteType" : null;
      setMessage(key ? t(`validation.${key}`) : t("saveFailed"));
      return;
    }
    setMessage(t("saved")); setEditing(false); router.refresh();
  }
  if (!editing) return <div><button type="button" onClick={() => setEditing(true)} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold">{t("editRoute")}</button>{message && <p role="status" className="mt-2 text-sm text-[var(--color-success)]">{message}</p>}</div>;
  return <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="mt-8 space-y-6 border-y border-[var(--color-border-strong)] py-6">
    {fields.map((field, index) => {
      const section = index === 0 || fields[index - 1].section !== field.section ? field.section : null;
      const value = String(values[field.key] ?? "");
      return <div key={field.key}>{section && <h2 className="mb-4 text-xl font-bold">{t(`sections.${section}`)}</h2>}<label className="block text-sm font-bold" htmlFor={`community-${field.key}`}>{t(labelKey[field.key])}</label>
        {field.kind === "textarea" ? <textarea id={`community-${field.key}`} value={value} maxLength={field.max} rows={field.max > 1000 ? 7 : 3} onChange={(event) => change(field.key, event.target.value)} className="ui-field mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" /> : <input id={`community-${field.key}`} value={value} maxLength={field.max} required={field.key === "title"} onChange={(event) => change(field.key, event.target.value)} className="ui-field mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3" />}
        {(["title", "summary", "description"] as string[]).includes(field.key) && <p className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{t("characterCount", { count: value.length, max: field.max })}</p>}
      </div>;
    })}
    <div><label className="block text-sm font-bold" htmlFor="community-route-type">{t("routeType")}</label><select id="community-route-type" value={values.route_type ?? ""} onChange={(event) => change("route_type", event.target.value)} className="ui-field mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"><option value="">—</option>{["hiking","mountaineering","via_ferrata","climbing","ski_touring","mixed","other"].map((type) => <option key={type} value={type}>{t(`routeTypes.${type === "via_ferrata" ? "viaFerrata" : type === "ski_touring" ? "skiTouring" : type}`)}</option>)}</select></div>
    {message && <p role="alert" className="text-sm text-[var(--color-danger)]">{message}</p>}
    <div className="flex gap-3"><button type="button" disabled={saving} onClick={() => { setValues(initial); setEditing(false); setMessage(""); }} className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] px-4 font-bold">{t("cancel")}</button><button type="submit" disabled={saving} className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 font-bold text-white disabled:opacity-60">{saving ? t("saving") : t("saveChanges")}</button></div>
  </form>;
}
