/** Employee and staff forms use the same IANA wall-clock choices as the domain. */
export {
  localTimeFields,
  resolveLocalTime,
  listCanonicalTimeZones as timeZoneOptions,
  type LocalTime,
  type ZonedTimeChoice,
} from '@openbooks/engine/platform/time-zone'
