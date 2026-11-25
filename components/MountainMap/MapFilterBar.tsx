import { useCallback, useRef, useState, type ComponentProps } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import MapFilterSheet from "./MapFilterSheet";
import type { MapFilterKind } from "./MapFilterFields";
import { activeFilterCount, hasCustomHeight } from "./mountainFilters";

type Props = Omit<ComponentProps<typeof MapFilterSheet>, "onClose" | "kind" | "mobile" | "trigger" | "left" | "maxHeight">;

export default function MapFilterBar(props: Props) {
  const t = useTranslations("Map.Filter");
  const barRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(0);
  const [open, setOpen] = useState<{
    kind: MapFilterKind; mobile: boolean; trigger: HTMLButtonElement; left: number; maxHeight: number; session: number;
  } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const count = activeFilterCount(props.appliedFilters);

  return (
    <div ref={barRef} className="relative mt-3 w-fit max-w-full lg:mt-0 lg:max-w-[min(460px,calc(100vw-420px))]">
      <div className="flex flex-wrap gap-[10px] lg:flex-nowrap lg:justify-center">
        {(["all", "height", "status"] as const).map((kind) => {
          const active = kind === "all" ? count > 0 : kind === "height"
            ? hasCustomHeight(props.appliedFilters) : props.appliedFilters.ascentStatus !== "all";
          const label = kind === "all" ? t("title") : kind === "height"
            ? (hasCustomHeight(props.appliedFilters)
              ? t("presetRange", { min: props.appliedFilters.minHeight, max: props.appliedFilters.maxHeight }) : t("height"))
            : (props.appliedFilters.ascentStatus === "all" ? t("status") : t(props.appliedFilters.ascentStatus));
          return (
            <button key={kind} type="button" data-map-filter-trigger
              aria-haspopup="dialog" aria-expanded={open?.kind === kind}
              aria-label={kind === "all" ? t("activeFilters", { count }) : undefined}
              onClick={(event) => {
                if (open?.kind === kind) { close(); return; }
                const trigger = event.currentTarget;
                const mobile = !window.matchMedia("(min-width: 640px)").matches;
                const barBounds = barRef.current?.getBoundingClientRect();
                const barLeft = barBounds?.left ?? 0;
                const width = kind === "status" ? 280 : 320;
                setOpen({
                  kind, mobile, trigger, session: ++sessionRef.current,
                  left: Math.max(0, Math.min(trigger.offsetLeft, window.innerWidth - barLeft - width - 12)),
                  maxHeight: Math.max(180, window.innerHeight - (barBounds?.bottom ?? 0) - 20),
                });
              }}
              className={`${kind === "all" ? "flex" : "hidden sm:flex"} h-[48px] shrink-0 items-center gap-2 rounded-[18px] border px-[18px] text-[14px] font-semibold leading-none shadow-[var(--shadow-xs)] transition-[background-color,border-color,box-shadow,transform] duration-[var(--duration-fast)] ${active
                ? "border-[var(--color-forest)] bg-[var(--color-forest)] text-white shadow-[var(--shadow-sm)]"
                : "border-[var(--color-border-soft)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-sm)] hover:-translate-y-[1px]"}`}>
              {kind === "all" && <SlidersHorizontal size={18} aria-hidden="true" className={active ? "text-white" : "text-[var(--color-text-muted)]"} />}
              {label}
              {kind !== "all" && <ChevronDown size={16} aria-hidden="true" className={active ? "text-white/90" : "text-[var(--color-text-muted)]"} />}
              {kind === "all" && count > 0 && <span aria-hidden="true" className="flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[11px] font-bold leading-none text-[var(--color-forest)] shadow-[var(--shadow-xs)]">{count}</span>}
            </button>
          );
        })}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {open && <MapFilterSheet key={open.session} {...props} {...open} onClose={close}
          onApply={(filters) => { props.onApply(filters); close(); }} />}
      </AnimatePresence>
    </div>
  );
}
