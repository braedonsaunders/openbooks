'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { ContinuousData } from './continuous-view'

type Detail = NonNullable<NonNullable<ContinuousData['talent']>['planDetail']>

/** One plan, its governed lifecycle, and its ranked successor candidates. */
export function SuccessionPlanDrawer({ detail }: { detail: Detail }) {
  const router = useRouter()
  const [status, setStatus] = useState(detail.status)
  const [notes, setNotes] = useState(detail.notes)
  const [employmentId, setEmploymentId] = useState('')
  const [readiness, setReadiness] = useState(
    detail.readinessOptions[0]?.value ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function write(
    url: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, detail.failed))
        return
      }
      setEmploymentId('')
      router.refresh()
    } catch {
      setError(detail.failed)
    } finally {
      setBusy(false)
    }
  }
  const planUrl = `/api/hrm/succession-plans?id=${encodeURIComponent(detail.id)}`
  const candidateUrl = `/api/hrm/succession-plans/${encodeURIComponent(detail.id)}/candidates`
  return (
    <UrlDrawer open title={detail.title} closeHref={detail.closeHref}>
      <div className="space-y-6">
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="succession-status">{detail.statusLabel}</Label>
          <div className="flex items-end gap-2">
            <Select
              id="succession-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {detail.statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              disabled={busy || status === detail.status}
              onClick={() => write(planUrl, 'PATCH', { status })}
            >
              {detail.saveLabel}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="succession-notes">{detail.notesLabel}</Label>
          <Textarea
            id="succession-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || notes === detail.notes}
            onClick={() =>
              write(planUrl, 'PATCH', { notes: notes.trim() || null })
            }
          >
            {detail.saveLabel}
          </Button>
        </div>
        <PagedTable
          source="hrm_succession_candidates"
          rows={detail.candidates}
          rowKey={(row) => row.id}
          empty={detail.empty}
          columns={[
            {
              key: 'employee',
              header: detail.employeeLabel,
              cell: (row) => row.name,
            },
            {
              key: 'readiness',
              header: detail.readinessLabel,
              cell: (row) => row.readiness,
            },
            {
              key: 'remove',
              header: '',
              cell: (row) => (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    write(candidateUrl, 'PATCH', { candidateId: row.id })
                  }
                >
                  {detail.removeLabel}
                </Button>
              ),
            },
          ]}
        />
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void write(candidateUrl, 'POST', { employmentId, readiness })
          }}
        >
          <Label htmlFor="successor-employment">{detail.employeeLabel}</Label>
          <Select
            id="successor-employment"
            value={employmentId}
            onChange={(event) => setEmploymentId(event.target.value)}
          >
            <option value="">{detail.employeeLabel}</option>
            {detail.employments.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Label htmlFor="successor-readiness">{detail.readinessLabel}</Label>
          <Select
            id="successor-readiness"
            value={readiness}
            onChange={(event) => setReadiness(event.target.value)}
          >
            {detail.readinessOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button disabled={busy || !employmentId || !readiness}>
            {detail.addLabel}
          </Button>
        </form>
      </div>
    </UrlDrawer>
  )
}
