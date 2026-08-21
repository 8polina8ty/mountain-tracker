import type { LucideIcon } from "lucide-react";
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudRainWind, CloudSnow, CloudSun, Cloudy, Sun } from "lucide-react";

import type { WeatherCondition } from "@/Lib/weather/types";

export const WEATHER_CONDITION_ICONS: Record<WeatherCondition, LucideIcon> = {
  clear: Sun,
  mostlyClear: CloudSun,
  partlyCloudy: Cloudy,
  overcast: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  showers: CloudRainWind,
  thunderstorm: CloudLightning,
  unknown: Cloud,
};
