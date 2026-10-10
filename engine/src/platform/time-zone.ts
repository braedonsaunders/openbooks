import { isIsoCalendarDate } from "./civil-date.ts";

/**
 * Business time-zone validation shared by the
 * Company Settings save path, business-date reads, and field-time day math.
 *
 * `Intl.supportedValuesOf("timeZone")` is not exhaustive: Node accepts
 * aliases such as "US/Eastern" and "Etc/GMT+5" in Intl.DateTimeFormat while
 * omitting them from the list, so membership in that set is the wrong test
 * and silently drops real zones to UTC. The correct test is whether the
 * runtime itself accepts the zone, and the stored form is always the
 * canonical runtime identifier from `resolvedOptions().timeZone`, so an alias saved
 * anywhere (API, assistant, SQL) keeps working and never becomes UTC.
 *
 * Pure (no database), so unit tests and the database-free field-time module
 * can both use it without loading the platform stack.
 */

/** Every zone this runtime's Intl.DateTimeFormat accepts. */
export function isKnownTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return canonicalTimeZone(value) !== null;
}

/**
 * The canonical identifier for a zone the runtime accepts ("US/Eastern" →
 * "America/New_York"), or null when the value is not a usable zone.
 * Trims surrounding whitespace; non-strings and blanks are null.
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Resolve a datetime-local civil value in an explicit supported zone. DST gaps
 * and repeated wall-clock times are refused so a booking is never shifted
 * or assigned to an arbitrary occurrence.
 */
export function civilDateTimeToInstant(value: string, timeZone: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/.exec(value)
  const zone = canonicalTimeZone(timeZone)
  if (!match || !zone) throw new RangeError('Enter a valid local date and time in a supported time zone.')
  const result = resolveLocalTime({ date: match[1]!, time: match[2]! }, zone, { allowOffsetZone: true })
  if (result.kind === 'invalid') throw new RangeError('Enter a valid local date and time in a supported time zone.')
  if (result.kind === 'gap') throw new RangeError('That local time does not exist because the clocks change in this time zone.')
  if (result.choices.length > 1) throw new RangeError('That local time occurs twice because the clocks change in this time zone; choose another time.')
  return new Date(result.choices[0]!.instant)
}

/**
 * The canonical zone names a picker can offer, sorted with UTC first. UTC
 * is unioned in because enumeration omits it (like the US/Eastern-style
 * aliases) while every runtime still formats it — a picker built from the
 * raw list could not offer the default zone.
 */
export function listCanonicalTimeZones(): string[] {
  if (typeof Intl.supportedValuesOf !== "function") return ["UTC"];
  try {
    const rest = [...Intl.supportedValuesOf("timeZone")]
      .filter((zone) => zone !== "UTC")
      .sort();
    return ["UTC", ...rest];
  } catch {
    return ["UTC"];
  }
}

/**
 * The zone that represents a multi-zone country when nothing better is known
 * (the seat of government or the dominant commercial zone). Only countries
 * spanning more than one zone need an entry: a single-zone country's zone is
 * derived from the runtime below. An entry the runtime does not list for its
 * country is ignored rather than trusted.
 */
const PRIMARY_COUNTRY_TIME_ZONES: Readonly<Record<string, string>> = {
  AR: "America/Argentina/Buenos_Aires",
  AU: "Australia/Sydney",
  BR: "America/Sao_Paulo",
  CA: "America/Toronto",
  CD: "Africa/Kinshasa",
  CL: "America/Santiago",
  CN: "Asia/Shanghai",
  CY: "Asia/Nicosia",
  DE: "Europe/Berlin",
  EC: "America/Guayaquil",
  ES: "Europe/Madrid",
  FM: "Pacific/Pohnpei",
  GL: "America/Nuuk",
  ID: "Asia/Jakarta",
  KI: "Pacific/Tarawa",
  KZ: "Asia/Almaty",
  MH: "Pacific/Majuro",
  MN: "Asia/Ulaanbaatar",
  MX: "America/Mexico_City",
  MY: "Asia/Kuala_Lumpur",
  NZ: "Pacific/Auckland",
  PF: "Pacific/Tahiti",
  PG: "Pacific/Port_Moresby",
  PS: "Asia/Hebron",
  PT: "Europe/Lisbon",
  RU: "Europe/Moscow",
  UA: "Europe/Kyiv",
  UM: "Pacific/Wake",
  US: "America/New_York",
  UZ: "Asia/Tashkent",
};

/**
 * The runtime's zones for an ISO 3166-1 alpha-2 country, canonicalized the
 * same way stored zones are, sorted. Empty when the runtime knows none (an
 * uninhabited territory) or cannot answer.
 */
