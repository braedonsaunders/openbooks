/**
 * Business time-zone validation — the ONE zone validator shared by the
 * Company Settings save path, business-date reads, and field-time day math.
 *
 * `Intl.supportedValuesOf("timeZone")` is not exhaustive: Node accepts
 * aliases such as "US/Eastern" and "Etc/GMT+5" in Intl.DateTimeFormat while
 * omitting them from the list, so membership in that set is the wrong test
 * and silently drops real zones to UTC. The correct test is whether the
 * runtime itself accepts the zone, and the stored form is always the
 * canonical IANA name from `resolvedOptions().timeZone`, so an alias saved
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
 * The canonical IANA name for a zone the runtime accepts ("US/Eastern" →
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
 * Resolve a datetime-local civil value in an explicit IANA zone. DST gaps
 * and repeated wall-clock times are refused so a booking is never shifted
 * or assigned to an arbitrary occurrence.
 */
export function civilDateTimeToInstant(value: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  const zone = canonicalTimeZone(timeZone)
  if (!match || !zone) throw new RangeError('Enter a valid local date and time in a supported time zone.')

  const wanted = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
  }
  const civilAsUtc = (parts: typeof wanted) => {
    const date = new Date(0)
    date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
    date.setUTCHours(parts.hour, parts.minute, parts.second, 0)
    return date.getTime()
  }
  const target = civilAsUtc(wanted)
  const roundTrip = new Date(target)
  if (
    wanted.year < 1 || roundTrip.getUTCFullYear() !== wanted.year ||
    roundTrip.getUTCMonth() + 1 !== wanted.month || roundTrip.getUTCDate() !== wanted.day ||
    roundTrip.getUTCHours() !== wanted.hour || roundTrip.getUTCMinutes() !== wanted.minute ||
    roundTrip.getUTCSeconds() !== wanted.second
  ) throw new RangeError('Enter a valid local date and time in a supported time zone.')

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const localParts = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant))
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
  }
  const matches = (have: ReturnType<typeof localParts>) =>
    have.year === wanted.year && have.month === wanted.month && have.day === wanted.day &&
    have.hour === wanted.hour && have.minute === wanted.minute && have.second === wanted.second

  const candidates = new Set<number>()
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    let guess = target + hours * 60 * 60 * 1000
    for (let attempt = 0; attempt < 6; attempt++) {
      const have = localParts(guess)
      const difference = target - civilAsUtc(have)
      if (difference === 0) {
        if (matches(have)) candidates.add(guess)
        break
      }
      guess += difference
    }
  }
  if (candidates.size === 0) throw new RangeError('That local time does not exist because the clocks change in this time zone.')
  if (candidates.size > 1) throw new RangeError('That local time occurs twice because the clocks change in this time zone; choose another time.')
  return new Date([...candidates][0]!)
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
