"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useState,
} from "react";

import { createClient } from "@/Lib/supabase/client";

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
): string {
  return (
    mountain.name_de ??
    mountain.name ??
    `Вершина №${mountain.id}`
  );
}

function formatConfidence(
  confidence: number | null,
): string {
  if (confidence === null) {
    return "Не рассчитана";
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
  const router = useRouter();

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

  useEffect(() => {
    if (
      !showMountainSearch ||
      searchInput.trim().length < 2
    ) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const supabase = createClient();
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

        if (error) {
          console.error(
            "Ошибка поиска вершины:",
            error,
          );

          setErrorMessage(
            "Не удалось выполнить поиск вершины.",
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
      window.clearTimeout(timeoutId);
    };
  }, [searchInput, showMountainSearch]);

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
          "Сначала войдите в аккаунт.",
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
      setShowMountainSearch(false);
      setSearchInput("");
      setSearchResults([]);

      router.refresh();
    } catch (error) {
      console.error(
        "Ошибка подтверждения вершины:",
        error,
      );

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Не удалось сохранить вершину.",
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
          "Сначала войдите в аккаунт.",
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
          : "Не удалось отклонить результат.",
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
      <section className="mt-8 rounded-3xl border border-amber-200 bg-amber-50 p-6">
        <p className="text-sm font-bold uppercase tracking-wide text-amber-700">
          Определение вершины
        </p>

        <h2 className="mt-2 text-xl font-bold text-gray-900">
          Вершина автоматически не найдена
        </h2>

        <p className="mt-2 text-gray-600">
          Выберите вершину вручную, если этот
          GPS-трек относится к восхождению.
        </p>

        <button
          type="button"
          onClick={() => {
            setShowMountainSearch(true);
          }}
          className="mt-5 rounded-xl bg-amber-600 px-5 py-3 font-semibold text-white transition hover:bg-amber-700"
        >
          Выбрать вершину
        </button>

        {showMountainSearch && (
          <MountainSearch
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            searchResults={searchResults}
            searching={searching}
            saving={saving}
            onSelect={saveMountain}
            onClose={() => {
              setShowMountainSearch(false);
              setSearchInput("");
              setSearchResults([]);
            }}
          />
        )}

        {errorMessage && (
          <p className="mt-4 text-sm text-red-700">
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
      <section className="mt-8 rounded-3xl border border-gray-200 bg-gray-50 p-6">
        <p className="text-sm font-bold uppercase tracking-wide text-gray-500">
          Определение вершины
        </p>

        <h2 className="mt-2 text-xl font-bold text-gray-900">
          Автоматический результат отклонён
        </h2>

        <button
          type="button"
          onClick={() => {
            setShowMountainSearch(true);
          }}
          className="mt-5 rounded-xl border border-green-600 bg-white px-5 py-3 font-semibold text-green-700 transition hover:bg-green-50"
        >
          Выбрать вершину вручную
        </button>

        {showMountainSearch && (
          <MountainSearch
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            searchResults={searchResults}
            searching={searching}
            saving={saving}
            onSelect={saveMountain}
            onClose={() => {
              setShowMountainSearch(false);
              setSearchInput("");
              setSearchResults([]);
            }}
          />
        )}

        {errorMessage && (
          <p className="mt-4 text-sm text-red-700">
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
    getMountainName(detectedMountain);

  const isConfirmed =
    detectionStatus === "confirmed" &&
    gpsVerified;

  return (
    <section
      className={[
        "mt-8 rounded-3xl border p-6",
        isConfirmed
          ? "border-green-200 bg-green-50"
          : "border-blue-200 bg-blue-50",
      ].join(" ")}
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p
            className={[
              "text-sm font-bold uppercase tracking-wide",
              isConfirmed
                ? "text-green-700"
                : "text-blue-700",
            ].join(" ")}
          >
            {isConfirmed
              ? "Подтверждено GPS"
              : "Автоматически найдена вершина"}
          </p>

          <h2 className="mt-2 text-2xl font-bold text-gray-900">
            {mountainName}
          </h2>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-600">
            {detectedMountain.height !==
              null && (
              <span>
                Высота:{" "}
                <strong>
                  {Math.round(
                    detectedMountain.height,
                  ).toLocaleString(
                    "ru-RU",
                  )}{" "}
                  м
                </strong>
              </span>
            )}

            {detectionDistanceM !== null && (
              <span>
                Расстояние до трека:{" "}
                <strong>
                  {Math.round(
                    detectionDistanceM,
                  ).toLocaleString(
                    "ru-RU",
                  )}{" "}
                  м
                </strong>
              </span>
            )}

            <span>
              Уверенность:{" "}
              <strong>
                {formatConfidence(
                  detectionConfidence,
                )}
              </strong>
            </span>
          </div>

          <Link
            href={`/mountain/${detectedMountain.id}`}
            className="mt-4 inline-flex font-semibold text-green-700 transition hover:text-green-800"
          >
            Открыть страницу вершины →
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
              className="rounded-xl bg-green-600 px-5 py-3 font-semibold text-white transition hover:bg-green-700 disabled:cursor-wait disabled:opacity-60"
            >
              {saving
                ? "Сохраняю…"
                : "Подтвердить вершину"}
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setShowMountainSearch(
                (currentValue) =>
                  !currentValue,
              );
            }}
            disabled={saving}
            className="rounded-xl border border-gray-300 bg-white px-5 py-3 font-semibold text-gray-700 transition hover:border-green-400 hover:bg-green-50 hover:text-green-700 disabled:opacity-60"
          >
            Выбрать другую
          </button>

          {!isConfirmed && (
            <button
              type="button"
              onClick={rejectDetection}
              disabled={saving}
              className="rounded-xl px-5 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-60"
            >
              Это не вершина
            </button>
          )}
        </div>
      </div>

      {showMountainSearch && (
        <MountainSearch
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          searchResults={searchResults}
          searching={searching}
          saving={saving}
          onSelect={saveMountain}
          onClose={() => {
            setShowMountainSearch(false);
            setSearchInput("");
            setSearchResults([]);
          }}
        />
      )}

      {errorMessage && (
        <p className="mt-4 rounded-xl bg-red-100 px-4 py-3 text-sm text-red-700">
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

function MountainSearch({
  searchInput,
  setSearchInput,
  searchResults,
  searching,
  saving,
  onSelect,
  onClose,
}: MountainSearchProps) {
  return (
    <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-bold text-gray-900">
          Выберите другую вершину
        </h3>

        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-gray-500 hover:text-gray-900"
        >
          Закрыть
        </button>
      </div>

      <input
        type="search"
        value={searchInput}
        onChange={(event) => {
          setSearchInput(
            event.target.value,
          );
        }}
        placeholder="Например, Zugspitze"
        className="mt-4 w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:border-green-500 focus:ring-2 focus:ring-green-100"
      />

      {searching && (
        <p className="mt-4 text-sm text-gray-500">
          Ищу вершины…
        </p>
      )}

      {!searching &&
        searchInput.trim().length >= 2 &&
        searchResults.length === 0 && (
          <p className="mt-4 text-sm text-gray-500">
            Вершины не найдены.
          </p>
        )}

      {searchResults.length > 0 && (
        <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
          {searchResults.map(
            (mountain) => (
              <button
                key={mountain.id}
                type="button"
                disabled={saving}
                onClick={() => {
                  void onSelect(mountain);
                }}
                className="flex w-full items-center justify-between gap-4 rounded-xl border border-gray-200 px-4 py-3 text-left transition hover:border-green-400 hover:bg-green-50 disabled:opacity-60"
              >
                <span className="font-semibold text-gray-900">
                  {getMountainName(
                    mountain,
                  )}
                </span>

                <span className="shrink-0 text-sm text-gray-500">
                  {mountain.height !== null
                    ? `${Math.round(
                        mountain.height,
                      ).toLocaleString(
                        "ru-RU",
                      )} м`
                    : "Высота не указана"}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}