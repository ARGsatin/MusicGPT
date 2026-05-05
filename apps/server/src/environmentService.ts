import { currentPeriod } from "./time.js";

import type {
  EnvironmentContext,
  EnvironmentLocation,
  EnvironmentLocationRequest,
  WeatherKind
} from "@musicgpt/shared";

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
  };
}

export class EnvironmentService {
  private context: EnvironmentContext = createFallbackContext();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  getContext(): EnvironmentContext {
    return {
      ...this.context,
      dayPeriod: currentPeriod()
    };
  }

  async updateLocation(location: EnvironmentLocationRequest): Promise<EnvironmentContext> {
    const normalized: EnvironmentLocation = {
      latitude: location.latitude,
      longitude: location.longitude
    };
    if (location.label?.trim()) {
      normalized.label = location.label.trim();
    }

    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(normalized.latitude));
      url.searchParams.set("longitude", String(normalized.longitude));
      url.searchParams.set("current", "temperature_2m,weather_code");
      url.searchParams.set("timezone", "auto");
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        throw new Error(`weather request failed: ${response.status}`);
      }
      const payload = (await response.json()) as OpenMeteoResponse;
      const nextContext: EnvironmentContext = {
        dayPeriod: currentPeriod(),
        weather: mapWeatherCode(payload.current?.weather_code),
        location: normalized,
        updatedAt: new Date().toISOString()
      };
      if (typeof payload.current?.temperature_2m === "number") {
        nextContext.temperature = Math.round(payload.current.temperature_2m);
      }
      this.context = nextContext;
      return this.context;
    } catch {
      this.context = {
        dayPeriod: currentPeriod(),
        weather: "unknown",
        location: normalized,
        updatedAt: new Date().toISOString()
      };
      return this.context;
    }
  }
}

function createFallbackContext(): EnvironmentContext {
  return {
    dayPeriod: currentPeriod(),
    weather: "unknown",
    updatedAt: new Date().toISOString()
  };
}

function mapWeatherCode(code: number | undefined): WeatherKind {
  if (typeof code !== "number") {
    return "unknown";
  }
  if (code === 0 || code === 1) {
    return "clear";
  }
  if (code === 2 || code === 3) {
    return "cloudy";
  }
  if ((code >= 45 && code <= 48) || code === 77) {
    return "fog";
  }
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return "rain";
  }
  if ((code >= 71 && code <= 86) || (code >= 85 && code <= 86)) {
    return "snow";
  }
  if (code >= 95 && code <= 99) {
    return "storm";
  }
  return "unknown";
}
