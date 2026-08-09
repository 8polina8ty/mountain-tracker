type HeightFilterProps = {
  minimumHeight: number;
  onHeightChange: (height: number) => void;
  onReset: () => void;
};

export default function HeightFilter({
  minimumHeight,
  onHeightChange,
  onReset,
}: HeightFilterProps) {
  return (
    <>
      <label className="mt-6 block">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-gray-700">Минимальная высота</span>

          <span className="rounded-lg bg-emerald-100 px-3 py-1 font-semibold text-emerald-700">
            {minimumHeight} м
          </span>
        </div>

        <input
          type="range"
          min={700}
          max={8000}
          step={50}
          value={minimumHeight}
          onChange={(event) => {
            onHeightChange(Number(event.target.value));
          }}
          className="w-full"
        />
      </label>

      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-green-500" />
          700–999 м
        </div>

        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-lime-500" />
          1000–1299 м
        </div>

        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          1300–1599 м
        </div>

        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-orange-500" />
          1600–1999 м
        </div>

        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-red-500" />
          2000–3999 м
        </div>

        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-purple-600" />
          4000–5999 м
        </div>

        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-blue-600" />
          6000–8000 м
        </div>
      </div>

      <button
        type="button"
        onClick={onReset}
        className="mt-5 w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-800"
      >
        Сбросить фильтры
      </button>
    </>
  );
}