export function countryTimeZones(country: string): string[] {
  if (!/^[A-Z]{2}$/.test(country)) return [];
  try {
    const locale = new Intl.Locale(`und-${country}`) as Intl.Locale & {
      getTimeZones?: () => string[] | undefined;
      timeZones?: string[];
    };
    const zones = locale.getTimeZones?.() ?? locale.timeZones ?? [];
    return [...new Set(zones.map((zone) => canonicalTimeZone(zone)).filter((zone): zone is string => zone !== null))].sort();
  } catch {
    return [];
  }
}

/** A country's representative zone, or null when the runtime lists none. */
export function primaryCountryTimeZone(country: string): string | null {
  const zones = countryTimeZones(country);
  if (zones.length === 0) return null;
  const declared = canonicalTimeZone(PRIMARY_COUNTRY_TIME_ZONES[country]);
  if (declared && zones.includes(declared)) return declared;
  return zones[0]!;
}

export interface CountryTimeZones {
  zones: string[];
  /** The zone a new company in this country starts on (UTC when none). */
  primary: string;
}

/** Zones and representative zone per country, for pickers that default the
 *  business time zone from the chosen country. */
export function countryTimeZoneDirectory(countries: readonly string[]): Record<string, CountryTimeZones> {
  return Object.fromEntries(
    countries.map((country) => [
      country,
      { zones: countryTimeZones(country), primary: primaryCountryTimeZone(country) ?? "UTC" },
    ]),
  );
}

export type LocalTime = { date: string; time: string }
export type ZonedTimeChoice = { instant: string; offset: string }

function formatter(zone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}
function parts(at: Date, format: Intl.DateTimeFormat): LocalTime {
  const entries = format.formatToParts(at)
  const part = (key: Intl.DateTimeFormatPartTypes) => entries.find((item) => item.type === key)!.value
  return {
    date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}:${part('second')}`,
  }
}
export function localTimeFields(instant: string, zone: string): LocalTime | null {
  if (!instant || !zone || !Number.isFinite(Date.parse(instant))) return null
  try {
    return parts(new Date(instant), formatter(zone))
  } catch {
    return null
  }
}

/**
 * Enumerate actual instants: a missing hour has none, a repeated hour needs an explicit choice.
 * Named-zone controls reject numeric offset zones. Existing booking callers may
 * explicitly retain fixed-offset support through allowOffsetZone.
 */
export function resolveLocalTime(
  local: LocalTime,
  zone: string,
  options: { allowOffsetZone?: boolean } = {},
): { kind: 'invalid' | 'gap' | 'ready'; choices: ZonedTimeChoice[] } {
  if (
    !isIsoCalendarDate(local.date) ||
    !/^\d{2}:\d{2}(?::\d{2})?$/.test(local.time) ||
    (!options.allowOffsetZone && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)) ||
    canonicalTimeZone(zone) === null
  )
    return { kind: 'invalid', choices: [] }
  const time = local.time.length === 5 ? `${local.time}:00` : local.time
  const [hour, minute, second] = time.split(':').map(Number)
  if (hour! > 23 || minute! > 59 || second! > 59) return { kind: 'invalid', choices: [] }
  let format: Intl.DateTimeFormat
  try {
    format = formatter(zone)
  } catch {
    return { kind: 'invalid', choices: [] }
  }
  const wall = Date.parse(`${local.date}T${time}Z`),
    offsets = new Set<number>()
  // Sample both sides of nearby transitions; derive offsets from IANA rules,
  // including historical second offsets, rather than assuming whole hours.
  for (let delta = -48; delta <= 48; delta += 6) {
    const sample = wall + delta * 3600000
    const rendered = parts(new Date(sample), format)
    if (!isIsoCalendarDate(rendered.date)) continue
    offsets.add(Date.parse(`${rendered.date}T${rendered.time}Z`) - sample)
  }
  const choices: ZonedTimeChoice[] = []
  for (const offset of offsets) {
    const candidate = new Date(wall - offset),
      rendered = parts(candidate, format)
    if (rendered.date !== local.date || rendered.time !== time) continue
    const seconds = Math.abs(offset) / 1000
    const two = (number: number) => String(number).padStart(2, '0')
    const label = `UTC${offset < 0 ? '-' : '+'}${two(Math.floor(seconds / 3600))}:${two(Math.floor((seconds % 3600) / 60))}${seconds % 60 ? `:${two(seconds % 60)}` : ''}`
    choices.push({ instant: candidate.toISOString(), offset: label })
  }
  choices.sort((a, b) => a.instant.localeCompare(b.instant))
  return { kind: choices.length ? 'ready' : 'gap', choices }
}
