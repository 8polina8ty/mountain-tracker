import { Search, X } from "lucide-react";

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
    <section aria-labelledby="mountain-search-label">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <label
          id="mountain-search-label"
          htmlFor="mountain-search"
          className="mb-2 block text-xs font-semibold text-[var(--color-text-secondary)]"
        >
          Поиск вершины
        </label>

        <div className="flex overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-within:border-[var(--color-focus)] focus-within:ring-2 focus-within:ring-[var(--color-focus-halo)]">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              size={17}
            />
            <input
              id="mountain-search"
              type="text"
              value={searchInput}
              onChange={(event) => {
                onSearchInputChange(event.target.value);
              }}
              placeholder="Например, Zugspitze"
              className="h-11 w-full bg-transparent py-2 pl-9 pr-11 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            />

            {searchInput && (
              <button
                type="button"
                onClick={onClearSearch}
                className="ui-pressable absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-offset-[-2px]"
                aria-label="Очистить поле поиска"
              >
                <X aria-hidden="true" size={16} />
              </button>
            )}
          </div>

          <button
            type="submit"
            className="ui-pressable shrink-0 border-l border-[var(--color-forest-active)] bg-[var(--color-forest)] px-3 text-sm font-semibold text-[var(--color-text-inverse)] hover:bg-[var(--color-forest-hover)] focus-visible:outline-offset-[-2px]"
          >
            Найти
          </button>
        </div>
      </form>

      <div className="mt-4 flex items-end justify-between gap-3 border-y border-[var(--color-border-soft)] py-3">
        <div>
          <p className="[font-family:var(--font-technical)] text-[var(--font-size-label)] font-bold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
            Видимые вершины
          </p>
          <p className="mt-0.5 [font-family:var(--font-technical)] text-2xl font-bold leading-none tabular-nums text-[var(--color-text)]">
            {visiblePeakCount.toLocaleString("ru-RU")}
          </p>
        </div>

        {appliedSearch && (
          <button
            type="button"
            onClick={onClearSearch}
            className="ui-pressable text-xs font-semibold text-[var(--color-forest)] hover:text-[var(--color-forest-hover)] hover:underline"
          >
            Снять поиск
          </button>
        )}
      </div>

      {searchMessage && (
        <p
          className="mt-3 border-l-2 border-[var(--color-glacier)] pl-3 text-xs font-medium leading-5 text-[var(--color-text-secondary)]"
          role="status"
          aria-live="polite"
        >
          {searchMessage}
        </p>
      )}
    </section>
  );
}
