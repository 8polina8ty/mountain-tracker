"use client";

import { Link, useRouter } from "@/i18n/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { createClient } from "@/Lib/supabase/client";
import { useFormatter, useTranslations } from "next-intl";

const standardEasing = [0.2, 0, 0, 1] as const;

type MountainOption = {
  id: number;
  name: string | null;
  name_de: string | null;
  height: number | null;
};

type DetectedMountainSectionProps = {
  activityId: number;
  activityStartedAt: string | null;

  detectedMountain: MountainOption | null;

  detectionDistanceM: number | null;
  detectionConfidence: number | null;
  detectionStatus: string;
  gpsVerified: boolean;
};

function getMountainName(
  mountain: MountainOption,
  fallback: string,
): string {
  return (
    mountain.name_de ??
    mountain.name ??
    fallback
  );
}

function formatConfidence(
  confidence: number | null,
  unavailable: string,
): string {
  if (confidence === null) {
    return unavailable;
  }

  return `${Math.round(confidence * 100)} %`;
}

export default function DetectedMountainSection({
  activityId,
  activityStartedAt,
  detectedMountain,
  detectionDistanceM,
  detectionConfidence,
  detectionStatus,
  gpsVerified,
}: DetectedMountainSectionProps) {
  const t = useTranslations("Tracks.Detection");
  const format = useFormatter();
  const router = useRouter();
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [showMountainSearch, setShowMountainSearch] =
    useState(false);

  const [searchInput, setSearchInput] =
    useState("");

  const [searchResults, setSearchResults] =
    useState<MountainOption[]>([]);

  const [searching, setSearching] =
    useState(false);

  const [saving, setSaving] =
    useState(false);

  const [errorMessage, setErrorMessage] =
    useState("");

  function openMountainSearch() {
    setShowMountainSearch(true);
  }

  function closeMountainSearch() {
    setShowMountainSearch(false);
    setSearchInput("");
    setSearchResults([]);
    setSearching(false);

    window.requestAnimationFrame(() => {
      searchTriggerRef.current?.focus();
    });
  }

  function toggleMountainSearch() {
    if (showMountainSearch) {
      closeMountainSearch();
      return;
    }

    openMountainSearch();
  }

  function handleMountainSearchInputChange(value: string) {
    setSearchInput(value);

    if (value.trim().length < 2) {
      setSearchResults([]);
      setSearching(false);
    }
  }

  useEffect(() => {
    if (
      !showMountainSearch ||
      searchInput.trim().length < 2
    ) {
      return;
    }

    const supabase = createClient();
    let cancelled = false;
    const timeoutId = window.setTimeout(
      async () => {
        setSearching(true);
        setErrorMessage("");

        const search =
          searchInput.trim();

        const {
          data,
          error,
        } = await supabase
          .from("mountains")
          .select(`
            id,
            name,
            name_de,
            height
          `)
          .or(
            `name.ilike.%${search}%,name_de.ilike.%${search}%`,
          )
          .order("height", {
            ascending: false,
          })
          .limit(15);

        if (cancelled) {
          return;
        }

        if (error) {
          console.error(
            "Ошибка поиска вершины:",
            error,
          );

          setErrorMessage(
            t("searchFailed"),
          );

          setSearchResults([]);
          setSearching(false);
          return;
        }

        setSearchResults(
          (data ?? []) as MountainOption[],
        );

        setSearching(false);
      },
      350,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [searchInput, showMountainSearch, t]);

  async function saveMountain(
    mountain: MountainOption,
  ) {
    if (saving) {
      return;
    }

    setSaving(true);
    setErrorMessage("");

    try {
      const supabase = createClient();

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        throw userError;
      }

      if (!user) {
        throw new Error(
          t("loginRequired"),
        );
      }

      const climbedAtFromGps =
  activityStartedAt &&
  !Number.isNaN(
    new Date(activityStartedAt).getTime(),
  )
    ? new Date(activityStartedAt)
        .toISOString()
        .slice(0, 10)
    : null;

      const { error: updateError } =
        await supabase
          .from("gps_activities")
          .update({
            mountain_id: mountain.id,

            detected_mountain_id:
              mountain.id,

            detection_status:
              "confirmed",

            gps_verified: true,

            updated_at:
              new Date().toISOString(),
          })
          .eq("id", activityId)
          .eq("user_id", user.id);

      if (updateError) {
        throw updateError;
      }

      /*
 * Проверяем, создавалось ли уже восхождение
 * из этой GPS-активности.
 */
/*
 * Сначала проверяем, связано ли восхождение
 * с этой GPS-активностью.
 */
const {
  data: ascentByGps,
  error: ascentByGpsError,
} = await supabase
  .from("ascents")
  .select("id")
  .eq("gps_activity_id", activityId)
  .maybeSingle();

if (ascentByGpsError) {
  throw ascentByGpsError;
}

/*
 * Затем проверяем, отмечал ли пользователь
 * эту вершину как покорённую раньше.
 */
const {
  data: ascentByMountain,
  error: ascentByMountainError,
} = await supabase
  .from("ascents")
  .select("id")
  .eq("user_id", user.id)
  .eq("mountain_id", mountain.id)
  .maybeSingle();

if (ascentByMountainError) {
  throw ascentByMountainError;
}

const existingAscent =
  ascentByGps ?? ascentByMountain;

if (existingAscent) {
  const { error: ascentUpdateError } =
    await supabase
      .from("ascents")
      .update({
  mountain_id: mountain.id,
  gps_activity_id: activityId,
  gps_verified: true,

  ...(climbedAtFromGps
    ? {
        climbed_at: climbedAtFromGps,
      }
    : {}),
})
      .eq("id", existingAscent.id)
      .eq("user_id", user.id);

  if (ascentUpdateError) {
    throw ascentUpdateError;
  }
} else {
  const { error: ascentInsertError } =
    await supabase
      .from("ascents")
      .insert({
        user_id: user.id,
        mountain_id: mountain.id,
        gps_activity_id: activityId,
        gps_verified: true,
        climbed_at:
        climbedAtFromGps ??
        new Date().toISOString().slice(0, 10),
      });

  if (ascentInsertError) {
    throw ascentInsertError;
  }
}
      closeMountainSearch();

      router.refresh();
    } catch (error) {
      console.error(
        "Ошибка подтверждения вершины:",
        error,
      );

      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function confirmDetectedMountain() {
    if (!detectedMountain) {
      return;
    }

    await saveMountain(detectedMountain);
  }

  async function rejectDetection() {
    if (saving) {
      return;
    }

    setSaving(true);
    setErrorMessage("");

    try {
      const supabase = createClient();

      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        throw userError;
      }

      if (!user) {
        throw new Error(
          t("loginRequired"),
        );
      }

      const { error: updateError } =
        await supabase
          .from("gps_activities")
          .update({
            mountain_id: null,
            detected_mountain_id: null,

            detection_distance_m: null,
            detection_confidence: null,

            detection_status:
              "rejected",

            gps_verified: false,

            updated_at:
              new Date().toISOString(),
          })
          .eq("id", activityId)
          .eq("user_id", user.id);

      if (updateError) {
        throw updateError;
      }

      router.refresh();
    } catch (error) {
      console.error(
        "Ошибка отклонения вершины:",
        error,
      );

      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("rejectFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  if (
    !detectedMountain &&
    detectionStatus !== "rejected"
  ) {
    return (
      <section className="mt-8 border-l-4 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-5 sm:p-6">
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-warning)]">
          {t("sectionLabel")}
        </p>

        <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">
          {t("notDetectedTitle")}
        </h2>

        <p className="mt-2 text-[var(--color-text-secondary)]">
          {t("notDetectedDescription")}
        </p>

        <button
          ref={searchTriggerRef}
          type="button"
          onClick={openMountainSearch}
          aria-expanded={showMountainSearch}
          aria-controls="mountain-search-disclosure"
          className="ui-pressable mt-5 min-h-11 rounded-[var(--radius-control)] bg-[var(--color-warning)] px-5 py-2 font-semibold text-white hover:brightness-90"
        >
          {t("chooseMountain")}
        </button>

        <MountainSearchDisclosure open={showMountainSearch}>
          <MountainSearch
            searchInput={searchInput}
            setSearchInput={handleMountainSearchInputChange}
            searchResults={searchResults}
            searching={searching}
            saving={saving}
            onSelect={saveMountain}
            onClose={closeMountainSearch}
          />
        </MountainSearchDisclosure>

        {errorMessage && (
          <p className="mt-4 text-sm text-[var(--color-danger)]" role="alert">
            {errorMessage}
          </p>
        )}
      </section>
    );
  }

  if (
    !detectedMountain &&
    detectionStatus === "rejected"
  ) {
    return (
      <section className="mt-8 border-l-4 border-[var(--color-granite)] bg-[var(--color-surface-muted)] p-5 sm:p-6">
        <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em] text-[var(--color-text-muted)]">
          {t("sectionLabel")}
        </p>

        <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">
          {t("rejectedTitle")}
        </h2>

        <button
          ref={searchTriggerRef}
          type="button"
          onClick={openMountainSearch}
          aria-expanded={showMountainSearch}
          aria-controls="mountain-search-disclosure"
          className="ui-pressable mt-5 min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2 font-semibold text-[var(--color-forest)] hover:border-[var(--color-forest)]"
        >
          {t("chooseManually")}
        </button>

        <MountainSearchDisclosure open={showMountainSearch}>
          <MountainSearch
            searchInput={searchInput}
            setSearchInput={handleMountainSearchInputChange}
            searchResults={searchResults}
            searching={searching}
            saving={saving}
            onSelect={saveMountain}
            onClose={closeMountainSearch}
          />
        </MountainSearchDisclosure>

        {errorMessage && (
          <p className="mt-4 text-sm text-[var(--color-danger)]" role="alert">
            {errorMessage}
          </p>
        )}
      </section>
    );
  }

  if (!detectedMountain) {
    return null;
  }

  const mountainName =
    getMountainName(detectedMountain, t("mountainFallback", { id: detectedMountain.id }));

  const isConfirmed =
    detectionStatus === "confirmed" &&
    gpsVerified;

  return (
    <section
      className={[
        "mt-8 border-l-4 p-5 sm:p-6",
        isConfirmed
          ? "border-[var(--color-success)] bg-[var(--color-success-soft)]"
          : "border-[var(--color-info)] bg-[var(--color-info-soft)]",
      ].join(" ")}
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p
            className={[
              "[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.075em]",
              isConfirmed
                ? "text-[var(--color-success)]"
                : "text-[var(--color-info)]",
            ].join(" ")}
          >
            {isConfirmed
              ? t("gpsConfirmed")
              : t("detectedTitle")}
          </p>

          <h2 className="mt-2 text-2xl font-bold text-[var(--color-text)]">
            {mountainName}
          </h2>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--color-text-secondary)]">
            {detectedMountain.height !==
              null && (
              <span>
                {t("elevation")}: {" "}
                <strong>
                  {format.number(Math.round(detectedMountain.height))} {t("meterUnit")}
                </strong>
              </span>
            )}

            {detectionDistanceM !== null && (
              <span>
                {t("distanceToTrack")}: {" "}
                <strong>
                  {format.number(Math.round(detectionDistanceM))} {t("meterUnit")}
                </strong>
              </span>
            )}

            <span>
              {t("confidence")}: {" "}
              <strong>
                {formatConfidence(
                  detectionConfidence,
                  t("confidenceUnavailable"),
                )}
              </strong>
            </span>
          </div>

          <Link
            href={`/mountain/${detectedMountain.id}`}
            className="ui-pressable mt-4 inline-flex min-h-11 items-center font-semibold text-[var(--color-forest)] hover:underline"
          >
            {t("openMountain")}
          </Link>
        </div>

        <div className="flex shrink-0 flex-col gap-3 sm:flex-row lg:flex-col">
          {!isConfirmed && (
            <button
              type="button"
              onClick={
                confirmDetectedMountain
              }
              disabled={saving}
              className="ui-pressable min-h-11 rounded-[var(--radius-control)] bg-[var(--color-forest)] px-5 py-2 font-semibold text-white enabled:hover:bg-[var(--color-forest-hover)] disabled:cursor-wait disabled:opacity-60"
            >
              {saving
                ? t("saving")
                : t("confirm")}
            </button>
          )}

          <button
            ref={searchTriggerRef}
            type="button"
            onClick={toggleMountainSearch}
            aria-expanded={showMountainSearch}
            aria-controls="mountain-search-disclosure"
            disabled={saving}
            className="ui-pressable min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2 font-semibold text-[var(--color-text-secondary)] enabled:hover:border-[var(--color-forest)] enabled:hover:text-[var(--color-forest)] disabled:opacity-60"
          >
            {t("chooseAnother")}
          </button>

          {!isConfirmed && (
            <button
              type="button"
              onClick={rejectDetection}
              disabled={saving}
              className="ui-destructive ui-pressable min-h-11 rounded-[var(--radius-control)] border border-transparent px-5 py-2 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-60"
            >
              {t("reject")}
            </button>
          )}
        </div>
      </div>

      <MountainSearchDisclosure open={showMountainSearch}>
        <MountainSearch
          searchInput={searchInput}
          setSearchInput={handleMountainSearchInputChange}
          searchResults={searchResults}
          searching={searching}
          saving={saving}
          onSelect={saveMountain}
          onClose={closeMountainSearch}
        />
      </MountainSearchDisclosure>

      {errorMessage && (
        <p className="mt-4 border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]" role="alert">
          {errorMessage}
        </p>
      )}
    </section>
  );
}

