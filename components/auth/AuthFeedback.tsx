"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

function Feedback() {
  const params = useSearchParams();
  const t = useTranslations("Country");
  return params.has("authError") ? <p role="alert" className="mt-4 text-sm text-[var(--color-danger)]">{t("oauthError")}</p> : null;
}

export default function AuthFeedback() {
  return <Suspense fallback={null}><Feedback /></Suspense>;
}
