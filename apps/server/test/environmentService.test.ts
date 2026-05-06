import { describe, expect, it } from "vitest";

import { EnvironmentService } from "../src/environmentService.js";

describe("EnvironmentService", () => {
  it("stores browser location and maps Open-Meteo weather to MusicGPT context", async () => {
    const service = new EnvironmentService(async (input) => {
      const url = input.toString();
      expect(url).toContain("latitude=31.23");
      expect(url).toContain("longitude=121.47");
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 18.6,
            weather_code: 61
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const context = await service.updateLocation({ latitude: 31.23, longitude: 121.47 });

    expect(context.weather).toBe("rain");
    expect(context.temperature).toBe(19);
    expect(context.location).toMatchObject({ latitude: 31.23, longitude: 121.47 });
    expect(context.updatedAt).toBeDefined();
  });

  it("falls back to time-only context when weather refresh fails", async () => {
    const service = new EnvironmentService(async () => {
      throw new Error("offline");
    });

    const context = await service.updateLocation({ latitude: 31.23, longitude: 121.47 });

    expect(context.weather).toBe("unknown");
    expect(context.location).toMatchObject({ latitude: 31.23, longitude: 121.47 });
  });
});
