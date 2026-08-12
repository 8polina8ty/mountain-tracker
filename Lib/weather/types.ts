export const WEATHER_CONDITIONS = [
  "clear",
  "mostlyClear",
  "partlyCloudy",
  "overcast",
  "fog",
  "drizzle",
  "rain",
  "snow",
  "showers",
  "thunderstorm",
  "unknown",
] as const;

export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

export type SummitLocation = {
  latitude: number;
  longitude: number;
  elevationM: number;
};

export type SummitWeatherCurrent = {
  condition: WeatherCondition;
  temperatureC: number;
  apparentTemperatureC: number;
  windSpeedKmh: number;
  windDirectionDeg: number | null;
  windGustsKmh: number;
  precipitationMm: number | null;
  snowfallCm: number | null;
  cloudCoverPct: number | null;
  visibilityKm: number | null;
  freezingLevelM: number | null;
};

export type SummitWeatherHourly = {
  time: string;
  condition: WeatherCondition;
  temperatureC: number;
  apparentTemperatureC: number | null;
  precipitationProbabilityPct: number | null;
  precipitationMm: number | null;
  snowfallCm: number | null;
  cloudCoverPct: number | null;
  visibilityKm: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  windGustsKmh: number | null;
  freezingLevelM: number | null;
};

export type SummitWeatherDaily = {
  date: string;
  condition: WeatherCondition;
  temperatureMaxC: number;
  temperatureMinC: number;
  precipitationProbabilityMaxPct: number | null;
  precipitationSumMm: number | null;
  snowfallSumCm: number | null;
  windSpeedMaxKmh: number | null;
  windGustsMaxKmh: number | null;
  sunriseUtc: string | null;
  sunsetUtc: string | null;
};

export type SummitWeather = {
  generatedAt: string;
  timezone: string;
  elevationM: number;
  current: SummitWeatherCurrent;
  hourly: SummitWeatherHourly[];
  daily: SummitWeatherDaily[];
};