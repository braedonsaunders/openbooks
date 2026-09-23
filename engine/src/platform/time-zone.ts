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
