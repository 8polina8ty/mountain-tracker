import type { SelectedPeak } from "./types";

type PeakDetailsPanelProps = {
  peak: SelectedPeak;
  peakName: string;
  wikipediaUrl: string | null;
  selectedPeakClimbed: boolean;
  ascentLoading: boolean;
  ascentMessage: string;
  onClose: () => void;
  onAscent: () => void;
};

export default function PeakDetailsPanel({
  peak,
  peakName,
  wikipediaUrl,
  selectedPeakClimbed,
  ascentLoading,
  ascentMessage,
  onClose,
  onAscent,
}: PeakDetailsPanelProps) {
  return (
    <aside className="fixed bottom-4 right-4 z-50 max-h-[calc(100vh-32px)] w-[420px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-3xl border border-gray-200 bg-white p-6 shadow-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
            <span>🏔</span>
            <span>Вершина</span>
          </div>

          <h2 className="mt-3 text-3xl font-bold leading-tight text-gray-900">
            {peakName}
          </h2>

          <div className="mt-4 inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-lg font-bold text-white shadow-sm">
            <span>⛰</span>
            <span>{peak.height} м</span>
          </div>

          <a
            href={`/mountain/${peak.id}`}
            className="mt-4 inline-flex items-center rounded-xl border border-green-600 px-4 py-2 font-semibold text-green-700 transition hover:bg-green-50"
          >
            Подробнее о вершине →
          </a>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-2xl text-gray-500 transition hover:bg-gray-100 hover:text-gray-900"
          aria-label="Закрыть карточку"
        >
          ×
        </button>
      </div>

      <div className="mt-6 divide-y divide-gray-200 border-y border-gray-200">
        <div className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3 text-gray-500">
            <span className="text-xl">📍</span>
            <span>Регион</span>
          </div>

          <span className="text-right font-medium text-gray-800">
            {peak.name_de ?? "Не указан"}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3 text-gray-500">
            <span className="text-xl">◎</span>
            <span>Координаты</span>
          </div>

          <span className="text-right font-medium text-gray-800">
            {peak.latitude.toFixed(5)}, {peak.longitude.toFixed(5)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3 text-gray-500">
            <span className="text-xl">⛰</span>
            <span>Высота</span>
          </div>

          <span className="font-medium text-gray-800">
            {peak.height} м
          </span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <a
          href={`https://www.openstreetmap.org/?mlat=${peak.latitude}&mlon=${peak.longitude}#map=15/${peak.latitude}/${peak.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-xl border border-gray-300 px-4 py-3 font-medium text-gray-800 transition hover:border-green-500 hover:bg-green-50"
        >
          <span>🌍</span>
          <span>OpenStreetMap</span>
        </a>

        {wikipediaUrl ? (
          <a
            href={wikipediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-xl border border-gray-300 px-4 py-3 font-medium text-gray-800 transition hover:border-green-500 hover:bg-green-50"
          >
            <span className="font-serif text-xl">W</span>
            <span>Wikipedia</span>
          </a>
        ) : (
          <div className="flex cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-gray-400">
            <span className="font-serif text-xl">W</span>
            <span>Wikipedia</span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onAscent}
        disabled={ascentLoading}
        className={`mt-5 w-full rounded-xl px-5 py-4 text-lg font-bold text-white shadow-sm transition ${
          selectedPeakClimbed
            ? "cursor-default bg-green-800"
            : "bg-green-600 hover:bg-green-700 active:scale-[0.99]"
        }`}
      >
        {ascentLoading
          ? "Сохраняю…"
          : selectedPeakClimbed
            ? "Отменить восхождение"
            : "Взошёл на вершину"}
      </button>

      {ascentMessage && (
        <p
          className={`mt-3 text-center text-sm font-medium ${
            selectedPeakClimbed ? "text-green-700" : "text-red-600"
          }`}
        >
          {ascentMessage}
        </p>
      )}
    </aside>
  );
}