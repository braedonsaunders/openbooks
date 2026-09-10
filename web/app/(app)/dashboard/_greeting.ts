/** Time-of-day greeting with the user's first name. Shared by the native
 *  dashboard render and the ViewSpec loader so both paths stay byte-identical
 *  (moved here from page.tsx; the loader imports it rather than copying it). */
export function buildGreeting(
  now: Date,
  name: string | null,
  copy: { morning: string; afternoon: string; evening: string },
): string {
  const hour = now.getHours()
  const stem = hour < 12 ? copy.morning : hour < 17 ? copy.afternoon : copy.evening
  const firstName = name?.trim().split(/\s+/)[0] ?? null
  return firstName ? `${stem}, ${firstName}` : stem
}
