import { describe, expect, it } from "vitest";

import {
  AUTO_SPEAK_STORAGE_KEY,
  getDuckedPlayerVolume,
  loadAutoSpeak,
  saveAutoSpeak
} from "./speech";

describe("Realtime speech preferences", () => {
  it("persists auto-speak and ducks music without changing mute intent", () => {
    expect(loadAutoSpeak(undefined)).toBe(true);

    let savedKey = "";
    let savedValue = "";
    saveAutoSpeak(
      {
        setItem(key, value) {
          savedKey = key;
          savedValue = value;
        }
      },
      false
    );

    expect(savedKey).toBe(AUTO_SPEAK_STORAGE_KEY);
    expect(savedValue).toBe("false");
    expect(loadAutoSpeak({ getItem: () => "false" })).toBe(false);
    expect(getDuckedPlayerVolume({ level: 0.8, muted: false }, true)).toEqual({
      level: 0.2,
      muted: false
    });
    expect(getDuckedPlayerVolume({ level: 0.8, muted: true }, true)).toEqual({
      level: 0.8,
      muted: true
    });
  });
});
