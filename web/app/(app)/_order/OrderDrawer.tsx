'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
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

/** Per-kind wording + the base list route/param for the flyout close href. */
const KIND_META: Record<OrderKind, { partyLabel: string; dateLabel: string; expiryLabel: string; base: string; param: string }> = {
  quote: { partyLabel: 'Customer', dateLabel: 'Estimate date', expiryLabel: 'Expiry date', base: '/estimates', param: 'estimate' },
  sales_order: { partyLabel: 'Customer', dateLabel: 'Order date', expiryLabel: 'Ship / due date', base: '/sales-orders', param: 'order' },
  purchase_order: { partyLabel: 'Vendor', dateLabel: 'Order date', expiryLabel: 'Expected date', base: '/purchase-orders', param: 'order' },
}

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
  const router = useRouter()
  const doc = order.doc
  const meta = KIND_META[kind]
  const isDraft = doc.status === 'draft'
  const isApproved = doc.status === 'approved'
  const editable = isDraft && canManage

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

  // -- autosave (drafts only) ------------------------------------------------
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
      const res = await fetch(`${apiBase}/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const data = (await res.json()) as OrderPayload
        setTotals({ subtotal: data.doc.subtotal, taxTotal: data.doc.tax_total, total: data.doc.total })
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, editable])

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
      toast.error(data.error ?? 'Action failed')
      return
    }
    toast.success(status === 'approved' ? 'Issued' : 'Voided')
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
        title: 'Void this document?',
        message: 'Voiding cancels the order. This cannot be undone.',
        confirmLabel: 'Void',
        tone: 'danger',
      }))
    )
      return
    await setStatus('voided')
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
      toast.error(data.error ?? 'Conversion failed')
      return
    }
    toast.success(`${label} ${data.documentNumber} created`)
    router.push(targetHref(data.kind, data.id))
    router.refresh()
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => [
      {
        key: 'itemId',
        label: 'Item',
        width: 'minmax(170px,1.6fr)',
        type: 'search-select',
        options: items.map((i) => ({ value: i.id, label: `${i.code ? i.code + ' · ' : ''}${i.name ?? ''}`.trim() })),
        placeholder: '—',
      },
      {
        key: 'accountId',
        label: kind === 'purchase_order' ? 'Account' : 'Income account',
        width: 'minmax(180px,1.8fr)',
        type: 'search-select',
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: 'Account…',
      },
      { key: 'description', label: 'Description', width: 'minmax(150px,1.6fr)', type: 'text' },
      { key: 'quantity', label: 'Qty', width: '90px', type: 'amount', align: 'right', required: true },
      { key: 'unitPrice', label: 'Unit price', width: '110px', type: 'amount', align: 'right', required: true },
      {
        key: 'taxCodeId',
        label: 'Tax',
        width: '110px',
        type: 'select',
        options: [{ value: '', label: 'No tax' }, ...taxCodes.map((t) => ({ value: t.id, label: t.code ?? '' }))],
      },
      {
        key: '_amount',
        label: 'Amount',
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
        label: 'Tax amt',
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
    [accounts, items, taxCodes, kind],
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
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {String(doc.status).replace('_', ' ')}
          </Badge>
          {converted.partial ? (
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              Converted {converted.billed % 1 === 0 ? converted.billed : converted.billed.toFixed(2)}/
              {converted.ordered % 1 === 0 ? converted.ordered : converted.ordered.toFixed(2)}
            </span>
          ) : converted.full ? (
            <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">Fully converted</span>
          ) : null}
        </span>
      }
      description={editable ? 'Draft — changes save automatically.' : (doc.party_name ?? undefined)}
      headerActions={
        canManage ? (
          <>
            {isDraft ? (
              <Button disabled={busy || !canIssue} onClick={issue}>
                Issue
              </Button>
            ) : null}
            {isApproved
              ? convertTargets.map((t) => (
                  <Button key={t.kind} disabled={busy} onClick={() => convert(t.kind, t.label)}>
                    Convert to {t.label}
                  </Button>
                ))
              : null}
            {isApproved ? (
              <Button variant="outline" disabled={busy} onClick={voidOrder}>
                Void
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
            {editable
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'error'
                    ? 'Save failed — fix and retry'
                    : 'Unsaved changes…'
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            Subtotal {money(totals.subtotal)} · Tax {money(totals.taxTotal)} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">Total {money(totals.total)}</strong>
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {meta.partyLabel}
              {editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <SearchSelect
                options={parties.map((c) => ({ value: c.id, label: c.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={`Select ${meta.partyLabel.toLowerCase()}…`}
              />
            ) : (
              <p className="text-sm">{doc.party_name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{meta.dateLabel}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>{meta.expiryLabel}</Label>
            {editable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.due_date ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>Department</Label>
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
            <Label>Project</Label>
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
            <Label>Memo</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Lines</Label>
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
            <Label>Origin / Converted into</Label>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {order.links.map((l) => (
                <div key={`${l.direction}-${l.id}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-28 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {l.direction === 'from' ? 'Created from' : 'Converted into'}
                  </span>
                  <Link
                    href={docHref(l.kind, l.id)}
                    className="font-mono text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {l.document_number}
                  </Link>
                  <span className="text-slate-400 dark:text-slate-500">{l.kind.replace('_', ' ')}</span>
                  <span className="flex-1" />
                  <Badge variant={STATUS_VARIANT[l.status] ?? 'secondary'}>
                    {String(l.status).replace('_', ' ')}
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
