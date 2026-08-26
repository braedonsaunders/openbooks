'use client'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { CustomFieldInput } from '../../../components/custom-field-input'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { JournalEntryLink } from '../../../components/journal-entry-link'
import { PdfButton } from '../../../components/pdf-button'
import { cmp } from '@openbooks/engine/src/money.ts'
import { computeLineTaxes, type TaxComponentConfig } from '@openbooks/engine/src/tax.ts'
import {
  DOCUMENT_CHANGED_AFTER_OPEN,
  buildDocumentSaveRequest,
  executeDocumentSave,
  loadDraftDocumentSnapshot,
  reconcileCanonicalDraftRead,
  type FencedSaveResult,
  type PersistedDocumentSnapshot,
} from '../../../components/document-drawer'
import { confirmDialog } from '../../../lib/confirm'
import { promptDialog } from '../../../lib/prompt'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import {
  customFieldDefKey,
  isCustomFieldKey,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
} from '@openbooks/customization'
type Opt = {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  tax_components?: TaxComponentConfig[]
};
interface SegmentOpt {
  key: string
  name: string
  showOnHeader: boolean
  showOnLines: boolean
  values: { id: string; code: string | null; name: string }[]
}
interface LineRow extends Record<string, unknown> {
  accountId: string
  description: string
  departmentId: string
  projectId: string
  taxProfileId: string
  amount: string
  taxOverridden: boolean
  taxAmount: string
}
interface ExpensePayload {
  doc: Record<string, any>
  lines: Record<string, unknown>[]
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

// Built-in expense_report statuses → common.status.* message keys. Unknown
// (custom) statuses render verbatim with underscores humanized.
const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  posted: 'posted',
  voided: 'voided',
}

const emptyLine = (): LineRow => ({
  accountId: '',
  description: '',
  departmentId: '',
  projectId: '',
  taxProfileId: '',
  amount: '',
  taxOverridden: false,
  taxAmount: '',
})

