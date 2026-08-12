import type {
  SummitLocation,
  SummitWeather,
  SummitWeatherCurrent,
  SummitWeatherDaily,
  SummitWeatherHourly,
  WeatherCondition,
} from "./types";

export const SUMMIT_WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
export const SUMMIT_WEATHER_REVALIDATE_SECONDS = 1200;
export const SUMMIT_WEATHER_TIMEOUT_MS = 8000;
export const SUMMIT_WEATHER_FORECAST_DAYS = 6;
export const SUMMIT_WEATHER_HOURLY_HOURS = 48;

const CURRENT_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "weather_code",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "precipitation",
  "snowfall",
  "cloud_cover",
  "visibility",
  "freezing_level_height",
].join(",");

const HOURLY_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation_probability",
  "precipitation",
  "snowfall",
  "weather_code",
  "cloud_cover",
  "visibility",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "freezing_level_height",
].join(",");

const DAILY_VARIABLES = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "snowfall_sum",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "sunrise",
  "sunset",
].join(",");

const WMO_WEATHER_CODE_MAP: Record<number, WeatherCondition> = {
  0: "clear",
  1: "mostlyClear",
  2: "partlyCloudy",
  3: "overcast",
  45: "fog",
  48: "fog",
  51: "drizzle",
  53: "drizzle",
  55: "drizzle",
  56: "drizzle",
  57: "drizzle",
  61: "rain",
  63: "rain",
  65: "rain",
  66: "rain",
  67: "rain",
  71: "snow",
  73: "snow",
  75: "snow",
  77: "snow",
  80: "showers",
  81: "showers",
  82: "showers",
  85: "snow",
  86: "snow",
  95: "thunderstorm",
  96: "thunderstorm",
  99: "thunderstorm",
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function zonedTimeToUtc(
  localIso: string,
  timeZone: string,
): string | null {
  if (!isValidIanaTimeZone(timeZone)) {
    return null;
  }

  const probe = new Date(`${localIso}Z`);

  if (Number.isNaN(probe.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(probe);

  const partValue = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const wallClock = Date.UTC(
    partValue("year"),
    partValue("month") - 1,
    partValue("day"),
    partValue("hour"),
    partValue("minute"),
    partValue("second"),
  );

  if (Number.isNaN(wallClock)) {
    return null;
  }

  const utc = new Date(probe.getTime() - (wallClock - probe.getTime()));

  return Number.isNaN(utc.getTime()) ? null : utc.toISOString();
}

export function mapWeatherCode(code: number): WeatherCondition {
  return WMO_WEATHER_CODE_MAP[code] ?? "unknown";
}

export function isValidSummitLocation(location: SummitLocation): boolean {
  const { latitude, longitude, elevationM } = location;

  return (
    isFiniteNumber(latitude) &&
    isFiniteNumber(longitude) &&
    isFiniteNumber(elevationM) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    elevationM > 0
  );
}

type OpenMeteoTimeSeries = {
  time?: unknown[];
  [variable: string]: unknown[] | undefined;
};

function isTimeArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function areMatchingSeries(
  series: OpenMeteoTimeSeries,
  names: string[],
  length: number,
): boolean {
  return names.every(
    (name) =>
      Array.isArray(series[name]) &&
      series[name].length === series.time?.length &&
      series[name].length === length,
  );
}

function normalizeCurrent(
  rawCurrent: Record<string, unknown>,
): Pick<SummitWeatherCurrent, "condition"> | null {
  const temperatureC = rawCurrent.temperature_2m;
  const apparentTemperatureC = rawCurrent.apparent_temperature;
  const windSpeedKmh = rawCurrent.wind_speed_10m;
  const windGustsKmh = rawCurrent.wind_gusts_10m;
  const weatherCode = rawCurrent.weather_code;
  const windDirectionDeg = rawCurrent.wind_direction_10m;
  const precipitationMm = rawCurrent.precipitation;
  const snowfallCm = rawCurrent.snowfall;
  const cloudCoverPct = rawCurrent.cloud_cover;
  const visibilityM = rawCurrent.visibility;
  const freezingLevelM = rawCurrent.freezing_level_height;

  if (
    !isFiniteNumber(temperatureC) ||
    !isFiniteNumber(apparentTemperatureC) ||
    !isFiniteNumber(windSpeedKmh) ||
    !isFiniteNumber(windGustsKmh) ||
    !isFiniteNumberOrNull(windDirectionDeg) ||
    !isFiniteNumberOrNull(precipitationMm) ||
    !isFiniteNumberOrNull(snowfallCm) ||
    !isFiniteNumberOrNull(cloudCoverPct) ||
    !isFiniteNumberOrNull(visibilityM) ||
    !isFiniteNumberOrNull(freezingLevelM)
  ) {
    return null;
  }

  return {
    condition:
      typeof weatherCode === "number"
        ? mapWeatherCode(weatherCode)
        : "unknown",
  };
}

function normalizeHourly(
  rawHourly: OpenMeteoTimeSeries,
  timeZone: string,
): SummitWeatherHourly[] | null {
  const time = rawHourly.time;

  if (!isTimeArray(time) || time.length === 0) {
    return null;
  }

  const names = [
    "temperature_2m",
    "apparent_temperature",
    "precipitation_probability",
    "precipitation",
    "snowfall",
    "weather_code",
    "cloud_cover",
    "visibility",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "freezing_level_height",
  ];

  if (!areMatchingSeries(rawHourly, names, time.length)) {
    return null;
  }

  const hourly: SummitWeatherHourly[] = [];

  for (let index = 0; index < time.length; index += 1) {
    const temperatureC = rawHourly.temperature_2m![index];
    const weatherCode = rawHourly.weather_code![index];
    const utcTime = zonedTimeToUtc(time[index], timeZone);

    if (!isFiniteNumber(temperatureC) || utcTime === null) {
      return null;
    }

    const precipitationMm = optionalNumber(
      rawHourly.precipitation![index],
    );
    const visibilityM = optionalNumber(rawHourly.visibility![index]);
    const freezingLevelM = optionalNumber(
      rawHourly.freezing_level_height![index],
    );

    hourly.push({
      time: utcTime,
      condition: mapWeatherCode(
        typeof weatherCode === "number" ? weatherCode : Number.NaN,
      ),
      temperatureC,
      apparentTemperatureC: optionalNumber(
        rawHourly.apparent_temperature![index],
      ),
      precipitationProbabilityPct: optionalNumber(
        rawHourly.precipitation_probability![index],
      ),
      precipitationMm,
      snowfallCm: optionalNumber(rawHourly.snowfall![index]),
      cloudCoverPct: optionalNumber(rawHourly.cloud_cover![index]),
      visibilityKm: visibilityM === null ? null : visibilityM / 1000,
      windSpeedKmh: optionalNumber(rawHourly.wind_speed_10m![index]),
      windDirectionDeg: optionalNumber(
        rawHourly.wind_direction_10m![index],
      ),
      windGustsKmh: optionalNumber(rawHourly.wind_gusts_10m![index]),
      freezingLevelM,
    });
  }

  return hourly;
}

function normalizeDaily(
  rawDaily: OpenMeteoTimeSeries,
  timeZone: string,
): SummitWeatherDaily[] | null {
  const time = rawDaily.time;

  if (!isTimeArray(time) || time.length === 0) {
    return null;
  }

  const names = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
    "precipitation_sum",
    "snowfall_sum",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
    "sunrise",
    "sunset",
  ];

  if (!areMatchingSeries(rawDaily, names, time.length)) {
    return null;
  }

  const daily: SummitWeatherDaily[] = [];

  for (let index = 0; index < time.length; index += 1) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(time[index])) {
      return null;
    }

    const temperatureMaxC = rawDaily.temperature_2m_max![index];
    const temperatureMinC = rawDaily.temperature_2m_min![index];
    const weatherCode = rawDaily.weather_code![index];

    if (
      !isFiniteNumber(temperatureMaxC) ||
      !isFiniteNumber(temperatureMinC)
    ) {
      return null;
    }

    const sunriseValue = rawDaily.sunrise![index];
    const sunsetValue = rawDaily.sunset![index];
    const sunrise =
      typeof sunriseValue === "string"
        ? zonedTimeToUtc(sunriseValue, timeZone)
        : null;
    const sunset =
      typeof sunsetValue === "string"
        ? zonedTimeToUtc(sunsetValue, timeZone)
        : null;

    daily.push({
      date: time[index],
      condition: mapWeatherCode(
        typeof weatherCode === "number" ? weatherCode : Number.NaN,
      ),
      temperatureMaxC,
      temperatureMinC,
      precipitationProbabilityMaxPct: optionalNumber(
        rawDaily.precipitation_probability_max![index],
      ),
      precipitationSumMm: optionalNumber(rawDaily.precipitation_sum![index]),
      snowfallSumCm: optionalNumber(rawDaily.snowfall_sum![index]),
      windSpeedMaxKmh: optionalNumber(rawDaily.wind_speed_10m_max![index]),
      windGustsMaxKmh: optionalNumber(rawDaily.wind_gusts_10m_max![index]),
      sunriseUtc: sunrise,
      sunsetUtc: sunset,
    });
  }

  return daily;
}

function optionalNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

export function normalizeOpenMeteoResponse(
  raw: unknown,
  location: SummitLocation,
): SummitWeather | null {
  if (!isValidSummitLocation(location) || typeof raw !== "object" || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const timezone = record.timezone;

  if (typeof timezone !== "string" || !isValidIanaTimeZone(timezone)) {
    return null;
  }

  if (!record.current || typeof record.current !== "object") {
    return null;
  }

  if (
    !record.hourly ||
    typeof record.hourly !== "object" ||
    !record.daily ||
    typeof record.daily !== "object"
  ) {
    return null;
  }

  const current = record.current as Record<string, unknown>;
  const hourlyRaw = record.hourly as OpenMeteoTimeSeries;
  const dailyRaw = record.daily as OpenMeteoTimeSeries;

  const currentTime = current.time;
  const currentCondition = normalizeCurrent(current);

  if (currentCondition === null) {
    return null;
  }

  const hourly = normalizeHourly(hourlyRaw, timezone);
  const daily = normalizeDaily(dailyRaw, timezone);

  if (hourly === null || daily === null) {
    return null;
  }

const generatedAt =
    typeof currentTime === "string"
      ? zonedTimeToUtc(currentTime, timezone)
      : null;

  const visibilityM = optionalNumber(current.visibility);

  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    timezone,
    elevationM: location.elevationM,
    current: {
      ...currentCondition,
      temperatureC: current.temperature_2m as number,
      apparentTemperatureC: current.apparent_temperature as number,
      windSpeedKmh: current.wind_speed_10m as number,
      windGustsKmh: current.wind_gusts_10m as number,
      windDirectionDeg: optionalNumber(current.wind_direction_10m),
      precipitationMm: optionalNumber(current.precipitation),
      snowfallCm: optionalNumber(current.snowfall),
      cloudCoverPct: optionalNumber(current.cloud_cover),
      visibilityKm: visibilityM === null ? null : visibilityM / 1000,
      freezingLevelM: optionalNumber(current.freezing_level_height),
    },
    hourly,
    daily,
  };
}

export async function getSummitWeather(
  location: SummitLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<SummitWeather | null> {
  if (!isValidSummitLocation(location)) {
    return null;
  }

  const url = new URL(SUMMIT_WEATHER_API_URL);

  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("elevation", String(location.elevationM));
  url.searchParams.set("forecast_days", String(SUMMIT_WEATHER_FORECAST_DAYS));
  url.searchParams.set("forecast_hours", String(SUMMIT_WEATHER_HOURLY_HOURS));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("current", CURRENT_VARIABLES);
  url.searchParams.set("hourly", HOURLY_VARIABLES);
  url.searchParams.set("daily", DAILY_VARIABLES);

  try {
    const response = await fetchImpl(url, {
      cache: "force-cache",
      next: {
        revalidate: SUMMIT_WEATHER_REVALIDATE_SECONDS,
      },
      signal: AbortSignal.timeout(SUMMIT_WEATHER_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();

    return normalizeOpenMeteoResponse(payload, location);
  } catch {
    return null;
  }
}