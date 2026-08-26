"use client";

import Image from "next/image";
import type { LucideIcon, LucideProps } from "lucide-react";
import { Mountain } from "lucide-react";
import type { ReactNode } from "react";

/* ========================================
   MOUNTAIN TRACKER V2 — DESIGN SYSTEM
   ======================================== */

/* Typography */

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-pine)] ${className}`}>
      {children}
    </p>
  );
}

export function MutedLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`technical text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] ${className}`}>
      {children}
    </p>
  );
}

/* Headings */

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div className="max-w-2xl">
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h2 className="text-[28px] font-bold tracking-tight leading-tight">{title}</h2>
        {description && (
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function SectionHeader(props: { eyebrow?: string; title: string; description?: string; action?: ReactNode; className?: string }) {
  return <SectionHeading {...props} />;
}

/* Metrics */

export function Metric({
  label,
  value,
  detail,
  icon: Icon,
  size = "default",
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon?: LucideIcon;
  size?: "default" | "large";
}) {
  return (
    <div className="min-w-0 px-5 py-5 first:pl-0 last:pr-0">
      <dt className="technical flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {Icon && <Icon size={14} strokeWidth={2} />} {label}
      </dt>
      <dd className={`mt-2 break-words font-bold tracking-tight ${size === "large" ? "text-[32px]" : "text-[24px]"} technical tabular-nums`}>
        {value}
      </dd>
      {detail && <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{detail}</p>}
    </div>
  );
}

export function MetricRow({ metrics }: { metrics: { label: string; value: string; icon?: LucideIcon }[] }) {
  return (
    <dl className="metric-grid grid border-y border-[var(--color-border-soft)] bg-[var(--color-surface-muted)]/50 sm:grid-cols-2 lg:grid-cols-4">
      {metrics.map((m) => (
        <Metric key={m.label} label={m.label} value={m.value} icon={m.icon} />
      ))}
    </dl>
  );
}

/* Status Pills */

export function StatusPill({
  children,
  tone = "neutral",
  size = "default",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "info" | "danger";
  size?: "default" | "small";
}) {
  const toneStyles = {
    success: "bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]/20",
    warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/20",
    info: "bg-[var(--color-info-soft)] text-[var(--color-info)] border-[var(--color-info)]/20",
    danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger)]/20",
    neutral: "bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] border-[var(--color-border)]",
  };

  const sizeStyles = {
    default: "min-h-[28px] px-3 text-[12px]",
    small: "min-h-[24px] px-2.5 text-[11px]",
  };

  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-pill)] border font-semibold ${toneStyles[tone]} ${sizeStyles[size]}`}
    >
      {children}
    </span>
  );
}

/* Buttons */

