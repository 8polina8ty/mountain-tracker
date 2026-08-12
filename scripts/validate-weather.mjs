import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SUMMIT_WEATHER_FORECAST_DAYS,
  SUMMIT_WEATHER_HOURLY_HOURS,
  SUMMIT_WEATHER_REVALIDATE_SECONDS,
  SUMMIT_WEATHER_TIMEOUT_MS,
  getSummitWeather,
  isValidSummitLocation,
  mapWeatherCode,
  normalizeOpenMeteoResponse,
  zonedTimeToUtc,
} from "../Lib/weather/summitWeather.ts";
import { WEATHER_CONDITIONS } from "../Lib/weather/types.ts";

const SUMMIT_LOCATION = { latitude: 46.5368, longitude: 8.1182, elevationM: 2718 };

function createValidPayload(overrides = {}) {
  return {
    timezone:
      overrides.timezone === undefined ? "Europe/Berlin" : overrides.timezone,
    current: {
      time: "2026-01-01T12:00",
      temperature_2m: 0.5,
      apparent_temperature: -2.0,
      weather_code: 2,
      wind_speed_10m: 12.0,
      wind_direction_10m: 220,
      wind_gusts_10m: 25.0,
      precipitation: 0.0,
      snowfall: 0.0,
      cloud_cover: 40,
      visibility: 27480,
      freezing_level_height: 1850,
      ...overrides.current,
    },
    hourly: {
      time: ["2026-01-01T12:00", "2026-01-01T13:00", "2026-01-01T14:00"],
      temperature_2m: [0.5, 1.0, 1.5],
      apparent_temperature: [-2.0, -1.5, -1.0],
      precipitation_probability: [10, 20, 30],
      precipitation: [0.0, 0.1, 0.0],
      snowfall: [0.0, 0.1, 0.0],
      weather_code: [2, 61, 63],
      cloud_cover: [40, 60, 80],
      visibility: [27480, 20000, 15000],
      wind_speed_10m: [12.0, 14.0, 16.0],
      wind_direction_10m: [220, 230, 240],
      wind_gusts_10m: [25.0, 28.0, 30.0],
      freezing_level_height: [1850, 1800, 1750],
      ...overrides.hourly,
    },
    daily: {
      time: ["2026-01-01", "2026-01-02", "2026-01-03"],
      weather_code: [2, 95, 73],
      temperature_2m_max: [3.0, 2.0, -1.0],
      temperature_2m_min: [-5.0, -4.0, -8.0],
      precipitation_probability_max: [20, 80, 60],
      precipitation_sum: [0.0, 12.4, 8.1],
      snowfall_sum: [0.0, 0.0, 12.0],
      wind_speed_10m_max: [18.0, 22.0, 25.0],
      wind_gusts_10m_max: [35.0, 40.0, 45.0],
      sunrise: ["2026-01-01T08:12", "2026-01-02T08:12", "2026-01-03T08:13"],
      sunset: ["2026-01-01T16:05", "2026-01-02T16:06", "2026-01-03T16:07"],
      ...overrides.daily,
    },
  };
}

function testWeatherCodeMapping() {
  const expectations = {
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

  for (const [code, expected] of Object.entries(expectations)) {
    assert.equal(mapWeatherCode(Number(code)), expected, `WMO ${code}`);
  }

  assert.equal(mapWeatherCode(999), "unknown");
  assert.equal(mapWeatherCode(Number.NaN), "unknown");
}

function testSummitLocationValidation() {
  assert.equal(isValidSummitLocation(SUMMIT_LOCATION), true);
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, latitude: 90.1 }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, latitude: -90.1 }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, longitude: -181 }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, longitude: 181 }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, elevationM: 0 }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, elevationM: -10 }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, latitude: Number.NaN }),
    false,
  );
  assert.equal(
    isValidSummitLocation({ ...SUMMIT_LOCATION, elevationM: Number.POSITIVE_INFINITY }),
    false,
  );
}

function testZonedTimeConversion() {
  assert.equal(
    zonedTimeToUtc("2026-08-12T05:43", "Europe/Zurich"),
    "2026-08-12T03:43:00.000Z",
  );
  assert.equal(
    zonedTimeToUtc("2026-01-01T08:12", "Europe/Berlin"),
    "2026-01-01T07:12:00.000Z",
  );
  assert.equal(
    zonedTimeToUtc("2026-01-01T16:05", "Europe/Berlin"),
    "2026-01-01T15:05:00.000Z",
  );
  assert.equal(zonedTimeToUtc("not-a-date", "Europe/Berlin"), null);
  assert.equal(zonedTimeToUtc("2026-01-01T08:12", "Mars/Olympus"), null);
}

