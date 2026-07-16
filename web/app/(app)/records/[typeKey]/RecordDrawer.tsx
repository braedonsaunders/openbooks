'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { FieldValueMap, FormSection } from '@openbooks/forms-core'
import { Badge, Button, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { runClientScripts } from '@/lib/client-scripts'
import { RecordFields } from '../../../../components/record-fields'
import type { RecordStatus } from '../../../../lib/record-schema'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  draft: 'secondary',
  inactive: 'outline',
}

type ApiError = { fieldId: string; message: string }

/**
 * The custom-record flyout — NetSuite-style record model: ALWAYS opens
 * READ-ONLY (view mode) — even for drafts — with an Edit button in the header;
 * editing is an explicit Edit → Save/Cancel cycle. Records are master data:
 * they stay editable while DRAFT or ACTIVE; only inactive records are
 * read-only until reactivated.
 */
export function RecordDrawer({
  typeKey,
  typeName,
  sections,
  record,
  canEdit,
}: {
  typeKey: string
  typeName: string
  sections: FormSection[]
  record: { id: string; recordNumber: string; data: FieldValueMap; status: RecordStatus }
  canEdit: boolean
}) {
  const router = useRouter()
  const t = useTranslations('records.recordDrawer')
  const tc = useTranslations('common')
  const [status, setStatus] = useState<RecordStatus>(record.status)
  const [values, setValues] = useState<FieldValueMap>(record.data ?? {})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [busy, setBusy] = useState(false)

  const canEditStatus = canEdit && status !== 'inactive'
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canEditStatus
  const closeHref = `/records/${typeKey}`

  // -- explicit save (no autosave) -------------------------------------------
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setSaveState('dirty')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values])

  async function save() {
    setBusy(true)
    setSaveState('saving')
    // Client scripts scoped to this record type run in a sandboxed evaluator;
    // an explicit { abort } blocks the save, { warnings } toast and proceed.
    const gate = await runClientScripts(`custrec:${typeKey}`, { recordNumber: record.recordNumber, status, data: values })
    if (!gate.ok) {
      toast.error(gate.reason ?? t('autosaveFailed'))
      setSaveState('dirty')
      setBusy(false)
      return
    }
    for (const w of gate.warnings) toast.warning(w)
    const res = await fetch(`/api/records/${typeKey}/${record.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: values }),
    })
    const data = await res.json()
    if (res.ok) {
      setErrors({})
      setSaveState('saved')
      setMode('view')
      router.refresh()
    } else {
      setSaveState('dirty')
      setErrors(mapErrors(data.errors))
      toast.error(data.error ?? t('autosaveFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    setValues(record.data ?? {})
    setErrors({})
    setSaveState('saved')
    setMode('view')
  }

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
      toast.error(data.error ?? t('actionFailed'))
    } else {
      setErrors({})
      setStatus(next)
      setSaveState('saved')
      toast.success(
        next === 'active'
          ? status === 'draft'
            ? t('activatedToast', { number: record.recordNumber })
            : t('reactivatedToast', { number: record.recordNumber })
          : t('deactivatedToast', { number: record.recordNumber }),
      )
    }
    setBusy(false)
    router.refresh()
  }

  async function destroy() {
    const ok = await confirmDialog({
      message: t('deleteConfirm', { number: record.recordNumber }),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/records/${typeKey}/${record.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? tc('feedback.deleteFailed'))
      setBusy(false)
      return
    }
    toast.success(t('draftDeleted'))
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
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{tc(`status.${status}`)}</Badge>
        </span>
      }
      description={
        !canEdit
          ? typeName
          : status === 'draft'
            ? t('descriptionDraft')
            : status === 'active'
              ? t('descriptionActive')
              : t('descriptionInactive')
      }
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tc('actions.saving') : tc('actions.save')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tc('actions.cancel')}
              </Button>
            </>
          ) : (
            <>
              {canEditStatus ? (
                <Button variant="outline" onClick={() => setMode('edit')}>
                  {tc('actions.edit')}
                </Button>
              ) : null}
              {canEdit && status === 'draft' ? (
                <>
                  <Button variant="ghost" disabled={busy} onClick={destroy}>
                    <Trash2 size={14} /> {t('deleteDraft')}
                  </Button>
                  <Button disabled={busy || saveState === 'saving'} onClick={() => transition('active')}>
                    {t('activate')}
                  </Button>
                </>
              ) : null}
              {canEdit && status === 'active' ? (
                <Button variant="outline" disabled={busy} onClick={() => transition('inactive')}>
                  {t('deactivate')}
                </Button>
              ) : null}
              {canEdit && status === 'inactive' ? (
                <Button disabled={busy} onClick={() => transition('active')}>
                  {t('reactivate')}
                </Button>
              ) : null}
            </>
          )}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {mode === 'edit'
              ? saveState === 'saving'
                ? tc('actions.saving')
                : saveState === 'dirty'
                  ? t('unsaved')
                  : null
              : null}
          </span>
        </div>
      }
    >
      <div className="p-1">
        <RecordFields
          sections={sections}
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
