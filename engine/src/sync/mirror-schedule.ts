import { CronExpressionParser } from "cron-parser";

export function nextMirrorAt(schedule: string, from: Date): Date {
  const intervals: Record<string, number> = {
    hourly: 60 * 60_000,
    every_6_hours: 6 * 60 * 60_000,
    daily: 24 * 60 * 60_000,
    weekly: 7 * 24 * 60 * 60_000,
  };
  const interval = intervals[schedule];
  if (interval) return new Date(from.getTime() + interval);
  try {
    return CronExpressionParser.parse(schedule, {
      currentDate: from,
      tz: "UTC",
    })
      .next()
      .toDate();
  } catch {
    throw new Error(`invalid mirror schedule "${schedule}"`);
  }
}

export function mirrorIsDue(input: {
  schedule: string;
  now: Date;
  lastSuccessfulAt: Date | null;
  lastScheduledAttemptAt: Date | null;
  scheduledFailuresSinceSuccess: number;
}): boolean {
  const cadenceDue =
    !input.lastSuccessfulAt ||
    nextMirrorAt(input.schedule, input.lastSuccessfulAt).getTime() <=
      input.now.getTime();
  if (!cadenceDue) return false;
  if (!input.lastScheduledAttemptAt) return true;
  const failures = Math.max(0, input.scheduledFailuresSinceSuccess);
  if (failures === 0) return true;
  const backoff = Math.min(
    15 * 60_000 * 2 ** Math.min(failures - 1, 5),
    6 * 60 * 60_000,
  );
  return (
    input.lastScheduledAttemptAt.getTime() + backoff <= input.now.getTime()
  );
}
