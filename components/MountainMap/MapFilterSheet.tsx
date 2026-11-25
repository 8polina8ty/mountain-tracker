import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { Map } from "maplibre-gl";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import MapFilterFields, { type MapFilterKind } from "./MapFilterFields";
import {
  DEFAULT_MAP_FILTERS,
  filterMountainsInView,
  createFilterDraft,
  validateFilterDraft,
} from "./mountainFilters";
import type { MountainMapFilters, PeakFeatureCollection } from "./types";

type MapFilterSheetProps = {
  kind: MapFilterKind;
  mobile: boolean;
  trigger: HTMLButtonElement;
  left: number;
  maxHeight: number;
  appliedFilters: MountainMapFilters;
  appliedSearch: string;
  climbedMountainIds: Set<number>;
  mapRef: RefObject<Map | null>;
  originalGeoJsonRef: RefObject<PeakFeatureCollection | null>;
  mountainDataVersion: number;
  onApply: (filters: MountainMapFilters) => void;
  onClose: () => void;
};

export default function MapFilterSheet({
  kind, mobile, trigger, left, maxHeight, appliedFilters, appliedSearch, climbedMountainIds, mapRef,
  originalGeoJsonRef, mountainDataVersion, onApply, onClose,
}: MapFilterSheetProps) {
  const t = useTranslations("Map.Filter");
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLFormElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  // The sheet mounts on opening, so Cancel always discards this independent draft.
  const [draft, setDraft] = useState(() => createFilterDraft(appliedFilters));
  const [touched, setTouched] = useState(false);
  const validation = useMemo(() => validateFilterDraft(draft), [draft]);
  const validFilters = validation.filters;
  const error = touched && validation.error ? t(validation.error) : null;
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (mobile) dialog?.showModal();
    contentRef.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      const active = document.activeElement;
      if (trigger.isConnected && !(active instanceof HTMLElement && active !== trigger && active.hasAttribute("data-map-filter-trigger"))) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [mobile, trigger]);

  useEffect(() => {
    if (!present) return;
    const onPointerDown = (event: PointerEvent) => {
      if (mobile || !(event.target instanceof Element)) return;
      if (!panelRef.current?.contains(event.target) && !event.target.closest("[data-map-filter-trigger]")) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    const breakpoint = window.matchMedia("(min-width: 640px)");
    const onResize = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    breakpoint.addEventListener("change", onResize);
    if (!mobile) window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      breakpoint.removeEventListener("change", onResize);
    };
  }, [mobile, onClose, present]);

  useEffect(() => {
    const map = mapRef.current;
    const updateCount = () => {
      const original = originalGeoJsonRef.current;
      if (!map || !original || !validFilters) {
        setCount(validFilters ? 0 : null);
        return;
      }
      const bounds = map.getBounds();
      setCount(filterMountainsInView(original, {
        west: bounds.getWest(), south: bounds.getSouth(),
        east: bounds.getEast(), north: bounds.getNorth(),
      }, validFilters, climbedMountainIds, appliedSearch).features.length);
    };
    updateCount();
    map?.on("moveend", updateCount);
    return () => { map?.off("moveend", updateCount); };
  }, [validFilters, appliedSearch, climbedMountainIds, mapRef, originalGeoJsonRef, mountainDataVersion]);

  const title = t(kind === "height" ? "height" : kind === "status" ? "status" : "title");
  const content = (
    <form ref={contentRef} noValidate className="flex min-h-0 flex-1 flex-col overflow-hidden"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        const result = validateFilterDraft(draft);
        if (result.filters) onApply(result.filters);
      }}>
      {mobile && <div className="mx-auto mt-3 h-1 w-11 shrink-0 rounded-full bg-[var(--color-border-strong)]" aria-hidden="true" />}
      <header className={`flex shrink-0 items-center justify-between gap-3 ${mobile ? "h-16 px-5" : "mb-3"}`}>
        <h2 id={`${id}-title`} className={mobile ? "text-[26px] font-bold" : "text-lg font-bold"}>{title}</h2>
        <button type="button" onClick={onClose} aria-label={t("close")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-[var(--color-surface-muted)]">
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className={`min-h-0 overflow-y-auto overscroll-contain ${mobile ? "px-5 pb-7" : "pb-4"}`}>
        <MapFilterFields id={id} kind={kind} mobile={mobile} draft={draft} setDraft={setDraft}
          error={error} onBlur={() => setTouched(true)} />
      </div>
      <footer className={`sticky bottom-0 shrink-0 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] ${mobile ? "px-5 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]" : "pt-3"}`}>
        <p className="mb-2 text-xs text-[var(--color-text-secondary)]" aria-live="polite" aria-atomic="true">
          {count === null ? "?" : t("mountainsInView", { count })}
        </p>
        <div className="grid grid-cols-[42fr_58fr] gap-2">
          <button type="button" onClick={() => { setDraft(createFilterDraft(DEFAULT_MAP_FILTERS)); setTouched(false); }}
            className={`${mobile ? "h-[52px]" : "h-11"} rounded-xl bg-[var(--color-bg-secondary)] px-2 text-sm font-semibold hover:bg-[var(--color-bg-terrain)]`}>
            {t("reset")}
          </button>
          <button type="submit" disabled={!validFilters}
            className={`${mobile ? "h-[52px]" : "h-11"} rounded-xl bg-[var(--color-forest)] px-2 text-sm font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] disabled:cursor-not-allowed disabled:opacity-50`}>
            {t("apply")}
          </button>
        </div>
      </footer>
    </form>
  );

  if (!mobile) {
    return (
      <motion.div ref={panelRef} role="dialog" aria-labelledby={`${id}-title`} style={{ left, maxHeight, width: kind === "status" ? 278 : 320 }}
        initial={{ opacity: 0, y: reducedMotion ? 0 : -4 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }} transition={{ duration: reducedMotion ? 0 : 0.16, ease: "easeOut" }}
        className="absolute top-[calc(100%+8px)] z-30 flex flex-col overflow-hidden rounded-[20px] border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 text-[var(--color-text)] shadow-[var(--shadow-panel)]">
        {content}
      </motion.div>
    );
  }

  return (
    <dialog ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-[var(--color-text)] backdrop:bg-[color-mix(in_srgb,var(--color-surface-inverse)_20%,transparent)]"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <motion.div initial={{ y: reducedMotion ? 0 : "100%" }} animate={{ y: 0 }}
        exit={{ y: reducedMotion ? 0 : "100%" }} transition={{ duration: reducedMotion ? 0 : 0.22 }}
        className="absolute inset-x-0 bottom-0 flex max-h-[82dvh] flex-col overflow-hidden rounded-t-[var(--radius-sheet)] border border-[var(--color-border-soft)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)]">
        {content}
      </motion.div>
    </dialog>
  );
}
