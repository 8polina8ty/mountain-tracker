"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "@/i18n/navigation";

const STORAGE_KEY = "mt-nav-history";
const MAX_HISTORY = 20;

function isInternalPath(path: string): boolean {
  if (!path || path === "/") return false;
  // Exclude auth callbacks and api
  if (path.includes("/auth/") || path.startsWith("/api/")) return false;
  // Must start with / and not be external
  return path.startsWith("/");
}

function readHistory(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
  } catch {}
  return [];
}

function writeHistory(history: string[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {}
}

export default function BackNavigationProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname) return;
    const prev = prevRef.current;
    // On first mount, initialize with current pathname if empty
    const history = readHistory();
    if (history.length === 0) {
      writeHistory([pathname]);
      prevRef.current = pathname;
      return;
    }
    // If pathname changed from previous
    if (prev && prev !== pathname) {
      if (isInternalPath(prev) && isInternalPath(pathname)) {
        // Avoid duplicate consecutive entries
        if (history[history.length - 1] !== pathname) {
          writeHistory([...history, pathname]);
        }
      } else if (isInternalPath(pathname) && history[history.length - 1] !== pathname) {
        writeHistory([...history, pathname]);
      }
    } else if (!prev) {
      // First effect after mount with existing history
      if (history[history.length - 1] !== pathname && isInternalPath(pathname)) {
        writeHistory([...history, pathname]);
      }
    }
    prevRef.current = pathname;
  }, [pathname]);

  return <>{children}</>;
}

export function getPreviousInternalPath(currentPath: string, fallback: string): string | null {
  try {
    const history = readHistory();
    // Find last entry before current that is not current, not fallback loop, and not same
    for (let i = history.length - 1; i >= 0; i--) {
      const candidate = history[i];
      if (candidate === currentPath) continue;
      if (candidate === fallback) continue;
      // Avoid auth loops
      if (candidate.includes("/auth/")) continue;
      if (isInternalPath(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function hasInternalHistory(currentPath: string): boolean {
  return getPreviousInternalPath(currentPath, "") !== null;
}