function positiveAmount(value: unknown): boolean {
  try { return cmp(String(value ?? ''), '0') > 0 } catch { return false }
}

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[], segments: SegmentOpt[]): LineRow {
  const row: LineRow = {
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    taxProfileId: l.tax_group_id ? `group:${l.tax_group_id}` : l.tax_code_id ? `code:${l.tax_code_id}` : '',
    amount: l.amount != null ? String(l.amount) : '',
    taxOverridden: l.tax_overridden === true,
    taxAmount: l.tax_amount != null ? String(l.tax_amount) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  for (const segment of segments) row[`seg_${segment.key}`] = (l.extra_dims ?? {})[segment.key] ?? ''
  return row
}

export type ExpenseReportSaveInput = {
  documentId: string
  revision: string
  payload: Record<string, unknown>
  fallbackMessage: string
  transport?: typeof fetch
}

/**
 * One revision-fenced expense-report save — the exact routine the drawer's
 * Save button executes. The editor's exact revision rides as expectedUpdatedAt
 * (the PATCH route refuses anything else), a success hands back the refreshed
 * token from the save response, and a stale token surfaces as an explicit
 * conflict for the caller's reload flow.
 */
export async function saveExpenseReport(input: ExpenseReportSaveInput): Promise<FencedSaveResult<ExpensePayload>> {
  const outcome = await executeDocumentSave(
    buildDocumentSaveRequest(input.documentId, input.revision, input.payload, false, undefined, {
      basePath: '/api/expenses',
    }),
    input.fallbackMessage,
    input.transport ?? fetch,
  )
  if (!outcome.ok) {
    return outcome.isConflict
      ? { status: 'conflict', message: outcome.message }
      : { status: 'error', message: outcome.message }
  }
  return { status: 'saved', saved: outcome.data as ExpensePayload, revision: outcome.revision }
}

export function ExpenseDrawer({
  report,
  initialMode = 'view',
  employees,
  accounts,
  taxCodes,
  taxGroups,
  departments,
  projects,
  segments = [],
  headerDefs,
  lineDefs,
  canSubmit,
  canPost,
  layout,
  closeHref = '/expenses/reports',
}: {
  report: ExpensePayload
  initialMode?: DrawerMode
  employees: Opt[]
  accounts: Opt[]
  taxCodes: Opt[]
  taxGroups: Opt[]
  departments: Opt[]
  projects: Opt[]
  segments?: SegmentOpt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
  canSubmit: boolean
  canPost: boolean
  layout?: FormLayoutConfig
  closeHref?: string
}) {
  const { money } = useMoney()
  const t = useTranslations('expenses')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = report.doc
  const statusKey = STATUS_LABEL_KEYS[String(doc.status)]
  const isDraft = doc.status === 'draft'
  // Existing records default to read-only; newly created drafts can explicitly
  // request edit mode. Draft, approved,
  // and POSTED reports are all editable (provided the viewer can enter
  // expenses) — saving a posted report re-materializes its GL-Impact projection
  // (the server blocks only GL changes into a closed period). pending_approval
  // and voided reports are read-only. Save is EXPLICIT — no per-field autosave.
  const canEditStatus = doc.status === 'draft' && canSubmit
  const [mode, setMode] = useState<DrawerMode>(
    initialDrawerMode(initialMode, canEditStatus),
  )
  const editable = mode === 'edit' && canEditStatus

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [extraDims, setExtraDims] = useState<Record<string, string>>(doc.extra_dims ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    report.lines.length > 0 ? report.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const taxProfiles = useMemo(() => [
    ...taxCodes.map((profile) => ({ ...profile, value: `code:${profile.id}` })),
    ...taxGroups.map((profile) => ({ ...profile, value: `group:${profile.id}` })),
  ], [taxCodes, taxGroups])
  const taxByProfile = useMemo(() => new Map(taxProfiles.map((profile) => [profile.value, profile.tax_components ?? []])), [taxProfiles])
  const lineTax = (row: LineRow) => {
    try { return computeLineTaxes(String(row.amount || '0'), taxByProfile.get(row.taxProfileId) ?? []).taxTotal }
    catch { return '0.0000' }
  }

  // -- explicit save (no autosave) -----------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      memo,
      extraDims,
      custom: customValues,
      lines: rows
        .filter((r) => {
          try { return r.accountId && cmp(r.amount, '0') > 0 } catch { return false }
        })
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: r.amount,
          taxCodeId: r.taxProfileId.startsWith('code:') ? r.taxProfileId.slice(5) : null,
          taxGroupId: r.taxProfileId.startsWith('group:') ? r.taxProfileId.slice(6) : null,
          taxOverridden: r.taxOverridden,
          taxAmount: r.taxOverridden ? r.taxAmount : null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          extraDims: Object.fromEntries(segments.map((segment) => [segment.key, r[`seg_${segment.key}`]]).filter(([, value]) => value !== '' && value != null)),
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }),
    [partyId, documentDate, memo, customValues, extraDims, rows, lineDefs, segments],
  )
  // Track unsaved edits (no autosave — Save is an explicit button).
  const [dirty, setDirty] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload])

  // -- optimistic-concurrency fence -----------------------------------------
  // The expense PATCH route refuses any write without an exact revision token.
  // RSC props carry updated_at as a lossy Date that can never satisfy that
  // contract, so the canonical read below mints this editor's first usable
  // token; every later token comes from a save response. Until one exists,
  // saving fails closed instead of 409-ing.
  const [, setDocumentRevisionState] = useState<string | null>(null)
  const documentRevisionRef = useRef<string | null>(null)
  const seenPersistedRevisions = useRef(new Set<string>())
  const draftBaseline = useRef<PersistedDocumentSnapshot<ExpensePayload>>({
    documentId: String(doc.id),
    revision: '',
    payload: report,
  })
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  function setDocumentRevision(revision: string | null) {
    documentRevisionRef.current = revision
    setDocumentRevisionState(revision)
  }

  /** Reset every field back to an explicit persisted payload (used by Cancel). */
  function resetForm(source: ExpensePayload) {
    const sourceDoc = source.doc
    setPartyId(sourceDoc.party_id ?? '')
    setDocumentDate(sourceDoc.document_date ?? '')
    setMemo(sourceDoc.memo ?? '')
    setCustomValues(sourceDoc.custom ?? {})
    setExtraDims(sourceDoc.extra_dims ?? {})
    setRows(source.lines.length > 0 ? source.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()])
    setTotals({ subtotal: sourceDoc.subtotal, taxTotal: sourceDoc.tax_total, total: sourceDoc.total })
  }

  /** Adopt a reloaded snapshot as the editor's baseline (drops edits). */
  function adoptReload(incoming: PersistedDocumentSnapshot<ExpensePayload>) {
    draftBaseline.current = incoming
    seenPersistedRevisions.current.add(incoming.revision)
    resetForm(incoming.payload)
    setDocumentRevision(incoming.revision)
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  /** Apply one canonical read: adopt when clean, pin the newer exact token
   *  under dirty-but-unchanged content, reload-and-review when content moved. */
  function applyCanonicalRead(
    incoming: PersistedDocumentSnapshot<ExpensePayload>,
    notifyOnConflict = true,
  ) {
    const decision = reconcileCanonicalDraftRead({
      current: draftBaseline.current,
      incoming,
      isDirty: dirtyRef.current,
    })
    if (decision.action === 'adopt') {
      draftBaseline.current = decision.snapshot
      seenPersistedRevisions.current.add(decision.snapshot.revision)
      resetForm(decision.snapshot.payload)
      setDocumentRevision(decision.snapshot.revision)
    } else if (decision.action === 'pin') {
      seenPersistedRevisions.current.add(decision.revision)
      draftBaseline.current = { ...draftBaseline.current, revision: decision.revision }
      setDocumentRevision(decision.revision)
    } else {
      // Dropping stale edits beats blessing them with the newer token — that
      // would recreate the silent last-write-wins this fence exists to stop.
      adoptReload(decision.snapshot)
      if (notifyOnConflict) toast.error(DOCUMENT_CHANGED_AFTER_OPEN)
    }
  }

  async function refreshFromServer(notifyOnConflict = true): Promise<void> {
    applyCanonicalRead(
      await loadDraftDocumentSnapshot(`/api/expenses/${doc.id}`, t('toasts.actionFailed')),
      notifyOnConflict,
    )
  }

  useEffect(() => {
    let active = true
    loadDraftDocumentSnapshot(`/api/expenses/${doc.id}`, t('toasts.actionFailed'))
      .then((incoming) => {
        if (active) applyCanonicalRead(incoming)
      })
      .catch(() => {
        // Saves stay fenced off until a canonical read lands; the next save
        // attempt retries it.
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  async function save() {
    setBusy(true)
    setSaveState('saving')
    if (documentRevisionRef.current == null) await refreshFromServer(false).catch(() => {})
    const revision = documentRevisionRef.current
    if (revision == null) {
      setSaveState('error')
      toast.error(t('toasts.actionFailed'))
      setBusy(false)
      return
    }
    const outcome = await saveExpenseReport({
      documentId: String(doc.id),
      revision,
      payload,
      fallbackMessage: t('toasts.actionFailed'),
    })
    if (outcome.status === 'saved') {
      const savedReport = outcome.saved
      draftBaseline.current = {
        documentId: String(savedReport.doc.id),
        revision: outcome.revision,
        payload: savedReport,
      }
      seenPersistedRevisions.current.add(outcome.revision)
      resetForm(savedReport)
      setDocumentRevision(outcome.revision)
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error(outcome.message)
      if (outcome.status === 'conflict') await refreshFromServer(false).catch(() => {})
    }
    setBusy(false)
  }

  function cancel() {
    resetForm(draftBaseline.current.payload)
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/expenses/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('toasts.actionFailed'))
    else if (data.pendingApproval || (action === 'submit' && !data.autoApproved)) toast.success(t('toasts.submitted'))
    else toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('drawer.deleteTitle'),
        message: t('drawer.deleteDraftBody'),
        confirmLabel: tCommon('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/expenses/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(t('toasts.deleted'))
      router.push('/expenses/reports')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('toasts.deleteFailed'))
      setBusy(false)
    }
  }

  async function voidExpense() {
    const reason = await promptDialog({
      title: tCommon('amendment.voidTitle'),
      label: tCommon('amendment.reason'),
      placeholder: tCommon('amendment.voidPlaceholder'),
      confirmLabel: tCommon('actions.void'),
    })
    if (!reason) return
    setBusy(true)
    const res = await fetch(`/api/documents/${doc.id}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(data.error ?? t('toasts.actionFailed'))
    else if (data.status === 'pending_approval') toast.success(t('toasts.submitted'))
    else toast.success(tCommon('status.voided'))
    setBusy(false)
    router.refresh()
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => {
      const builtIn: Record<string, LineGridColumn<LineRow>> = {
      account_id:
      {
        key: 'accountId',
        label: tCommon('labels.account'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.accountPlaceholder'),
      },
      description: { key: 'description', label: tCommon('labels.description'), width: 'minmax(160px,1.6fr)', type: 'text' },
      department_id: {
        key: 'departmentId',
        label: tCommon('labels.department'),
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      project_id: {
        key: 'projectId',
        label: tCommon('labels.project'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
      tax_code_id: {
        key: 'taxProfileId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? '' }))],
      },
      amount: { key: 'amount', label: tCommon('labels.amount'), width: '120px', type: 'amount', align: 'right', required: true },
      tax_amount: {
        key: 'taxAmount',
        label: t('drawer.columns.taxAmount'),
        width: '120px',
        type: 'tax',
        align: 'right',
        computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) =>
            prev.map((r, j) =>
              j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r,
            ),
          ),
      },
      }
      const custom = new Map(customFieldColumns<LineRow>(lineDefs).map((column) => [column.key, column]))
      const segmentColumns: LineGridColumn<LineRow>[] = segments.filter((segment) => segment.showOnLines).map((segment) => ({
        key: `seg_${segment.key}`, label: segment.name, width: '150px', type: 'search-select',
        options: segment.values.map((value) => ({ value: value.id, label: `${value.code ? `${value.code} · ` : ''}${value.name}` })), placeholder: '—',
      }))
      if (!layout) return [...Object.values(builtIn), ...segmentColumns, ...custom.values()]
      const configured = layout.lines.columns.flatMap((placement) => {
        if (!placement.visible) return []
        const base = isCustomFieldKey(placement.key) ? custom.get(placement.key) : builtIn[placement.key]
        if (!base) return []
        return [{
          ...base,
          width: placement.width ?? base.width,
          label: placement.labelOverride?.trim() || base.label,
        }]
      })
      return [...configured, ...segmentColumns]
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, departments, projects, taxProfiles, lineDefs, segments, layout, t, tCommon],
  )

  const field = 'space-y-1.5'
  const headerDefByKey = new Map(headerDefs.map((def) => [def.key, def]))
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const override = placement.labelOverride?.trim()
    if (isCustomFieldKey(placement.key)) {
      const def = headerDefByKey.get(customFieldDefKey(placement.key))
      return def ? (
        <CustomFieldInput
          def={{ ...def, label: override || def.label, isRequired: placement.required ?? def.isRequired }}
          value={customValues[def.key]}
          onChange={(value) => setCustomValues((current) => ({ ...current, [def.key]: value }))}
          readOnly={!isEditable}
        />
      ) : null
    }
    switch (placement.key) {
      case 'party_id':
        return <><Label>{override || tCommon('labels.employee')}{isEditable ? <span className="text-red-500"> *</span> : null}</Label>{isEditable ? <SearchSelect options={employees.map((employee) => ({ value: employee.id, label: employee.display_name ?? '' }))} value={partyId} onChange={(value) => setPartyId(value ?? '')} placeholder={t('drawer.selectEmployeePlaceholder')} /> : <p className="text-sm">{doc.employee_name}</p>}</>
      case 'document_date':
        return <><Label>{override || t('drawer.reportDate')}</Label>{isEditable ? <Input type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} /> : <p className="text-sm">{doc.document_date}</p>}</>
      case 'memo':
        return <><Label>{override || tCommon('labels.memo')}</Label>{isEditable ? <Input value={memo} onChange={(event) => setMemo(event.target.value)} /> : <p className="text-sm">{doc.memo ?? '—'}</p>}</>
      default:
        return null
    }
  }

  return (
    <TransactionDrawer
      closeHref={closeHref}
      recordId={String(doc.id)}
      canEditAttachments={canSubmit}
      panelClassName={docTypeMeta('expense_report').surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="expense_report" />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {statusKey ? tCommon(`status.${statusKey}`) : String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : (doc.employee_name ?? undefined)}
      primaryAction={
        canEditStatus ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => mode === 'edit' ? cancel() : setMode('edit')}>
            {mode === 'edit' ? tCommon('actions.cancel') : tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
            </>
          ) : (
            <>
              <PdfButton recordType="expense_report" recordId={String(doc.id)} />
              <FlowManualButtons subjectKind="expense_report" subjectId={String(doc.id)} />
              <ApprovalActions subjectKind="expense_report" subjectId={String(doc.id)} />
              {isDraft && canSubmit ? (
                <Button disabled={busy || !partyId || !positiveAmount(totals.total)} onClick={() => act('submit')}>
                  {t('actions.submitForApproval')}
                </Button>
              ) : null}
              {doc.status === 'approved' && canPost ? (
                <Button disabled={busy} onClick={() => act('post')}>
                  {tCommon('actions.post')}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <JournalEntryLink entryId={doc.entry_id}>{t('drawer.viewGlImpact')}</JournalEntryLink>
                </Button>
              ) : null}
              {(doc.status === 'approved' || doc.status === 'posted') && canPost ? (
                <Button variant="ghost" disabled={busy} onClick={voidExpense} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tCommon('actions.void')}
                </Button>
              ) : null}
              {doc.status === 'draft' && canSubmit ? (
                <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tCommon('actions.delete')}
                </Button>
              ) : null}
            </>
          )}
        </>
      }
      detailTabs={[
        {
          key: 'approvals',
          label: tCommon('approvalFlow.historyTitle'),
          content: <ApprovalHistory subjectKind="expense_report" subjectId={String(doc.id)} />,
        },
      ]}
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {mode === 'edit'
              ? saveState === 'saving'
                ? tCommon('actions.saving')
                : saveState === 'error'
                  ? t('drawer.saveState.error')
                  : dirty
                    ? t('drawer.saveState.dirty')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t.rich('drawer.totals', {
              subtotal: money(totals.subtotal),
              tax: money(totals.taxTotal),
              total: money(totals.total),
              strong: (chunks) => (
                <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>
              ),
            })}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {layout ? <HeaderFields layout={layout} editable={editable} renderField={renderHeaderField} /> : <><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.employee')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
            {editable ? (
              <SearchSelect
                options={employees.map((e) => ({ value: e.id, label: e.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('drawer.selectEmployeePlaceholder')}
              />
            ) : (
              <p className="text-sm">{doc.employee_name}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('drawer.reportDate')}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-4`}>
            <Label>{tCommon('labels.memo')}</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!editable} /></>}

        {segments.some((segment) => segment.showOnHeader) ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {segments.filter((segment) => segment.showOnHeader).map((segment) => {
              const selected = extraDims[segment.key] ?? ''
              return <div className={field} key={segment.key}>
                <Label>{segment.name}</Label>
                {editable ? <SearchSelect
                  options={segment.values.map((value) => ({ value: value.id, label: `${value.code ? `${value.code} · ` : ''}${value.name}` }))}
                  value={selected}
                  onChange={(value) => setExtraDims((current) => ({ ...current, [segment.key]: value ?? '' }))}
                  placeholder="—"
                /> : <p className="text-sm">{segment.values.find((value) => value.id === selected)?.name ?? '—'}</p>}
              </div>
            })}
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>{tCommon('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={setRows}
            emptyRow={emptyLine}
            readOnly={!editable}
            formatAmount={(value) => money(value, { currency: doc.currency })}
          />
        </div>

      </div>
    </TransactionDrawer>
  )
}
