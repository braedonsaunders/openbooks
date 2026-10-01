'use client'

import { useEffect, useState } from 'react'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { ChangeRequestDrawer, type DepartmentOption } from '../ChangeRequestDrawer'

export interface ChartEditRequest { employmentId: string; managerId?: string }

/** Resolve the authoritative assignment before mounting the native authoring drawer. */
export function OrgChartEditor({ request, today, departmentOptions, labels, onClose, stacked = false }: {
  request: ChartEditRequest
  today: string
  departmentOptions: DepartmentOption[]
  labels: Record<string, string>
  onClose: () => void
  stacked?: boolean
}) {
  const [state, setState] = useState<{ values?: Record<string, unknown>; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setState({})
    void (async () => {
      try {
        const response = await fetch(`/api/hrm/employments/${encodeURIComponent(request.employmentId)}?effectiveDate=${today}`, { signal: abort.signal })
        if (!response.ok) throw new Error(await readApiErrorMessage(response, labels.editFailed))
        const body = await response.json() as { record?: {
          asOfRefusal?: { message?: string } | null
          asOf?: { assignments?: { assignmentKey: string; isPrimary: boolean }[] } | null
        } }
        if (body.record?.asOfRefusal) throw new Error(body.record.asOfRefusal.message || labels.editFailed)
        const primary = body.record?.asOf?.assignments?.filter((assignment) => assignment.isPrimary) ?? []
        if (primary.length !== 1 || !primary[0].assignmentKey) throw new Error(labels.noAssignment)
        if (!abort.signal.aborted) setState({ values: {
          kind: 'assignment_change', assignmentKey: primary[0].assignmentKey, effectiveFrom: today,
          ...(request.managerId ? { managerEmploymentId: request.managerId } : {}),
        } })
      } catch (error) {
        if (!abort.signal.aborted) setState({ error: error instanceof Error ? error.message : labels.editFailed })
      }
    })()
    return () => abort.abort()
  }, [request.employmentId, request.managerId, today, attempt, labels])
  if (state.values) return <ChangeRequestDrawer employmentId={request.employmentId} initialRequest={null}
    initialValues={state.values} departmentOptions={departmentOptions} stacked={stacked} onClose={onClose} onSaved={onClose} />
  return <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900" role={state.error ? 'alert' : 'status'}>
    <p className={state.error ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}>{state.error ?? labels.preparingEdit}</p>
    {state.error && <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>{labels.retry}</Button>}
    <Button size="sm" variant="ghost" onClick={onClose}>{labels.cancel}</Button>
  </div>
}
