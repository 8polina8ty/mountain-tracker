"use client";

import { ArrowUpRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import DeleteGpsTrackButton from "@/components/account/DeleteGpsTrackButton";

const standardEasing = [0.2, 0, 0, 1] as const;

export type GpsTrackListItem = {
  id: number;
  title: string;
  sourceLabel: string;
  dateLabel: string;
  statusLabel: string;
  statusTone: "success" | "danger" | "warning";
  distanceLabel: string;
  durationLabel: string;
  elevationGainLabel: string;
  maximumElevationLabel: string;
  canOpen: boolean;
  originalFilePath: string | null;
  geoJsonFilePath: string | null;
};

type GpsTrackListProps = {
  items: GpsTrackListItem[];
};

export default function GpsTrackList({ items }: GpsTrackListProps) {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();
  const listRef = useRef<HTMLElement | null>(null);
  const pendingFocusItemIdRef = useRef<number | null>(null);
  const [removedItemIds, setRemovedItemIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [announcement, setAnnouncement] = useState("");

  const visibleItems = items.filter((item) => !removedItemIds.has(item.id));

  function handleDeleted(activityId: number, activityTitle: string) {
    const deletedIndex = visibleItems.findIndex(
      (item) => item.id === activityId,
    );
    const focusItem =
      visibleItems[deletedIndex + 1] ?? visibleItems[deletedIndex - 1];

    pendingFocusItemIdRef.current = focusItem?.id ?? null;
    setAnnouncement(`GPS-трек «${activityTitle}» удалён.`);

    setRemovedItemIds((currentIds) => {
      const nextIds = new Set(currentIds);
      nextIds.add(activityId);
      return nextIds;
    });
  }

  function handleExitComplete() {
    const focusItemId = pendingFocusItemIdRef.current;
    const row =
      focusItemId !== null
        ? listRef.current?.querySelector<HTMLElement>(
            `[data-track-id="${focusItemId}"]`,
          )
        : null;
    const focusTarget =
      row?.querySelector<HTMLElement>("a[href], button:not(:disabled)") ??
      document.querySelector<HTMLElement>("[data-track-import-action]") ??
      listRef.current;

    focusTarget?.focus();
    pendingFocusItemIdRef.current = null;
    router.refresh();
  }

  return (
    <section
      ref={listRef}
      tabIndex={-1}
      className="overflow-x-clip border-t border-[var(--color-border-strong)] outline-none"
      aria-label="Список GPS-треков"
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <AnimatePresence
        initial={false}
        onExitComplete={handleExitComplete}
      >
        {visibleItems.map((item) => (
          <motion.article
            key={item.id}
            layout="position"
            exit={{
              opacity: 0,
              x: shouldReduceMotion ? 0 : 64,
              transition: {
                duration: shouldReduceMotion ? 0 : 0.24,
                ease: standardEasing,
              },
            }}
            transition={{
              layout: {
                duration: shouldReduceMotion ? 0 : 0.22,
                ease: standardEasing,
              },
            }}
            data-track-id={item.id}
            className="border-b border-[var(--color-border)] py-6"
          >
            <div className="grid gap-5 lg:grid-cols-[minmax(220px,1.1fr)_minmax(360px,1.5fr)_180px] lg:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={[
                      "[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em]",
                      item.statusTone === "success"
                        ? "text-[var(--color-success)]"
                        : item.statusTone === "danger"
                          ? "text-[var(--color-danger)]"
                          : "text-[var(--color-warning)]",
                    ].join(" ")}
                  >
                    {item.statusLabel}
                  </span>

                  <span className="text-sm text-[var(--color-text-muted)]">
                    {item.sourceLabel}
                  </span>
                </div>

                <h2 className="mt-2 break-words text-2xl font-bold text-[var(--color-text)]">
                  {item.title}
                </h2>

                <p className="mt-1 [font-family:var(--font-technical)] text-xs text-[var(--color-text-muted)]">
                  {item.dateLabel}
                </p>
              </div>

              <dl className="grid grid-cols-2 border-y border-[var(--color-border-soft)] sm:grid-cols-4 sm:border-y-0">
                <TrackValue label="Расстояние" value={item.distanceLabel} />
                <TrackValue label="Время" value={item.durationLabel} />
                <TrackValue label="Набор" value={item.elevationGainLabel} />
                <TrackValue
                  label="Макс. высота"
                  value={item.maximumElevationLabel}
                />
              </dl>

              <div className="flex shrink-0 flex-col gap-2">
                {item.canOpen ? (
                  <Link
                    href={`/account/tracks/${item.id}`}
                    className="ui-pressable group inline-flex min-h-11 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-text)] hover:border-[var(--color-track)] hover:text-[var(--color-track)]"
                  >
                    Открыть маршрут
                    <ArrowUpRight
                      aria-hidden="true"
                      className="h-4 w-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    />
                  </Link>
                ) : (
                  <span className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-4 py-2 text-sm font-semibold text-[var(--color-text-disabled)]">
                    Карта недоступна
                  </span>
                )}

                <DeleteGpsTrackButton
                  activityId={item.id}
                  activityTitle={item.title}
                  originalFilePath={item.originalFilePath}
                  geoJsonFilePath={item.geoJsonFilePath}
                  onDeleted={() => handleDeleted(item.id, item.title)}
                />
              </div>
            </div>
          </motion.article>
        ))}
      </AnimatePresence>
    </section>
  );
}

type TrackValueProps = {
  label: string;
  value: string;
};

function TrackValue({ label, value }: TrackValueProps) {
  return (
    <div className="min-w-0 border-r border-[var(--color-border-soft)] px-3 py-3 first:pl-0 last:border-r-0 sm:py-1">
      <dt className="[font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
        {label}
      </dt>

      <dd className="mt-1 break-words [font-family:var(--font-technical)] text-sm font-bold tabular-nums text-[var(--color-text)]">
        {value}
      </dd>
    </div>
  );
}
