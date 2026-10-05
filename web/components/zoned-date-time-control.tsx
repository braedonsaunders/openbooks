'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Input, Label, Select } from '@openbooks/ui'
import { localTimeFields, resolveLocalTime, type LocalTime } from '@/lib/zoned-date-time'

/** Shared date/time control preserves instants and refuses unresolved daylight-saving choices. */
export function ZonedDateTimeControl({
  value,
  zone,
  onChange,
  label,
  readOnly = false,
}: {
  value: string
  zone: string
  onChange: (value: string) => void
  label: string
  readOnly?: boolean
}) {
  const t = useTranslations('admin.setup.zonedTime'),
    locale = useLocale()
  const [state, setState] = useState(() => ({
    source: value,
    zone,
    local: localTimeFields(value, zone) ?? { date: '', time: '' },
  }))
  if (state.source !== value || state.zone !== zone) {
    const next = localTimeFields(value, zone) ?? (state.source === value ? state.local : { date: '', time: '' })
    setState({ source: value, zone, local: next })
  }
  const local = state.local
  const resolution = useMemo(() => resolveLocalTime(local, zone), [local, zone])
  function change(next: LocalTime) {
    const resolved = resolveLocalTime(next, zone)
    const result = resolved.choices.length === 1 ? resolved.choices[0]!.instant : ''
    setState({ source: result, zone, local: next })
    onChange(result)
  }
  if (readOnly) {
    let display = value || '—'
    if (value && zone && Number.isFinite(Date.parse(value))) {
      try {
        display = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', timeZone: zone }).format(
          new Date(value),
        )
      } catch {
        /* An invalid stored zone remains visible for correction. */
      }
    }
    return <p className="text-sm text-slate-600 dark:text-slate-300">{display}</p>
  }
  const selected =
    resolution.choices.find(
      (choice) => Number.isFinite(Date.parse(value)) && Date.parse(choice.instant) === Date.parse(value),
    )?.instant ?? ''
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>{t('date')}</Label>
          <Input
            aria-label={`${label} · ${t('date')}`}
            type="date"
            disabled={!zone}
            value={local.date}
            onChange={(event) => change({ ...local, date: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('time')}</Label>
          <Input
            aria-label={`${label} · ${t('time')}`}
            type="time"
            disabled={!zone}
            step={1}
            value={local.time}
            onChange={(event) => change({ ...local, time: event.target.value })}
          />
        </div>
      </div>
      {!zone ? (
        <p role="status" className="text-sm text-slate-500">
          {t('chooseZone')}
        </p>
      ) : null}
      {resolution.kind === 'gap' ? (
        <p role="alert" className="text-sm text-red-600">
          {t('gap')}
        </p>
      ) : null}
      {resolution.choices.length > 1 || (resolution.choices.length === 1 && !selected) ? (
        <div className="space-y-1">
          <Label>{t('occurrence')}</Label>
          <Select
            aria-label={`${label} · ${t('occurrence')}`}
            value={selected}
            onChange={(event) => {
              setState({ source: event.target.value, zone, local })
              onChange(event.target.value)
            }}
          >
            <option value="" disabled>
              {resolution.choices.length > 1 ? t('repeated') : t('occurrence')}
            </option>
            {resolution.choices.map((choice) => (
              <option key={choice.instant} value={choice.instant}>
                {choice.offset}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  )
}
