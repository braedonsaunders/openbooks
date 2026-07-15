'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { AttachmentPanel } from '../../../components/attachment-panel'
import { money } from '../../../lib/format'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
}
interface LineRow extends Record<string, unknown> {
  accountId: string
  description: string
  departmentId: string
  projectId: string
  taxCodeId: string
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
  taxCodeId: '',
  amount: '',
  taxOverridden: false,
  taxAmount: '',
})

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[]): LineRow {
  const row: LineRow = {
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    taxCodeId: l.tax_code_id ?? '',
    amount: l.amount != null ? Number(l.amount).toFixed(2) : '',
    taxOverridden: l.tax_overridden === true,
    taxAmount: l.tax_amount != null ? Number(l.tax_amount).toFixed(2) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  return row
}

export function ExpenseDrawer({
  report,
  employees,
  accounts,
  taxCodes,
  departments,
  projects,
  headerDefs,
  lineDefs,
  canSubmit,
  canPost,
}: {
  report: ExpensePayload
  employees: Opt[]
  accounts: Opt[]
  taxCodes: Opt[]
  departments: Opt[]
  projects: Opt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
  canSubmit: boolean
  canPost: boolean
}) {
  const t = useTranslations('expenses')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const doc = report.doc
  const statusKey = STATUS_LABEL_KEYS[String(doc.status)]
  const isDraft = doc.status === 'draft'
  // NetSuite-style edit-in-place: draft, approved, and POSTED reports are all
  // editable (provided the viewer can enter expenses). Saving a posted report
  // re-materializes its GL-Impact projection (the server blocks only GL changes
  // into a closed period). pending_approval and voided reports are read-only.
  const editable =
    (doc.status === 'draft' || doc.status === 'approved' || doc.status === 'posted') && canSubmit

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    report.lines.length > 0 ? report.lines.map((l) => toRow(l, lineDefs)) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const rateByCode = useMemo(() => new Map(taxCodes.map((tc) => [tc.id, Number(tc.rate ?? 0)])), [taxCodes])
  const lineTax = (row: LineRow) => {
    const rate = row.taxCodeId ? (rateByCode.get(row.taxCodeId) ?? 0) : 0
    const amt = Number(row.amount)
    if (!rate || Number.isNaN(amt)) return 0
    return Math.round(amt * rate) / 100
  }

  // -- autosave (drafts only) ----------------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      memo,
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && Number(r.amount) > 0)
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: r.amount,
          taxCodeId: r.taxCodeId || null,
          taxOverridden: r.taxOverridden,
          taxAmount: r.taxOverridden ? r.taxAmount : null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }),
    [partyId, documentDate, memo, customValues, rows, lineDefs],
  )
  const first = useRef(true)
  useEffect(() => {
    if (!editable) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const timer = setTimeout(async () => {
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
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? t('toasts.autosaveFailed'))
      }
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, editable])

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/expenses/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('toasts.actionFailed'))
    else toast.success(action === 'submit' ? t('toasts.submitted') : t('toasts.posted'))
    setBusy(false)
    router.refresh()
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => [
      {
        key: 'accountId',
        label: tCommon('labels.account'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('drawer.accountPlaceholder'),
      },
      { key: 'description', label: tCommon('labels.description'), width: 'minmax(160px,1.6fr)', type: 'text' },
      {
        key: 'departmentId',
        label: tCommon('labels.department'),
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      {
        key: 'projectId',
        label: tCommon('labels.project'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
      {
        key: 'taxCodeId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('drawer.noTax') }, ...taxCodes.map((tc) => ({ value: tc.id, label: tc.code ?? '' }))],
      },
      ...customFieldColumns<LineRow>(lineDefs),
      { key: 'amount', label: tCommon('labels.amount'), width: '120px', type: 'amount', align: 'right', required: true },
      {
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, departments, projects, taxCodes, lineDefs, t, tCommon],
  )

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/expenses"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {statusKey ? tCommon(`status.${statusKey}`) : String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={editable ? t('drawer.autosaveHint') : (doc.employee_name ?? undefined)}
      headerActions={
        <>
          {isDraft && canSubmit ? (
            <Button disabled={busy || !partyId || Number(totals.total) <= 0} onClick={() => act('submit')}>
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
              <Link href={`/journal/${doc.entry_id}`}>{t('drawer.viewGlImpact')}</Link>
            </Button>
          ) : null}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {editable
              ? saveState === 'saved'
                ? t('drawer.saveState.saved')
                : saveState === 'saving'
                  ? tCommon('actions.saving')
                  : saveState === 'error'
                    ? t('drawer.saveState.error')
                    : t('drawer.saveState.dirty')
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

        <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!editable} />

        <div className="space-y-2">
          <Label>{tCommon('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={setRows}
            emptyRow={emptyLine}
            readOnly={!editable}
          />
        </div>

        <AttachmentPanel targetTable="documents" targetId={doc.id} canEdit />
      </div>
    </UrlDrawer>
  )
}
