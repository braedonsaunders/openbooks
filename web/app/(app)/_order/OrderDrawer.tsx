'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { DocTypeBadge } from '../../../components/doc-type-badge'
import { confirmDialog } from '../../../lib/confirm'
import { money } from '../../../lib/format'
import { CONVERSION_TARGETS, type OrderKind } from '../../../lib/order-kinds'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  default_rate?: string | null
  income_account_id?: string | null
  expense_account_id?: string | null
  tax_code_id?: string | null
  unit?: string | null
}
interface LineRow extends Record<string, unknown> {
  itemId: string
  accountId: string
  description: string
  quantity: string
  unit: string
  unitPrice: string
  taxCodeId: string
  departmentId: string
  projectId: string
}
interface LinkRow {
  direction: 'from' | 'to'
  link_type: string
  id: string
  kind: string
  document_number: string
  status: string
}
export interface OrderPayload {
  doc: Record<string, any>
  lines: Record<string, any>[]
  links: LinkRow[]
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'secondary' | 'warning' | 'outline'> = {
  approved: 'success',
  draft: 'secondary',
  voided: 'outline',
}

/** Per-kind base list route/param for the flyout close href (wording lives in the catalog, keyed by kind). */
const KIND_META: Record<OrderKind, { base: string; param: string }> = {
  quote: { base: '/estimates', param: 'estimate' },
  sales_order: { base: '/sales-orders', param: 'order' },
  purchase_order: { base: '/purchase-orders', param: 'order' },
}

/** documents.status values with a generic label in common.status (camelCased key). */
const STATUS_LABEL_KEYS = new Set([
  'draft',
  'pendingApproval',
  'approved',
  'rejected',
  'posted',
  'paid',
  'partiallyPaid',
  'open',
  'closed',
  'voided',
  'reversed',
  'cancelled',
])
const toStatusKey = (status: string) => status.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** Where a freshly-created document opens (drawer deep-link per kind). */
function targetHref(kind: string, id: string): string {
  switch (kind) {
    case 'customer_invoice':
      return `/ar?invoice=${id}`
    case 'vendor_bill':
      return `/ap?bill=${id}`
    case 'sales_order':
      return `/sales-orders?order=${id}`
    case 'purchase_order':
      return `/purchase-orders?order=${id}`
    case 'quote':
      return `/estimates?estimate=${id}`
    default:
      return '/'
  }
}

/** Where an existing linked document opens (used by the links section). */
function docHref(kind: string, id: string): string {
  return targetHref(kind, id)
}

const emptyLine = (): LineRow => ({
  itemId: '',
  accountId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  taxCodeId: '',
  departmentId: '',
  projectId: '',
})

function toRow(l: Record<string, any>): LineRow {
  return {
    itemId: l.item_id ?? '',
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    quantity: l.quantity != null ? String(Number(l.quantity)) : '',
    unit: l.unit ?? '',
    unitPrice: l.unit_price != null ? Number(l.unit_price).toFixed(2) : '',
    taxCodeId: l.tax_code_id ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
  }
}

export function OrderDrawer({
  order,
  kind,
  parties,
  accounts,
  items,
  taxCodes,
  departments,
  projects,
  canManage,
}: {
  order: OrderPayload
  kind: OrderKind
  parties: Opt[]
  accounts: Opt[]
  items: Opt[]
  taxCodes: Opt[]
  departments: Opt[]
  projects: Opt[]
  canManage: boolean
}) {
  const t = useTranslations('purchaseOrders.shared')
  const tCommon = useTranslations('common')
  const statusLabel = (status: string) => {
    const key = toStatusKey(String(status))
    return STATUS_LABEL_KEYS.has(key) ? tCommon(`status.${key}`) : String(status).replace('_', ' ')
  }
  const router = useRouter()
  const doc = order.doc
  const meta = KIND_META[kind]
  const isDraft = doc.status === 'draft'
  const isApproved = doc.status === 'approved'
  // NetSuite-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Only DRAFT orders
  // are editable (Issue is terminal for the header). Save is EXPLICIT — one Save
  // button, no per-field autosave.
  const canEditStatus = isDraft && canManage
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canEditStatus

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [departmentId, setDepartmentId] = useState<string>(doc.department_id ?? '')
  const [projectId, setProjectId] = useState<string>(doc.project_id ?? '')
  const [rows, setRows] = useState<LineRow[]>(
    order.lines.length > 0 ? order.lines.map(toRow) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const apiBase = `/api/${
    kind === 'quote' ? 'estimates' : kind === 'sales_order' ? 'sales-orders' : 'purchase-orders'
  }`

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const rateByCode = useMemo(() => new Map(taxCodes.map((t) => [t.id, Number(t.rate ?? 0)])), [taxCodes])

  const lineAmount = (row: LineRow) => {
    const amt = Number(row.quantity) * Number(row.unitPrice)
    return Number.isFinite(amt) ? amt : 0
  }
  const lineTax = (row: LineRow) => {
    const rate = row.taxCodeId ? (rateByCode.get(row.taxCodeId) ?? 0) : 0
    const amt = lineAmount(row)
    if (!rate) return 0
    return Math.round(amt * rate) / 100
  }

  /** Converted progress across all lines (quantity_billed / quantity). */
  const converted = useMemo(() => {
    let ordered = 0
    let billed = 0
    for (const l of order.lines) {
      ordered += Number(l.quantity ?? 0)
      billed += Number(l.quantity_billed ?? 0)
    }
    return { ordered, billed, partial: billed > 0.00005 && billed + 0.00005 < ordered, full: ordered > 0 && billed + 0.00005 >= ordered }
  }, [order.lines])

  // -- selecting an item defaults description/price/account/tax/unit ----------
  const onRowsChange = (next: LineRow[]) => {
    const prev = rows
    const merged = next.map((row, i) => {
      if (row.itemId && row.itemId !== prev[i]?.itemId) {
        const it = itemById.get(row.itemId)
        if (it) {
          return {
            ...row,
            description: row.description || (it.name ?? ''),
            unitPrice: it.default_rate != null ? Number(it.default_rate).toFixed(2) : row.unitPrice,
            accountId:
              (kind === 'purchase_order' ? it.expense_account_id : it.income_account_id) ?? row.accountId,
            taxCodeId: it.tax_code_id ?? row.taxCodeId,
            unit: it.unit ?? row.unit,
            quantity: row.quantity || '1',
          }
        }
      }
      return row
    })
    setRows(merged)
  }

  // -- explicit save (no autosave) -------------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      dueDate: dueDate || null,
      memo,
      departmentId: departmentId || null,
      projectId: projectId || null,
      lines: rows
        .filter((r) => (r.itemId || r.accountId) && Number(r.quantity) > 0 && Number(r.unitPrice) >= 0 && lineAmount(r) > 0)
        .map((r) => ({
          itemId: r.itemId || null,
          accountId: r.accountId || null,
          description: r.description,
          quantity: r.quantity,
          unit: r.unit || null,
          unitPrice: r.unitPrice,
          taxCodeId: r.taxCodeId || null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
        })),
    }),
    [partyId, documentDate, dueDate, memo, departmentId, projectId, rows],
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
    setDueDate(doc.due_date ?? '')
    setMemo(doc.memo ?? '')
    setDepartmentId(doc.department_id ?? '')
    setProjectId(doc.project_id ?? '')
    setRows(order.lines.length > 0 ? order.lines.map(toRow) : [emptyLine()])
    setTotals({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`${apiBase}/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const data = (await res.json()) as OrderPayload
      setTotals({ subtotal: data.doc.subtotal, taxTotal: data.doc.tax_total, total: data.doc.total })
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('actionFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function setStatus(status: 'approved' | 'voided') {
    setBusy(true)
    const res = await fetch(`${apiBase}/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error ?? t('actionFailed'))
      return
    }
    toast.success(status === 'approved' ? t('toastIssued') : t('toastVoided'))
    router.refresh()
  }

  async function issue() {
    // Persist any pending edits first so the server sees the latest lines.
    await fetch(`${apiBase}/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    await setStatus('approved')
  }

  async function voidOrder() {
    if (
      !(await confirmDialog({
        title: t('voidConfirmTitle'),
        message: t('voidConfirmMessage'),
        confirmLabel: tCommon('actions.void'),
        tone: 'danger',
      }))
    )
      return
    await setStatus('voided')
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: 'Delete this order?',
        message: 'This permanently deletes the order and its lines. This cannot be undone.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`${apiBase}/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Order deleted')
      router.push(meta.base)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('actionFailed'))
      setBusy(false)
    }
  }

  async function convert(targetKind: string, label: string) {
    setBusy(true)
    const res = await fetch(`${apiBase}/${doc.id}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error ?? t('convertFailed'))
      return
    }
    toast.success(t('convertCreated', { target: label, number: data.documentNumber }))
    router.push(targetHref(data.kind, data.id))
    router.refresh()
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => [
      {
        key: 'itemId',
        label: t('columns.item'),
        width: 'minmax(170px,1.6fr)',
        type: 'search-select',
        options: items.map((i) => ({ value: i.id, label: `${i.code ? i.code + ' · ' : ''}${i.name ?? ''}`.trim() })),
        placeholder: '—',
      },
      {
        key: 'accountId',
        label: t('columns.account', { kind }),
        width: 'minmax(180px,1.8fr)',
        type: 'search-select',
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('columns.accountPlaceholder'),
      },
      { key: 'description', label: tCommon('labels.description'), width: 'minmax(150px,1.6fr)', type: 'text' },
      { key: 'quantity', label: t('columns.qty'), width: '90px', type: 'amount', align: 'right', required: true },
      { key: 'unitPrice', label: t('columns.unitPrice'), width: '110px', type: 'amount', align: 'right', required: true },
      {
        key: 'taxCodeId',
        label: tCommon('labels.tax'),
        width: '110px',
        type: 'select',
        options: [{ value: '', label: t('columns.noTax') }, ...taxCodes.map((t) => ({ value: t.id, label: t.code ?? '' }))],
      },
      {
        key: '_amount',
        label: tCommon('labels.amount'),
        width: '120px',
        type: 'readonly',
        align: 'right',
        render: (row) => {
          const a = lineAmount(row)
          return a ? money(a) : ''
        },
      },
      {
        key: '_tax',
        label: t('columns.taxAmount'),
        width: '100px',
        type: 'readonly',
        align: 'right',
        render: (row) => {
          const t = lineTax(row)
          return t ? money(t) : ''
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, items, taxCodes, kind, t, tCommon],
  )

  const field = 'space-y-1.5'
  const canIssue = !!partyId && rows.some((r) => (r.itemId || r.accountId) && lineAmount(r) > 0)
  const convertTargets = CONVERSION_TARGETS[kind]

  return (
    <UrlDrawer
      open
      closeHref={meta.base}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind={kind} />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {statusLabel(doc.status)}
          </Badge>
          {converted.partial ? (
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {t('convertedProgress', {
                billed: converted.billed % 1 === 0 ? String(converted.billed) : converted.billed.toFixed(2),
                ordered: converted.ordered % 1 === 0 ? String(converted.ordered) : converted.ordered.toFixed(2),
              })}
            </span>
          ) : converted.full ? (
            <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">{t('fullyConverted')}</span>
          ) : null}
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : (doc.party_name ?? undefined)}
      headerActions={
        mode === 'edit' ? (
          <>
            <Button disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="outline" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : canManage ? (
          <>
            {canEditStatus ? (
              <Button variant="outline" onClick={() => setMode('edit')}>
                Edit
              </Button>
            ) : null}
            {isDraft ? (
              <Button disabled={busy || !canIssue} onClick={issue}>
                {t('issue')}
              </Button>
            ) : null}
            {isApproved
              ? convertTargets.map((target) => (
                  <Button
                    key={target.kind}
                    disabled={busy}
                    onClick={() => convert(target.kind, t(target.labelKey))}
                  >
                    {t('convertTo', { target: t(target.labelKey) })}
                  </Button>
                ))
              : null}
            {isApproved ? (
              <Button variant="outline" disabled={busy} onClick={voidOrder}>
                {tCommon('actions.void')}
              </Button>
            ) : null}
            {doc.status !== 'voided' ? (
              <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                Delete
              </Button>
            ) : null}
          </>
        ) : null
      }
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
                  ? t('saveFailedRetry')
                  : dirty
                    ? t('unsavedChanges')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t('totals.subtotal', { amount: money(totals.subtotal) })} ·{' '}
            {t('totals.tax', { amount: money(totals.taxTotal) })} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">
              {t('totals.total', { amount: money(totals.total) })}
            </strong>
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {t('partyLabel', { kind })}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={parties.map((c) => ({ value: c.id, label: c.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('selectPartyPlaceholder', { kind })}
              />
            ) : (
              <p className="text-sm">{doc.party_name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('dateLabel', { kind })}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('expiryLabel', { kind })}</Label>
            {editable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.due_date ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.department')}</Label>
            {editable ? (
              <SearchSelect
                options={[{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))]}
                value={departmentId}
                onChange={(v) => setDepartmentId(v ?? '')}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{departments.find((d) => d.id === doc.department_id)?.name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{tCommon('labels.project')}</Label>
            {editable ? (
              <SearchSelect
                options={[{ value: '', label: '—' }, ...projects.map((p) => ({ value: p.id, label: p.name ?? '' }))]}
                value={projectId}
                onChange={(v) => setProjectId(v ?? '')}
                placeholder="—"
              />
            ) : (
              <p className="text-sm">{projects.find((p) => p.id === doc.project_id)?.name ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.memo')}</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>{tCommon('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={onRowsChange}
            emptyRow={emptyLine}
            readOnly={!editable}
          />
        </div>

        {order.links.length > 0 ? (
          <div className="space-y-2">
            <Label>{t('linksTitle')}</Label>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {order.links.map((l) => (
                <div key={`${l.direction}-${l.id}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-28 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {l.direction === 'from' ? t('linkCreatedFrom') : t('linkConvertedInto')}
                  </span>
                  <Link
                    href={docHref(l.kind, l.id)}
                    className="font-mono text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {l.document_number}
                  </Link>
                  <span className="text-slate-400 dark:text-slate-500">{t('docKind', { kind: l.kind })}</span>
                  <span className="flex-1" />
                  <Badge variant={STATUS_VARIANT[l.status] ?? 'secondary'}>
                    {statusLabel(l.status)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  )
}
