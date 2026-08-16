"use client";

import { Check, ChevronDown } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { locales, type Locale } from "@/i18n/locales";
import { usePathname, useRouter } from "@/i18n/navigation";

const localeNames: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  ru: "Русский",
  fr: "Français",
  it: "Italiano",
  es: "Español",
};

function getSafeSearch(): string {
  const searchParams = new URLSearchParams(window.location.search);
  const next = searchParams.get("next");

  if (next && (!next.startsWith("/") || next.startsWith("//"))) {
    searchParams.delete("next");
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export default function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("LocaleSwitcher");
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(() =>
    locales.indexOf(locale),
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    itemRefs.current[focusedIndex]?.focus();
  }, [focusedIndex, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeWhenOutside(event: PointerEvent | FocusEvent) {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);

    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
    };
  }, [open]);

  function openMenu(index = locales.indexOf(locale)) {
    setFocusedIndex(index);
    setOpen(true);
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);

    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  function selectLocale(nextLocale: Locale) {
    closeMenu({ restoreFocus: true });

    if (nextLocale !== locale) {
      router.replace(`${pathname}${getSafeSearch()}`, { locale: nextLocale });
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(locales.length - 1);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setFocusedIndex(
        (currentIndex) =>
          (currentIndex + offset + locales.length) % locales.length,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFocusedIndex(locales.length - 1);
    }
  }

  return (
    <div ref={containerRef} className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("language")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        className="ui-pressable inline-flex min-h-11 min-w-12 items-center justify-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 [font-family:var(--font-technical)] text-xs font-bold uppercase tracking-[0.08em] text-[var(--color-forest)] shadow-[var(--shadow-control)] outline-none hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)] focus-visible:border-[var(--color-forest)]"
      >
        <span>{locale.toUpperCase()}</span>
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t("language")}
          onKeyDown={handleMenuKeyDown}
          className="absolute left-0 top-[calc(100%+0.375rem)] z-[220] w-52 overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1 shadow-[var(--shadow-panel)] lg:left-auto lg:right-0"
        >
          {locales.map((availableLocale, index) => {
            const active = availableLocale === locale;

            return (
              <button
                key={availableLocale}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={focusedIndex === index ? 0 : -1}
                onClick={() => selectLocale(availableLocale)}
                onFocus={() => setFocusedIndex(index)}
                className={`ui-pressable flex min-h-11 w-full items-center gap-2 rounded-[calc(var(--radius-control)-2px)] px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-forest)] focus-visible:ring-inset ${
                  active
                    ? "bg-[var(--color-surface-muted)] font-bold text-[var(--color-forest)]"
                    : "font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {active && (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">{localeNames[availableLocale]}</span>
                <span className="[font-family:var(--font-technical)] text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  {availableLocale}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
