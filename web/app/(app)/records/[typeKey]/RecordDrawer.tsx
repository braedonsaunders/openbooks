'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { fetchAction, type ActionError } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import type { FieldValueMap, FormSection } from '@openbooks/forms-core'
import { Badge, Button, Popover, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { runClientScripts } from '@/lib/client-scripts'
import { useAppAction } from '@/lib/use-app-action'
import { RecordFields, RecordPreviewOptions } from '../../../../components/record-fields'
import type { RecordStatus } from '../../../../lib/record-schema'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  draft: 'secondary',
  inactive: 'outline',
}

/** Field errors stay inline at the field: project the refusal's `issues` back to the filler's error map. */
function mapIssues(error: ActionError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    if (issue.path && typeof issue.message === 'string' && !out[issue.path]) {
      out[issue.path] = issue.message
    }
  }
  return out
}

/**
 * The custom-record flyout — source platform-style record model: ALWAYS opens
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
  preview = false,
  closeHref = `/records/${typeKey}`,
}: {
  typeKey: string
  typeName: string
  sections: FormSection[]
  record: { id: string; recordNumber: string; data: FieldValueMap; status: RecordStatus; updatedAt: string }
  canEdit: boolean
  preview?: boolean
  closeHref?: string
}) {
  const router = useRouter()
  const t = useTranslations('records.recordDrawer')
  const tc = useTranslations('common')
  const tp = useTranslations('admin.extensions.native')
  const [status, setStatus] = useState<RecordStatus>(record.status)
  // Opaque optimistic-concurrency token: the record's canonical revision when
  // this drawer opened. Every data save sends it; a 409 keeps the user's
  // edits dirty (never silently adopts the winner's token) so the next save
  // cannot overwrite unseen work. Same contract as the capture review drawer.
  const [revision, setRevision] = useState(record.updatedAt)
  const [values, setValues] = useState<FieldValueMap>(record.data ?? {})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // 'error' means a refusal is pinned above the form: the alert carries the
  // reason, so the footer stays quiet. Field-only failures stay 'dirty' —
  // their reasons already render inline at the field.
  type SaveState = 'saved' | 'saving' | 'dirty' | 'error'
  const [saveState, setSaveState] = useState<SaveState>('saved')
  // Saves, transitions and deletes run on the shared action path: a refusal
  // pins until the next action AND toasts, and busy always releases.
  const { busy, refusal, execute, clearRefusal, refuse } = useAppAction()
  const [actionsOpen, setActionsOpen] = useState(false)

  const canEditStatus = canEdit && status !== 'inactive'
  const [mode, setMode] = useState<'view' | 'edit'>(preview && record.id === 'new' ? 'edit' : 'view')
  const editable = mode === 'edit' && canEditStatus

  // -- explicit save (no autosave) -------------------------------------------
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) {
      setSaveState('dirty')
      // A fresh edit supersedes the pinned refusal, like the next action does.
      clearRefusal()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values])

  /** Adopt the revision from a committed write so follow-up saves stay conflict-free. */
  function adoptRevision(data: unknown) {
    const updatedAt = (data as { record?: { updated_at?: unknown } } | null)?.record?.updated_at
    if (typeof updatedAt === 'string') setRevision(updatedAt)
  }

  /**
   * A conflict keeps the user's edits AND the stale token (never silently
   * adopts the winner's): the next save still cannot overwrite unseen work.
   * So a conflict refusal changes nothing here — the pin and toast carry it.
   */
  function onRefused(error: ActionError, fieldState: SaveState) {
    const fieldErrors = mapIssues(error)
    setErrors(fieldErrors)
    setSaveState(Object.keys(fieldErrors).length > 0 ? 'dirty' : fieldState)
  }

  async function save() {
    if (preview) return
    setSaveState('saving')
    // Client scripts scoped to this record type run in a sandboxed evaluator;
    // an explicit { abort } blocks the save, { warnings } toast and proceed.
    const gate = await runClientScripts(`custrec:${typeKey}`, { recordNumber: record.recordNumber, status, data: values })
    if (!gate.ok) {
      refuse(gate.reason, t('autosaveFailed'))
      setSaveState('dirty')
      return
    }
    for (const w of gate.warnings) toast.warning(w)
    const ok = await execute(
      () =>
        fetchAction(`/api/records/${typeKey}/${record.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: values, expectedUpdatedAt: revision }),
        }),
      {
        fallbackMessage: t('autosaveFailed'),
        onOk: (data) => {
          setErrors({})
          setSaveState('saved')
          setMode('view')
          adoptRevision(data)
        },
        onRefused: (error) => onRefused(error, 'error'),
      },
    )
    if (ok) router.refresh()
  }

  function cancel() {
    setValues(record.data ?? {})
    setErrors({})
    clearRefusal()
    setSaveState('saved')
    setMode('view')
  }

  async function transition(next: 'active' | 'inactive') {
    if (preview) return
    const withValues = next === 'active' && editable
    const successMessage =
      next === 'active'
        ? status === 'draft'
          ? t('activatedToast', { number: record.recordNumber })
          : t('reactivatedToast', { number: record.recordNumber })
        : t('deactivatedToast', { number: record.recordNumber })
    await execute(
      () =>
        fetchAction(`/api/records/${typeKey}/${record.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // Send the latest values with an activation so a just-typed required
          // field counts even if its debounce hadn't fired yet. A data-bearing
          // activation carries the revision token like any other data save.
          body: JSON.stringify(withValues ? { data: values, status: next, expectedUpdatedAt: revision } : { status: next }),
        }),
      {
        fallbackMessage: t('actionFailed'),
        successMessage,
        onOk: (data) => {
          setErrors({})
          setStatus(next)
          // Every committed write advances the revision — including lifecycle-only
          // transitions — so adopt it to keep follow-up data saves conflict-free.
          adoptRevision(data)
          setSaveState('saved')
        },
        onRefused: (error) => onRefused(error, saveState),
      },
    )
    router.refresh()
  }

  async function destroy() {
    if (preview) return
    const confirmed = await confirmDialog({
      message: t('deleteConfirm', { number: record.recordNumber }),
      tone: 'danger',
    })
    if (!confirmed) return
    const ok = await execute(() => fetchAction(`/api/records/${typeKey}/${record.id}`, { method: 'DELETE' }), {
      fallbackMessage: tc('feedback.deleteFailed'),
      successMessage: t('draftDeleted'),
      onOk: () => {
        router.push(closeHref)
      },
    })
    if (ok) router.refresh()
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
        preview
          ? tp('sampleOnly')
          : !canEdit
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
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tc('actions.cancel')}
              </Button>
              <Button disabled={busy || preview} onClick={save}>
                {busy ? tc('actions.saving') : tc('actions.save')}
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              {canEditStatus ? (
                <Button variant="outline" onClick={() => setMode('edit')}>
                  {tc('actions.edit')}
                </Button>
              ) : null}
              {canEdit && !preview ? <Popover open={actionsOpen} onOpenChange={setActionsOpen} align="end" className="w-52 p-1.5" trigger={<Button variant="outline" onClick={() => setActionsOpen((open) => !open)}>{tc('labels.actions')}<ChevronDown className="ml-1 h-3.5 w-3.5" /></Button>}>
                <div className="space-y-0.5 [&_button]:w-full [&_button]:justify-start">
                  {status === 'draft' ? <><Button variant="ghost" disabled={busy || saveState === 'saving'} onClick={() => { setActionsOpen(false); void transition('active') }}>{t('activate')}</Button><Button variant="ghost" className="text-red-600" disabled={busy} onClick={() => { setActionsOpen(false); void destroy() }}><Trash2 size={14} /> {t('deleteDraft')}</Button></> : null}
                  {status === 'active' ? <Button variant="ghost" disabled={busy} onClick={() => { setActionsOpen(false); void transition('inactive') }}>{t('deactivate')}</Button> : null}
                  {status === 'inactive' ? <Button variant="ghost" disabled={busy} onClick={() => { setActionsOpen(false); void transition('active') }}>{t('reactivate')}</Button> : null}
                </div>
              </Popover> : null}
            </div>
          )}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {preview ? tp('sampleOnly') : mode === 'edit'
              ? saveState === 'saving'
                ? tc('actions.saving')
                : saveState === 'dirty'
                  ? t('unsaved')
                  : null
              : null}
          </span>
          {saveState === 'error' ? <span className="text-xs text-red-600 dark:text-red-400">{t('autosaveFailed')}</span> : null}
        </div>
      }
    >
      <div className="p-1">
        {/* A non-field refusal pins here until the next action or edit — the
            toast catches the eye, this survives it. No dismiss. */}
        <ActionAlert error={refusal} fallbackMessage={t('actionFailed')} />
        <RecordPreviewOptions.Provider value={preview ? [{ value: 'preview-reference', label: tp('sampleReference') }] : null}>
        <RecordFields
          sections={sections}
          values={values}
          onChange={onChange}
          disabled={!editable}
          errors={errors}
        />
        </RecordPreviewOptions.Provider>
      </div>
    </UrlDrawer>
  )
}
