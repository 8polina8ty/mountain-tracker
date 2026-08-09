import type { PeakProperties } from "./types";

export function getPeakName(properties: PeakProperties): string {
  return properties.name || properties.name_de || "Без названия";
}

export function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE");
}

export function getWikipediaUrl(wikipedia?: string | null): string | null {
  if (!wikipedia) {
    return null;
  }

  return `https://de.wikipedia.org/wiki/${encodeURIComponent(
    wikipedia.replace(/^de:/, ""),
  )}`;
}