export function PrimaryButton({
  children,
  icon: Icon,
  className = "",
  size = "default",
  type = "button",
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  className?: string;
  size?: "default" | "small" | "large";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const sizeStyles = {
    small: "min-h-[40px] px-4 text-[13px]",
    default: "min-h-[44px] px-5 text-[14px]",
    large: "min-h-[52px] px-6 text-[15px]",
  };

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`ui-pressable inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-pine)] font-semibold text-[var(--color-text-inverse)] shadow-[var(--shadow-control)] hover:bg-[var(--color-pine-hover)] disabled:opacity-50 disabled:cursor-not-allowed ${sizeStyles[size]} ${className}`}
    >
      {Icon && <Icon size={size === "large" ? 20 : size === "small" ? 16 : 18} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  icon: Icon,
  className = "",
  size = "default",
  type = "button",
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  className?: string;
  size?: "default" | "small" | "large";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: () => void;
}) {
  const sizeStyles = {
    small: "min-h-[40px] px-4 text-[13px]",
    default: "min-h-[44px] px-5 text-[14px]",
    large: "min-h-[52px] px-6 text-[15px]",
  };

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`ui-pressable inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 disabled:cursor-not-allowed ${sizeStyles[size]} ${className}`}
    >
      {Icon && <Icon size={size === "large" ? 20 : size === "small" ? 16 : 18} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  icon: Icon,
  className = "",
  onClick,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ui-pressable inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 min-h-[44px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] ${className}`}
    >
      {Icon && <Icon size={18} strokeWidth={2} />}
      {children}
    </button>
  );
}

/* Form Fields */

export function Field({
  label,
  placeholder,
  value,
  type = "text",
}: {
  label: string;
  placeholder?: string;
  value?: string;
  type?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-[14px] font-semibold">{label}</span>
      <input className="ui-field w-full px-4" type={type} placeholder={placeholder} defaultValue={value} />
    </label>
  );
}

/* Avatars */

export function Avatar({
  initials,
  size = "md",
  src,
}: {
  initials: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  src?: string;
}) {
  const sizeStyles = {
    xs: "h-7 w-7 text-[10px]",
    sm: "h-9 w-9 text-[11px]",
    md: "h-11 w-11 text-[13px]",
    lg: "h-14 w-14 text-[15px]",
    xl: "h-20 w-20 text-[20px]",
  };

  if (src) {
    return (
      <span className={`relative block ${sizeStyles[size]} shrink-0 overflow-hidden rounded-full`}>
        <Image
          src={src}
          alt={initials}
          fill
          className="object-cover"
          sizes="48px"
        />
      </span>
    );
  }

  return (
    <span
      className={`grid ${sizeStyles[size]} shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-pine)] to-[var(--color-forest-light)] font-bold text-white`}
    >
      {initials}
    </span>
  );
}

/* Icon Badge */

export function IconBadge({ icon: Icon, ...props }: { icon: LucideIcon } & LucideProps) {
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-pine)] shadow-[var(--shadow-xs)]">
      <Icon size={20} strokeWidth={2} {...props} />
    </span>
  );
}

/* Cards */

export function Card({
  children,
  className = "",
  active = false,
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  active?: boolean;
  hover?: boolean;
}) {
  return (
    <article
      className={`rounded-[var(--radius-card)] border bg-[var(--color-surface)] shadow-[var(--shadow-xs)] ${
        active ? "border-[var(--color-pine)]" : "border-[var(--color-border-soft)]"
      } ${hover ? "ui-pressable hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-card)]" : ""} ${className}`}
    >
      {children}
    </article>
  );
}

/* Tabs */

export function Tabs({ items, activeIndex = 0 }: { items: string[]; activeIndex?: number }) {
  return (
    <nav className="flex gap-1 overflow-x-auto pb-1" aria-label="Sections">
      {items.map((item, index) => (
        <button
          key={item}
          className={`ui-pressable min-h-[44px] whitespace-nowrap rounded-[var(--radius-control)] px-4 text-[14px] font-semibold transition-colors ${
            index === activeIndex
              ? "bg-[var(--color-surface-muted)] text-[var(--color-text)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]/50"
          }`}
        >
          {item}
        </button>
      ))}
    </nav>
  );
}

/* Alert */

export function Alert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const toneStyles = {
    success: "border-[var(--color-success)] bg-[var(--color-success-soft)]",
    warning: "border-[var(--color-warning)] bg-[var(--color-warning-soft)]",
    danger: "border-[var(--color-danger)] bg-[var(--color-danger-soft)]",
    info: "border-[var(--color-info)] bg-[var(--color-info-soft)]",
  };

  return (
    <div className={`flex items-start gap-4 rounded-[var(--radius-card)] border-l-4 ${toneStyles[tone]} p-4`}>
      <div className="min-w-0 flex-1">
        {title && <p className="text-[14px] font-semibold">{title}</p>}
        <div className={`${title ? "mt-1" : ""} text-[14px] leading-relaxed text-[var(--color-text-secondary)]`}>
          {children}
        </div>
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

/* Empty State */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-10 text-center sm:p-14">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-pine)]">
        <Icon size={28} strokeWidth={1.5} />
      </div>
      <h3 className="mt-5 text-[20px] font-bold">{title}</h3>
      {description && (
        <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-text-muted)]">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/* Page Header */

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-4">
        <div>
          {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
          <h1 className="text-[28px] font-bold tracking-tight">{title}</h1>
        </div>
        {description && (
          <p className="max-w-xl text-[14px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
        )}
        {action}
      </div>
    </header>
  );
}

/* Page Hero */

export function PageHero({
  title,
  subtitle,
  eyebrow,
  image,
  children,
  size = "default",
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  image?: string;
  children?: ReactNode;
  size?: "default" | "large" | "cinematic";
}) {
  const heightStyles = {
    default: image ? "min-h-[320px] sm:min-h-[400px]" : "",
    large: image ? "min-h-[400px] sm:min-h-[500px]" : "",
    cinematic: image ? "min-h-[500px] sm:min-h-[600px]" : "",
  };

  return (
    <header className="relative overflow-hidden rounded-[var(--radius-panel)] shadow-[var(--shadow-card)]">
      {image ? (
        <div className={`relative ${heightStyles[size]}`}>
          <Image src={image} alt="" fill className="absolute inset-0 h-full w-full object-cover" priority />
          <div className="absolute inset-0 hero-overlay" />
          <div className={`relative flex flex-col justify-end p-6 sm:p-8 lg:p-12 text-white ${heightStyles[size]}`}>
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/70">{eyebrow}</p>
            )}
            <h1 className="mt-3 text-[40px] font-bold tracking-tight sm:text-[52px] lg:text-[64px]">{title}</h1>
            {subtitle && (
              <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-white/85 sm:text-[18px]">{subtitle}</p>
            )}
            {children && <div className="mt-6">{children}</div>}
          </div>
        </div>
      ) : (
        <div className="bg-gradient-to-br from-[var(--color-bg-secondary)] to-[var(--color-bg)] p-6 sm:p-8 lg:p-12">
          {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
          <h1 className="text-[40px] font-bold tracking-tight sm:text-[52px]">{title}</h1>
          {subtitle && (
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-[var(--color-text-muted)] sm:text-[18px]">
              {subtitle}
            </p>
          )}
          {children && <div className="mt-6">{children}</div>}
        </div>
      )}
    </header>
  );
}

/* Mountain Visual (Decorative) */

export function MountainVisual({
  label = "Alpine terrain",
  compact = false,
  className = "",
}: {
  label?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden bg-[var(--color-bg-terrain)] ${compact ? "aspect-[16/8]" : "min-h-64"} ${className}`}
      role="img"
      aria-label={label}
    >
      <div className="absolute inset-0 bg-[linear-gradient(150deg,transparent_0_35%,color-mix(in_srgb,var(--color-granite)_22%,transparent)_36%_45%,transparent_46%),linear-gradient(25deg,transparent_0_42%,color-mix(in_srgb,var(--color-pine)_20%,transparent)_43%_54%,transparent_55%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-[linear-gradient(to_top,color-mix(in_srgb,var(--color-surface-inverse)_35%,transparent),transparent)]" />
      <Mountain className="absolute bottom-5 right-6 text-[var(--color-granite)]" size={compact ? 48 : 84} strokeWidth={1.15} />
    </div>
  );
}
