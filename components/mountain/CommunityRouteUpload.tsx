"use client";

import { FileUp, Route } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { createClient } from "@/Lib/supabase/client";
import { importGpxActivity } from "@/Lib/tracks/importGpxActivity";
import { Link, useRouter } from "@/i18n/navigation";

type UploadState = "idle" | "importing" | "publishing" | "published" | "failed";

export default function CommunityRouteUpload({ mountainId, mountainName, authenticated }: { mountainId: number; mountainName: string; authenticated: boolean }) {
  const t = useTranslations("Mountain.CommunityRoutes");
  const format = useFormatter();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [message, setMessage] = useState("");

  if (!authenticated) {
    return <Link href="/auth/login" className="ui-pressable inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-bold hover:bg-[var(--color-surface-muted)]">{t("loginToUpload")}</Link>;
  }

  async function upload(file: File) {
    setState("importing");
    setMessage(t("states.parsing"));
    const supabase = createClient();
    const imported = await importGpxActivity({ supabase, file, source: "other" });
    if (!imported.ok) {
      setState("failed");
      setMessage(t(imported.reason === "validation" ? "errors.gpxOnly" : "errors.importFailed"));
      return;
    }
    if (imported.detectedMountain && imported.detectedMountain.mountainId !== mountainId) {
      setState("failed");
      setMessage(t("errors.wrongMountain", { target: mountainName, detected: imported.detectedMountain.mountainName }));
      return;
    }
    setState("publishing");
    setMessage(t("states.publishing"));
    const response = await fetch("/api/mountain-community-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gpsActivityId: imported.gpsActivityId, targetMountainId: mountainId, title: file.name.replace(/\.gpx$/i, "") }),
    });
    const payload = await response.json() as { error?: string; validation?: { mountainName?: string; distanceM?: number; confidence?: number } };
    if (!response.ok) {
      setState("failed");
      const error = payload.error ?? "publish_failed";
      if (error === "wrong_mountain") setMessage(t("errors.wrongMountain", { target: mountainName, detected: payload.validation?.mountainName ?? t("unknownMountain") }));
      else if (["ambiguous", "too_far", "low_confidence", "mountain_coordinates_missing", "not_found"].includes(error)) setMessage(t(`errors.${error}`));
      else setMessage(t("errors.publishFailed"));
      return;
    }
    setState("published");
    setMessage(t("published", {
      mountain: mountainName,
      distance: format.number(payload.validation?.distanceM ?? 0),
      confidence: format.number((payload.validation?.confidence ?? 0) * 100, { maximumFractionDigits: 0 }),
    }));
    router.refresh();
  }

  const busy = state === "importing" || state === "publishing";
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <input ref={inputRef} type="file" accept=".gpx,application/gpx+xml" disabled={busy} className="sr-only" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file);
      }} />
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] px-4 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60">
        {busy ? <Route aria-hidden="true" size={17} /> : <FileUp aria-hidden="true" size={17} />}
        {busy ? t(`states.${state}`) : t("upload")}
      </button>
      {message && <p role="status" className="max-w-md text-sm text-[var(--color-text-muted)] sm:text-right">{message}</p>}
    </div>
  );
}