function testNormalization() {
  const weather = normalizeOpenMeteoResponse(createValidPayload(), SUMMIT_LOCATION);
  assert.ok(weather, "valid payload must normalize");

  assert.equal(weather.timezone, "Europe/Berlin");
  assert.equal(weather.elevationM, 2718);
  assert.equal(weather.generatedAt, "2026-01-01T11:00:00.000Z");

  assert.equal(weather.current.condition, "partlyCloudy");
  assert.equal(weather.current.temperatureC, 0.5);
  assert.equal(weather.current.apparentTemperatureC, -2.0);
  assert.equal(weather.current.windSpeedKmh, 12.0);
  assert.equal(weather.current.windDirectionDeg, 220);
  assert.equal(weather.current.windGustsKmh, 25.0);
  assert.equal(weather.current.precipitationMm, 0.0);
  assert.equal(weather.current.snowfallCm, 0.0);
  assert.equal(weather.current.cloudCoverPct, 40);
  assert.equal(weather.current.visibilityKm, 27.48);
  assert.equal(weather.current.freezingLevelM, 1850);

  assert.equal(weather.hourly.length, 3);
  assert.equal(weather.hourly[0].time, "2026-01-01T11:00:00.000Z");
  assert.equal(weather.hourly[0].condition, "partlyCloudy");
  assert.equal(weather.hourly[0].temperatureC, 0.5);
  assert.equal(weather.hourly[0].visibilityKm, 27.48);
  assert.equal(weather.hourly[1].condition, "rain");
  assert.equal(weather.hourly[1].visibilityKm, 20.0);
  assert.equal(weather.hourly[2].condition, "rain");

  assert.equal(weather.daily.length, 3);
  assert.equal(weather.daily[0].date, "2026-01-01");
  assert.equal(weather.daily[0].condition, "partlyCloudy");
  assert.equal(weather.daily[0].sunriseUtc, "2026-01-01T07:12:00.000Z");
  assert.equal(weather.daily[0].sunsetUtc, "2026-01-01T15:05:00.000Z");
  assert.equal(weather.daily[1].condition, "thunderstorm");
  assert.equal(weather.daily[2].condition, "snow");
  assert.equal(weather.daily[2].snowfallSumCm, 12.0);
  assert.equal(weather.daily[2].temperatureMaxC, -1.0);
  assert.equal(weather.daily[2].temperatureMinC, -8.0);
  assert.equal(weather.daily[2].windGustsMaxKmh, 45.0);
  assert.equal(weather.daily[2].precipitationSumMm, 8.1);
  assert.equal(weather.daily[2].precipitationProbabilityMaxPct, 60);
}

function testMalformedResponses() {
  assert.equal(normalizeOpenMeteoResponse(null, SUMMIT_LOCATION), null);
  assert.equal(normalizeOpenMeteoResponse("junk", SUMMIT_LOCATION), null);
  assert.equal(normalizeOpenMeteoResponse({}, SUMMIT_LOCATION), null);
  assert.equal(normalizeOpenMeteoResponse(createValidPayload({}), {
    latitude: 46.5368,
    longitude: 8.1182,
    elevationM: 0,
  }), null);
  assert.equal(normalizeOpenMeteoResponse(createValidPayload({ timezone: "Not/AZone" }), SUMMIT_LOCATION), null);

  const sparseCurrent = createValidPayload();
  sparseCurrent.current = { time: "2026-01-01T12:00" };
  assert.equal(normalizeOpenMeteoResponse(sparseCurrent, SUMMIT_LOCATION), null);

  const truncatedHourly = createValidPayload({
    hourly: { temperature_2m: [0.5, 1.0] },
  });
  assert.equal(normalizeOpenMeteoResponse(truncatedHourly, SUMMIT_LOCATION), null);

  const brokenHourly = createValidPayload({
    hourly: { temperature_2m: [0.5, null, 1.5] },
  });
  assert.equal(normalizeOpenMeteoResponse(brokenHourly, SUMMIT_LOCATION), null);

  const brokenCurrent = createValidPayload({
    current: { temperature_2m: Number.NaN },
  });
  assert.equal(normalizeOpenMeteoResponse(brokenCurrent, SUMMIT_LOCATION), null);

  const unknownHourlyCode = createValidPayload({
    hourly: { weather_code: [2, 999, 63] },
  });
  const normalizedUnknown = normalizeOpenMeteoResponse(unknownHourlyCode, SUMMIT_LOCATION);
  assert.equal(normalizedUnknown?.hourly[1].condition, "unknown");

  const nullVisibility = createValidPayload({
    current: { visibility: null },
  });
  const normalizedNullVisibility = normalizeOpenMeteoResponse(nullVisibility, SUMMIT_LOCATION);
  assert.equal(normalizedNullVisibility?.current.visibilityKm, null);

  const badSunrise = createValidPayload({
    daily: { sunrise: ["junk", "2026-01-02T08:12", "2026-01-03T08:13"] },
  });
  const normalizedBadSunrise = normalizeOpenMeteoResponse(
    badSunrise,
    SUMMIT_LOCATION,
  );
  assert.equal(normalizedBadSunrise?.daily[0].sunriseUtc, null);
  assert.equal(normalizedBadSunrise?.daily[0].sunsetUtc, "2026-01-01T15:05:00.000Z");

  const badDailyDate = createValidPayload({
    daily: { time: ["2026-01-01", "nope", "2026-01-03"] },
  });
  assert.equal(normalizeOpenMeteoResponse(badDailyDate, SUMMIT_LOCATION), null);
}

