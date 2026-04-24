import type { DayPeriod } from "@musicgpt/shared";

export function periodFromHour(hour: number): DayPeriod {
  if (hour >= 6 && hour < 12) {
    return "morning";
  }
  if (hour >= 12 && hour < 18) {
    return "afternoon";
  }
  if (hour >= 18 && hour < 24) {
    return "evening";
  }
  return "late_night";
}

export function currentPeriod(now = new Date()): DayPeriod {
  return periodFromHour(now.getHours());
}
