'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, SearchSelect } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { ChangeRequestDrawer } from '../ChangeRequestDrawer'

/**
 * Propose-entry point for the change-request queue, opened from the page
 * header through the `propose` search param: pick the employment first (the
 * drawer itself is per-employment), then hand off to the existing authoring
 * drawer. Options ride the existing HRM options route with its refusals.
 * Closing navigates the param away, which re-runs the server that owns the
 * open state. res.ok is checked before any body is parsed.
 */

export function ProposeChangeDialog({
  departmentOptions,
  employmentLabel,
  employmentPlaceholder,
  emptyLabel,
  requestFailed,
  closeHref,
}: {
  departmentOptions: { value: string; label: string }[]
  employmentLabel: string
  employmentPlaceholder: string
  emptyLabel: string
  requestFailed: string
  closeHref: string
}) {
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [employmentId, setEmploymentId] = useState('')
  const [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const requestId = useRef(0)

  const close = (): void => {
    router.push(closeHref as never)
  }

  useEffect(() => {
    const id = (requestId.current += 1)
    const params = new URLSearchParams()
    params.set('source', 'employments')
    params.set('limit', '25')
    if (query.trim()) params.set('q', query.trim())
    if (employmentId) params.set('include', employmentId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== requestId.current) return
        if (!res.ok) {
          setStatus(await readApiErrorMessage(res, requestFailed))
          setLoading(false)
          return
        }
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { employmentId?: unknown; label?: unknown }[]
        }
        if (id !== requestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const merged: { value: string; label: string }[] = []
        for (const row of page) {
          if (typeof row.employmentId === 'string' && typeof row.label === 'string') {
            merged.push({ value: row.employmentId, label: row.label })
          }
        }
        if (employmentId && !merged.some((option) => option.value === employmentId)) {
          merged.push({ value: employmentId, label: employmentId })
        }
        setOptions(merged)
        setStatus(undefined)
        setLoading(false)
      })
      .catch(() => {
        if (id !== requestId.current) return
        setStatus(requestFailed)
        setLoading(false)
      })
  }, [query, employmentId, requestFailed])

  if (employmentId) {
    return (
      <ChangeRequestDrawer
        employmentId={employmentId}
        initialRequest={null}
        departmentOptions={departmentOptions}
        onClose={close}
        onSaved={() => {
          router.refresh()
          close()
        }}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={employmentLabel}>
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-5 shadow-xl dark:bg-slate-900">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{employmentLabel}</p>
        <SearchSelect
          id="queue-propose-employment"
          value={employmentId}
          onChange={(next) => setEmploymentId(next)}
          options={options}
          ariaLabel={employmentLabel}
          sheetTitle={employmentLabel}
          emptyLabel={employmentPlaceholder || emptyLabel}
          remote
          loading={loading}
          statusMessage={status}
          statusTone={status ? 'error' : 'muted'}
          onSearchChange={(next) => {
            setQuery(next)
            setLoading(true)
            setStatus(undefined)
          }}
        />
        {status ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {status}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            {tCommon('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
