"use client";

import { Printer } from "lucide-react";

export default function ProjectReportPrintButton({ label }: { label: string }) {
  return <button type="button" onClick={() => window.print()} className="project-report-control ui-pressable inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-4 font-bold text-[var(--color-text-inverse)]"><Printer aria-hidden="true" size={17}/>{label}</button>;
}
