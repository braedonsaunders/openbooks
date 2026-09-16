/** Time-of-day greeting with the user's first name. Shared by the native
 *  dashboard render and the ViewSpec loader so both paths stay byte-identical
 *  (moved here from page.tsx; the loader imports it rather than copying it).
 *
 *  The stem follows the VIEWER's clock: pass the viewer's IANA zone
 *  (browser zone on the client, org zone for the server paint). An omitted
 *  zone keeps the runtime's local hour; an unrecognized zone falls back to
 *  UTC rather than guessing. Never rely on the server's own zone — a UTC
 *  server says "Good morning" at 8 PM viewer-local. */
export function buildGreeting(
  now: Date,
  name: string | null,
  copy: { morning: string; afternoon: string; evening: string },
  timeZone?: string,
): string {
  const hour = hourInZone(now, timeZone)
  const stem = hour < 12 ? copy.morning : hour < 17 ? copy.afternoon : copy.evening
  const firstName = name?.trim().split(/\s+/)[0] ?? null
  return firstName ? `${stem}, ${firstName}` : stem
}

function hourInZone(now: Date, timeZone?: string): number {
  if (!timeZone) return now.getHours()
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now)
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    if (Number.isFinite(hour)) return hour % 24
  } catch {
    // Unrecognized zone below.
  }
  return now.getUTCHours()
}
