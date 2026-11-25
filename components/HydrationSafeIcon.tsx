"use client";

import { useEffect, useState, type ComponentType } from "react";

type IconProps = {
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
};

type HydrationSafeIconProps = {
  icon: ComponentType<IconProps>;
  size?: number;
  strokeWidth?: number;
  className?: string;
  ariaHidden?: boolean;
  ariaLabel?: string;
};

/**
 * Renders a stable placeholder on SSR + first client render, then the real
 * Lucide icon after mount. Prevents extension SVG d="" rewrites (AdGuard etc.)
 * from causing hydration mismatches in persistent UI (Header).
 * Preserves layout via fixed width/height span to avoid CLS.
 */
export default function HydrationSafeIcon({
  icon: Icon,
  size = 18,
  strokeWidth = 2,
  className,
  ariaHidden = true,
  ariaLabel,
}: HydrationSafeIconProps) {
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional mount placeholder to avoid extension SVG mutation
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <span
        aria-hidden={ariaHidden}
        aria-label={ariaLabel}
        style={{ width: size, height: size }}
        className={className ? `inline-block shrink-0 ${className}` : "inline-block shrink-0"}
      />
    );
  }
  return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-hidden={ariaHidden} aria-label={ariaLabel} />;
}