async function testFetchIntegration() {
  const calls = [];

  const okFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => createValidPayload() };
  };

  const weather = await getSummitWeather(SUMMIT_LOCATION, okFetch);
  assert.ok(weather);
  assert.equal(weather.current.visibilityKm, 27.48);

  assert.equal(calls.length, 1);
  const url = calls[0];
  assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.equal(url.searchParams.get("latitude"), String(SUMMIT_LOCATION.latitude));
  assert.equal(url.searchParams.get("longitude"), String(SUMMIT_LOCATION.longitude));
  assert.equal(url.searchParams.get("elevation"), "2718");
  assert.equal(url.searchParams.get("forecast_days"), String(SUMMIT_WEATHER_FORECAST_DAYS));
  assert.equal(url.searchParams.get("forecast_hours"), String(SUMMIT_WEATHER_HOURLY_HOURS));
  assert.equal(url.searchParams.get("timezone"), "auto");
  assert.ok(url.searchParams.get("current").includes("freezing_level_height"));
  assert.ok(url.searchParams.get("current").includes("visibility"));
  assert.ok(url.searchParams.get("hourly").includes("precipitation_probability"));
  assert.ok(url.searchParams.get("daily").includes("sunrise"));
  assert.ok(url.searchParams.get("daily").includes("snowfall_sum"));

  const failingFetch = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await getSummitWeather(SUMMIT_LOCATION, failingFetch), null);

  const corruptFetch = async () => ({
    ok: true,
    json: async () => {
      throw new Error("invalid json");
    },
  });
  assert.equal(await getSummitWeather(SUMMIT_LOCATION, corruptFetch), null);

  const rejectFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await getSummitWeather(SUMMIT_LOCATION, rejectFetch), null);

  let called = false;
  const neverFetch = async () => {
    called = true;
    return { ok: true, json: async () => createValidPayload() };
  };
  assert.equal(await getSummitWeather({ latitude: 500, longitude: 8.1182, elevationM: 2718 }, neverFetch), null);
  assert.equal(called, false);

  assert.equal(SUMMIT_WEATHER_REVALIDATE_SECONDS, 1200);
  assert.equal(SUMMIT_WEATHER_TIMEOUT_MS, 8000);
}

async function testTranslationCoverage() {
  const locales = ["de", "en", "ru"];

  const catalogs = await Promise.all(
    locales.map(async (locale) =>
      JSON.parse(
        await readFile(
          new URL(`../messages/${locale}/mountain.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  );

  const weathers = catalogs.map((catalog) => catalog.Mountain.Weather);

  const keyList = (value) => Object.keys(value).sort().join(",");
  assert.equal(
    new Set(weathers.map((weather) => keyList(weather))).size,
    1,
    "Weather catalog keys differ between locales",
  );
  assert.equal(
    new Set(
      weathers.map((weather) =>
        keyList(weather.conditions),
      ),
    ).size,
    1,
    "Weather condition keys differ between locales",
  );

  const requiredKeys = [
    "sectionLabel",
    "title",
    "subtitle",
    "currentConditions",
    "feelsLike",
    "temperature",
    "wind",
    "windDirection",
    "gusts",
    "precipitation",
    "precipitationSum",
    "snowfall",
    "cloudCover",
    "visibility",
    "freezingLevel",
    "hourlyForecast",
    "hourlyRange",
    "dailyForecast",
    "sunrise",
    "sunset",
    "updated",
    "temperatureMin",
    "temperatureMax",
    "unavailableTitle",
    "unavailableDescription",
    "safetyNoticeTitle",
    "safetyNotice",
  ];

  for (const catalog of catalogs) {
    const weather = catalog.Mountain.Weather;
    const units = catalog.Mountain.Units;

    for (const key of requiredKeys) {
      assert.equal(typeof weather[key], "string", `${catalog.locale ?? ""} Weather.${key} missing`);
      assert.ok(weather[key].length > 0);
    }

    for (const condition of WEATHER_CONDITIONS) {
      assert.equal(typeof weather.conditions[condition], "string", `condition ${condition} missing`);
      assert.ok(weather.conditions[condition].length > 0);
    }

    for (const unit of ["meter", "kilometer", "centimeter", "degree", "speed", "precipitation", "percent"]) {
      assert.equal(typeof units[unit], "string", `Units.${unit} missing`);
    }

    assert.match(weather.safetyNotice, /(weather|Wetter|Погода|погод)/i);
  }
}

testWeatherCodeMapping();
testSummitLocationValidation();
testZonedTimeConversion();
testNormalization();
testMalformedResponses();
await testFetchIntegration();
await testTranslationCoverage();

console.log("Weather WMO code mapping: passed (28 codes)");
console.log("Summit location validation: passed");
console.log("Zoned time conversion: passed");
console.log("Weather normalization: passed");
console.log("Malformed provider responses: passed");
console.log("Provider integration and cache/timeout constants: passed");
console.log("Weather translations: passed (de/en/ru, identical structure)");