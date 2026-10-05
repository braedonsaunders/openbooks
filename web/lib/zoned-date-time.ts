import { isIsoCalendarDate } from '@openbooks/engine/platform/civil-date'

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

/** Enumerate actual instants: a missing hour has none, a repeated hour needs an explicit choice. */
export function resolveLocalTime(
  local: LocalTime,
  zone: string,
): { kind: 'invalid' | 'gap' | 'ready'; choices: ZonedTimeChoice[] } {
  if (
    !isIsoCalendarDate(local.date) ||
    !/^\d{2}:\d{2}(?::\d{2})?$/.test(local.time) ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)
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

export function timeZoneOptions(): string[] {
  return ['UTC', ...Intl.supportedValuesOf('timeZone')]
}
