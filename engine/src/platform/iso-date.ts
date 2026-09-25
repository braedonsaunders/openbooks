/** True only for a persisted Gregorian date in YYYY-MM-DD form, years 0001–9999. */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() >= 1
    && date.toISOString().slice(0, 10) === value;
}
