"use client";

import { useState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { removeMountainFromProject } from "@/Lib/projects/mutations";
import type { MountainId } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/client";
import { useRouter } from "@/i18n/navigation";

export default function ProjectMountainActions({ projectId, mountainId, mountainName }: { projectId: string; mountainId: MountainId; mountainName: string }) {
  const t = useTranslations("Projects.Mutations");
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function remove() {
    if (removing || !window.confirm(t("removeMountainConfirm", { name: mountainName }))) return;
    setRemoving(true);
    setFailed(false);
    const result = await removeMountainFromProject(createClient(), projectId, mountainId);
    setRemoving(false);
    if (!result.ok || !result.data) { setFailed(true); return; }
    router.refresh();
  }

  return (
    <span className="flex shrink-0 flex-col items-end">
      <button type="button" disabled={removing} onClick={() => void remove()} aria-label={t("removeMountainAria", { name: mountainName })} className="ui-pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:cursor-wait disabled:opacity-60">
        {removing ? <LoaderCircle aria-hidden="true" className="animate-spin" size={18} /> : <Trash2 aria-hidden="true" size={18} />}
      </button>
      {failed && <span role="alert" className="max-w-52 text-right text-xs text-[var(--color-danger)]">{t("removeMountainError")}</span>}
    </span>
  );
}
