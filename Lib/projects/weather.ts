import type { SummitLocation, SummitWeather, SummitWeatherDaily } from "@/Lib/weather/types";
import { getSummitWeather, isValidSummitLocation } from "../weather/summitWeather.ts";
import type { MountainId, ProjectDay, ProjectDayWeather, ProjectMountain, ProjectWeatherSummary } from "./types.ts";

export function uniqueWeatherLocations(mountains: readonly ProjectMountain[]): Map<MountainId, SummitLocation> {
  const unique = new Map<MountainId, SummitLocation>();
  for (const mountain of mountains) {
    const location = mountain.latitude === null || mountain.longitude === null
      ? null
      : { latitude: mountain.latitude, longitude: mountain.longitude, elevationM: mountain.heightM };
    if (!unique.has(mountain.id) && location && isValidSummitLocation(location)) {
      unique.set(mountain.id, location);
    }
  }
  return unique;
}

export async function loadProjectMountainWeather(
  days: readonly ProjectDay[],
  loadWeather: (location: SummitLocation) => Promise<SummitWeather | null> = getSummitWeather,
): Promise<Map<MountainId, SummitWeather | null>> {
  const locations = uniqueWeatherLocations(days.flatMap((day) => day.mountains));
  const entries = await Promise.all(
    [...locations].map(async ([mountainId, location]) => [mountainId, await loadWeather(location)] as const),
  );
  return new Map(entries);
}

export function matchProjectDayWeather(projectDate: string | null, weather: SummitWeather | null): ProjectDayWeather {
  if (!projectDate || !weather) return { state: "unavailable", forecast: null };
  const forecast = weather.daily.find((day) => day.date === projectDate) ?? null;
  if (forecast) return { state: "available", forecast };
  const dates = weather.daily.map((day) => day.date).sort();
  if (dates.length > 0 && projectDate > dates[dates.length - 1]) return { state: "outside-horizon", forecast: null };
  return { state: "unavailable", forecast: null };
}

export function indexDailyForecasts(daily: readonly SummitWeatherDaily[]): Map<string, SummitWeatherDaily> {
  return new Map(daily.map((forecast) => [forecast.date, forecast]));
}

export function summarizeProjectWeather(
  days: readonly ProjectDay[],
  weatherByMountain: ReadonlyMap<MountainId, SummitWeather | null>,
): ProjectWeatherSummary {
  const availableMountainIds = new Set<MountainId>();
  let availableDayCount = 0;
  let assignedDayCount = 0;
  let outsideHorizonDayCount = 0;
  let unavailableDayCount = 0;

  for (const day of days) {
    if (day.mountains.length === 0) continue;
    assignedDayCount += 1;
    let dayAvailable = false;
    let allOutsideHorizon = true;
    for (const mountain of day.mountains) {
      const state = matchProjectDayWeather(day.date, weatherByMountain.get(mountain.id) ?? null).state;
      if (state === "available") {
        dayAvailable = true;
        availableMountainIds.add(mountain.id);
      }
      if (state !== "outside-horizon") allOutsideHorizon = false;
    }
    if (dayAvailable) availableDayCount += 1;
    else if (allOutsideHorizon) outsideHorizonDayCount += 1;
    else unavailableDayCount += 1;
  }

  return {
    availableDayCount,
    availableMountainCount: availableMountainIds.size,
    assignedDayCount,
    outsideHorizonDayCount,
    unavailableDayCount,
    totalDayCount: days.length,
  };
}
