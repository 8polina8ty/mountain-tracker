import { PROJECT_MAX_DAYS, inclusiveCalendarDayCount, parseIsoDate } from "./validation.ts";

export type GeneratedProjectDay = { dayNumber: number; date: string };

export function addUtcCalendarDays(isoDate: string, offset: number): string | null {
  const date = parseIsoDate(isoDate);
  if (!date || !Number.isInteger(offset)) return null;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function generateProjectDays(startDate: string, endDate: string): GeneratedProjectDay[] {
  const count = inclusiveCalendarDayCount(startDate, endDate);
  if (count === 0 || count > PROJECT_MAX_DAYS) return [];
  return Array.from({ length: count }, (_, index) => ({
    dayNumber: index + 1,
    date: addUtcCalendarDays(startDate, index) as string,
  }));
}

export function renumberProjectDays<T>(days: readonly T[]): Array<T & { dayNumber: number }> {
  return days.map((day, index) => ({ ...day, dayNumber: index + 1 }));
}
