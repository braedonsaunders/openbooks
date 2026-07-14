'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { FieldValueMap, FormField } from '@openbooks/forms-core'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { RecordFields } from '../../../../components/record-fields'
import type { RecordStatus } from '../../../../lib/record-schema'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  draft: 'secondary',
  inactive: 'outline',
}

type ApiError = { fieldId: string; message: string }

/**
 * The custom-record flyout — instant draft, autosaving editor rendering every
 * field type via <RecordFields>, plus activate/deactivate. Records are master
 * data: they stay editable while ACTIVE (autosave keeps running); only
 * inactive records are read-only until reactivated.
 */
export function RecordDrawer({
  typeKey,
  typeName,
  fields,
  record,
  canEdit,
}: {
  typeKey: string
  typeName: string
  fields: FormField[]
  record: { id: string; recordNumber: string; data: FieldValueMap; status: RecordStatus }
  canEdit: boolean
}) {
  const router = useRouter()
  const [status, setStatus] = useState<RecordStatus>(record.status)
  const [values, setValues] = useState<FieldValueMap>(record.data ?? {})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [busy, setBusy] = useState(false)

  const editable = canEdit && status !== 'inactive'
  const closeHref = `/records/${typeKey}`

  // -- autosave (debounced PATCH; drafts AND active records) -------------------
  const first = useRef(true)
  useEffect(() => {
    if (!editable) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/records/${typeKey}/${record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: values }),
      })
      const data = await res.json()
      if (res.ok) {
        setErrors({})
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('dirty')
        setErrors(mapErrors(data.errors))
        toast.error(data.error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, editable])

  async function transition(next: 'active' | 'inactive') {
    setBusy(true)
    const res = await fetch(`/api/records/${typeKey}/${record.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // Send the latest values with an activation so a just-typed required
      // field counts even if its debounce hadn't fired yet.
      body: JSON.stringify(next === 'active' && editable ? { data: values, status: next } : { status: next }),
    })
    const data = await res.json()
    if (!res.ok) {
      setErrors(mapErrors(data.errors))
      toast.error(data.error ?? 'Action failed')
    } else {
      setErrors({})
      setStatus(next)
      setSaveState('saved')
      toast.success(
        next === 'active'
          ? status === 'draft'
            ? `${record.recordNumber} is now active`
            : `${record.recordNumber} reactivated`
          : `${record.recordNumber} deactivated`,
      )
    }
    setBusy(false)
    router.refresh()
  }

  async function destroy() {
    const ok = await confirmDialog({
      message: `Delete draft ${record.recordNumber}? This cannot be undone.`,
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/records/${typeKey}/${record.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Delete failed')
      setBusy(false)
      return
    }
    toast.success('Draft deleted')
    router.push(closeHref)
    router.refresh()
  }

  const onChange = useMemo(
    () => (fieldId: string, value: unknown) =>
      setValues((v) => {
        const next = { ...v }
        if (value === undefined) delete next[fieldId]
        else next[fieldId] = value
        return next
      }),
    [],
  )

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{record.recordNumber}</span>
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{status}</Badge>
        </span>
      }
      description={
        !canEdit
          ? typeName
          : status === 'draft'
            ? 'Draft — changes save automatically. Activate when it’s ready.'
            : status === 'active'
              ? 'Active — still editable; changes save automatically.'
              : 'Inactive — read-only until reactivated.'
      }
      headerActions={
        <>
          {canEdit && status === 'draft' ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={destroy}>
                <Trash2 size={14} /> Delete draft
              </Button>
              <Button disabled={busy || saveState === 'saving'} onClick={() => transition('active')}>
                Activate
              </Button>
            </>
          ) : null}
          {canEdit && status === 'active' ? (
            <Button variant="outline" disabled={busy} onClick={() => transition('inactive')}>
              Deactivate
            </Button>
          ) : null}
          {canEdit && status === 'inactive' ? (
            <Button disabled={busy} onClick={() => transition('active')}>
              Reactivate
            </Button>
          ) : null}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {editable
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : 'Unsaved changes…'
              : null}
          </span>
        </div>
      }
    >
      <div className="p-1">
        <RecordFields
          fields={fields}
          values={values}
          onChange={onChange}
          disabled={!editable}
          errors={errors}
        />
      </div>
    </UrlDrawer>
  )
}

function mapErrors(list: unknown): Record<string, string> {
  if (!Array.isArray(list)) return {}
  const out: Record<string, string> = {}
  for (const e of list as ApiError[]) {
    if (e && typeof e.fieldId === 'string' && typeof e.message === 'string' && !out[e.fieldId]) {
      out[e.fieldId] = e.message
    }
  }
  return out
}
