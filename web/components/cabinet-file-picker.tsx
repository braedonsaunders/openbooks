'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { SearchSelect } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'

/** The qualification evidence picker, shared by record workflows; Cabinet owns visibility. */
export function CabinetFilePicker({
  value,
  onChange,
  label,
  disabled = false,
  id,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  id?: string
}) {
  const t = useTranslations('hrm.qualifications.recordForm')
  const [query, setQuery] = useState(''),
    [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false)
  useEffect(() => {
    if (query.trim().length < 2) return
    const controller = new AbortController()
    let active = true
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      const timeout = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`/api/file-cabinet/files?q=${encodeURIComponent(query.trim())}&perPage=20`, {
          signal: controller.signal,
        })
        if (!response.ok) {
          const message = await readApiErrorMessage(response, t('evidenceSearchFailed'))
          if (active) setError(message)
          return
        }
        const payload = (await response.json()) as { files?: unknown }
        if (!Array.isArray(payload.files)) throw new Error('Unreadable cabinet response')
        const rows = payload.files.flatMap((file) => {
          if (!file || typeof file !== 'object') return []
          const row = file as { id?: unknown; name?: unknown }
          return typeof row.id === 'string' && typeof row.name === 'string' ? [{ value: row.id, label: row.name }] : []
        })
        if (active) setOptions(rows)
      } catch {
        if (active) setError(t('evidenceSearchFailed'))
      } finally {
        clearTimeout(timeout)
        if (active) setLoading(false)
      }
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, t])
  return (
    <SearchSelect
      id={id}
      ariaLabel={label}
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      placeholder={t('evidencePlaceholder')}
      searchPlaceholder={t('evidenceSearchPlaceholder')}
      emptyLabel={t('evidenceSearchHint')}
      statusMessage={error ?? (query.trim().length < 2 ? t('evidenceSearchHint') : undefined)}
      statusTone={error ? 'error' : 'muted'}
      loading={loading}
      remote
      searchable
      onSearchChange={(next) => {
        setQuery(next)
        setOptions([])
        setError(null)
        setLoading(next.trim().length >= 2)
      }}
    />
  )
}
