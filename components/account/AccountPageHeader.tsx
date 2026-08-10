import type { ReactNode } from "react";

type AccountPageHeaderProps = {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
  metric?: {
    label: string;
    value: string | number;
  };
};

export default function AccountPageHeader({
  eyebrow,
  title,
  description,
  actions,
  metric,
}: AccountPageHeaderProps) {
  return (
    <header className="border-b border-[var(--color-border-strong)] py-8 sm:py-10">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.1em] text-[var(--color-forest)]">
            {eyebrow}
          </p>
          <h1 className="mt-3 break-words text-4xl font-bold leading-tight text-[var(--color-text)] sm:text-5xl">
            {title}
          </h1>
          <p className="mt-3 max-w-2xl text-[var(--color-text-secondary)]">
            {description}
          </p>
        </div>

        {(actions || metric) && (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            {metric && (
              <div className="min-w-32 border-l-2 border-[var(--color-forest)] pl-4">
                <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
                  {metric.label}
                </p>
                <p className="mt-1 [font-family:var(--font-technical)] text-3xl font-bold tabular-nums text-[var(--color-text)]">
                  {metric.value}
                </p>
              </div>
            )}
            {actions && (
              <div className="flex flex-wrap gap-2">{actions}</div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
