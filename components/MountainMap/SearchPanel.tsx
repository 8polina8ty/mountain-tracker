type SearchPanelProps = {
  searchInput: string;
  searchMessage: string;
  appliedSearch: string;
  visiblePeakCount: number;
  onSearchInputChange: (value: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
};

export default function SearchPanel({
  searchInput,
  searchMessage,
  appliedSearch,
  visiblePeakCount,
  onSearchInputChange,
  onSearch,
  onClearSearch,
}: SearchPanelProps) {
  return (
    <>
      <label className="mt-5 block rounded-xl bg-gray-50 p-3">
        <span className="mb-2 block text-sm font-semibold text-gray-800">
          Поиск вершины
        </span>

        <div>
          <input
            type="text"
            value={searchInput}
            onChange={(event) => {
              onSearchInputChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onSearch();
              }
            }}
            placeholder="Например, Zugspitze"
            className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none transition focus:border-green-500 focus:ring-4 focus:ring-green-100"
          />

          <button
            type="button"
            onClick={onSearch}
            className="mt-3 w-full rounded-xl bg-green-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-green-700 active:scale-95"
          >
            Найти
          </button>
        </div>
      </label>

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="mt-4 rounded-xl bg-gray-50 p-3">
          <div className="text-xs uppercase tracking-wide text-gray-500">
            Статистика
          </div>

          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm text-gray-500">Показано</span>

            <span className="text-lg font-bold text-green-500">
              {visiblePeakCount}
            </span>
          </div>
        </div>

        {appliedSearch && (
          <button
            type="button"
            onClick={onClearSearch}
            className="text-sm font-medium text-green-700 hover:underline"
          >
            Очистить поиск
          </button>
        )}
      </div>

      {searchMessage && (
        <p className="mt-2 text-sm font-medium text-green-700">
          {searchMessage}
        </p>
      )}
    </>
  );
}