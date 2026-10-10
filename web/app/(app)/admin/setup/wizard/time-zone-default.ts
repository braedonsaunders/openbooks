/**
 * The business time zone a new company starts on, derived from its country.
 * Pure and client-safe: the per-country zone directory comes from the server
 * (engine `countryTimeZoneDirectory`), so every operator sees the same
 * country→zone answer regardless of browser.
 *
 * The operator's own browser zone wins only when it belongs to the chosen
 * country — someone in Chicago setting up a US company starts on Chicago,
 * while someone in Toronto setting up a US company starts on the country's
 * representative zone instead of their own foreign one.
 */

export type CountryTimeZoneDirectory = Readonly<Record<string, { zones: readonly string[]; primary: string }>>

/** Two zone spellings name the same zone ("Asia/Kolkata" and "Asia/Calcutta").
 *  Resolved through the runtime, never a hand-kept alias table. */
export function sameTimeZone(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const resolve = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).resolvedOptions().timeZone
    return resolve(a) === resolve(b)
  } catch {
    return false
  }
}

export function defaultBusinessTimeZone(args: {
  country: string
  browserZone: string | null
  directory: CountryTimeZoneDirectory
  /** Zones the picker can show; the default is always one of them. */
  offered: ReadonlySet<string>
  sameZone?: (a: string, b: string) => boolean
}): string {
  const same = args.sameZone ?? sameTimeZone
  const entry = args.directory[args.country]
  const browser = args.browserZone
  if (!entry || entry.zones.length === 0) {
    // A country the runtime has no zones for: the operator's own zone is the
    // best available evidence, UTC when the picker cannot show it.
    return browser && args.offered.has(browser) ? browser : 'UTC'
  }
  if (browser) {
    const local = entry.zones.find((zone) => same(zone, browser))
    if (local && args.offered.has(local)) return local
  }
  if (args.offered.has(entry.primary)) return entry.primary
  return entry.zones.find((zone) => args.offered.has(zone)) ?? 'UTC'
}
