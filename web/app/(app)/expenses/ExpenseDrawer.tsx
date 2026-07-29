'use client'

import { useMoney } from '@/components/money-provider'
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

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  tax_components?: TaxComponentConfig[]
}
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
  lines: Record<string, any>[]
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

export function ExpenseDrawer({
  report,
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
}: {
  report: ExpensePayload
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
}) {
  const { money } = useMoney()
  const t = useTranslations('expenses')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = report.doc
  const statusKey = STATUS_LABEL_KEYS[String(doc.status)]
  const isDraft = doc.status === 'draft'
  // source platform-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Draft, approved,
  // and POSTED reports are all editable (provided the viewer can enter
  // expenses) — saving a posted report re-materializes its GL-Impact projection
  // (the server blocks only GL changes into a closed period). pending_approval
  // and voided reports are read-only. Save is EXPLICIT — no per-field autosave.
  const canEditStatus = doc.status === 'draft' && canSubmit
  const [mode, setMode] = useState<'view' | 'edit'>('view')
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

  /** Reset every field back to the loaded document (used by Cancel). */
  function resetForm() {
    setPartyId(doc.party_id ?? '')
    setDocumentDate(doc.document_date ?? '')
    setMemo(doc.memo ?? '')
    setCustomValues(doc.custom ?? {})
    setExtraDims(doc.extra_dims ?? {})
    setRows(report.lines.length > 0 ? report.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine()])
    setTotals({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/expenses/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const data = (await res.json()) as ExpensePayload
      setTotals({ subtotal: data.doc.subtotal, taxTotal: data.doc.tax_total, total: data.doc.total })
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('toasts.actionFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
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
      closeHref="/expenses"
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