type MountainSearchProps = {
  searchInput: string;

  setSearchInput: (
    value: string,
  ) => void;

  searchResults: MountainOption[];
  searching: boolean;
  saving: boolean;

  onSelect: (
    mountain: MountainOption,
  ) => Promise<void>;

  onClose: () => void;
};

type MountainSearchDisclosureProps = {
  open: boolean;
  children: ReactNode;
};

function MountainSearchDisclosure({
  open,
  children,
}: MountainSearchDisclosureProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="mountain-search-disclosure"
          id="mountain-search-disclosure"
          initial={{
            opacity: shouldReduceMotion ? 1 : 0,
            y: shouldReduceMotion ? 0 : 10,
          }}
          animate={{
            opacity: 1,
            y: 0,
            transition: {
              duration: shouldReduceMotion ? 0 : 0.19,
              ease: standardEasing,
            },
          }}
          exit={{
            opacity: shouldReduceMotion ? 1 : 0,
            y: shouldReduceMotion ? 0 : 6,
            transition: {
              duration: shouldReduceMotion ? 0 : 0.15,
              ease: standardEasing,
            },
          }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MountainSearch({
  searchInput,
  setSearchInput,
  searchResults,
  searching,
  saving,
  onSelect,
  onClose,
}: MountainSearchProps) {
  const t = useTranslations("Tracks.Detection");
  const format = useFormatter();
  return (
    <div className="mt-6 border-t border-[var(--color-border)] bg-[var(--color-surface)] pt-5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-bold text-[var(--color-text)]">
          {t("chooseAnotherTitle")}
        </h3>

        <button
          type="button"
          onClick={onClose}
          className="ui-pressable min-h-11 px-2 text-sm font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {t("close")}
        </button>
      </div>

      <label htmlFor="manual-mountain-search" className="sr-only">
        {t("searchLabel")}
      </label>

      <input
        id="manual-mountain-search"
        type="search"
        autoFocus
        value={searchInput}
        onChange={(event) => {
          setSearchInput(
            event.target.value,
          );
        }}
        placeholder={t("searchPlaceholder")}
        className="ui-field mt-4 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-2 text-[var(--color-text)] outline-none"
      />

      {searching && (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]" role="status">
          {t("searching")}
        </p>
      )}

      {!searching &&
        searchInput.trim().length >= 2 &&
        searchResults.length === 0 && (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]" role="status">
            {t("noResults")}
          </p>
        )}

      {searchResults.length > 0 && (
        <div className="mt-4 max-h-80 divide-y divide-[var(--color-border-soft)] overflow-y-auto border-y border-[var(--color-border)]">
          {searchResults.map(
            (mountain) => (
              <button
                key={mountain.id}
                type="button"
                disabled={saving}
                onClick={() => {
                  void onSelect(mountain);
                }}
                className="flex min-h-11 w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--color-success-soft)] disabled:opacity-60"
              >
                <span className="min-w-0 truncate font-semibold text-[var(--color-text)]">
                  {getMountainName(mountain, t("mountainFallback", { id: mountain.id }))}
                </span>

                <span className="shrink-0 [font-family:var(--font-technical)] text-sm tabular-nums text-[var(--color-text-muted)]">
                  {mountain.height !== null
                    ? `${format.number(Math.round(mountain.height))} ${t("meterUnit")}`
                    : t("elevationUnavailable")}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
