'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
}
interface BillPayload {
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

const emptyLine = (): LineRow => ({
  accountId: '',
  description: '',
  departmentId: '',
  projectId: '',
  taxCodeId: '',
  amount: '',
})

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[]): LineRow {
  const row: LineRow = {
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    taxCodeId: l.tax_code_id ?? '',
    amount: l.amount != null ? Number(l.amount).toFixed(2) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  return row
}

export function BillDrawer({
  bill,
  vendors,
  accounts,
  taxCodes,
  departments,
  projects,
  headerDefs,
  lineDefs,
}: {
  bill: BillPayload
  vendors: Opt[]
  accounts: Opt[]
  taxCodes: Opt[]
  departments: Opt[]
  projects: Opt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
}) {
  const router = useRouter()
  const doc = bill.doc
  const isDraft = doc.status === 'draft'
  // NetSuite-style edit-in-place: draft, approved, and POSTED bills are all
  // editable. Saving a posted bill re-materializes its GL-Impact projection
  // (the server blocks only GL changes into a closed period). pending_approval
  // and voided bills are read-only.
  const editable = doc.status === 'draft' || doc.status === 'approved' || doc.status === 'posted'

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    bill.lines.length > 0 ? bill.lines.map((l) => toRow(l, lineDefs)) : [emptyLine()],
  )
  const [totals, setTotals] = useState({ subtotal: doc.subtotal, taxTotal: doc.tax_total, total: doc.total })
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const rateByCode = useMemo(() => new Map(taxCodes.map((t) => [t.id, Number(t.rate ?? 0)])), [taxCodes])
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
      dueDate: dueDate || null,
      referenceNumber,
      memo,
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && Number(r.amount) > 0)
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: r.amount,
          taxCodeId: r.taxCodeId || null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }),
    [partyId, documentDate, dueDate, referenceNumber, memo, customValues, rows, lineDefs],
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
      const res = await fetch(`/api/bills/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const data = (await res.json()) as BillPayload
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

  async function act(action: 'submit' | 'post') {
    setBusy(true)
    const res = await fetch('/api/bills/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Action failed')
    else toast.success(action === 'submit' ? 'Submitted for approval' : 'Posted to the ledger')
    setBusy(false)
    router.refresh()
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => [
      {
        key: 'accountId',
        label: 'Account',
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: 'Account…',
      },
      { key: 'description', label: 'Description', width: 'minmax(160px,1.6fr)', type: 'text' },
      {
        key: 'departmentId',
        label: 'Department',
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      {
        key: 'projectId',
        label: 'Project',
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
      {
        key: 'taxCodeId',
        label: 'Tax',
        width: '110px',
        type: 'select',
        options: [{ value: '', label: 'No tax' }, ...taxCodes.map((t) => ({ value: t.id, label: t.code ?? '' }))],
      },
      ...customFieldColumns<LineRow>(lineDefs),
      { key: 'amount', label: 'Amount', width: '120px', type: 'amount', align: 'right', required: true },
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
    [accounts, departments, projects, taxCodes, lineDefs],
  )

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/ap"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={
        editable
          ? `${doc.vendor_name ? doc.vendor_name + ' · ' : ''}changes save automatically`
          : (doc.vendor_name ?? undefined)
      }
      headerActions={
        <>
          {isDraft ? (
            <Button disabled={busy || !partyId || Number(totals.total) <= 0} onClick={() => act('submit')}>
              Submit for approval
            </Button>
          ) : null}
          {doc.status === 'approved' ? (
            <Button disabled={busy} onClick={() => act('post')}>
              Post
            </Button>
          ) : null}
          {doc.entry_id ? (
            <Button variant="outline" asChild>
              <Link href={`/journal/${doc.entry_id}`}>View GL impact</Link>
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
            <Label>Vendor{editable ? <span className="text-red-500"> *</span> : null}</Label>
            {editable ? (
              <SearchSelect
                options={vendors.map((v) => ({ value: v.id, label: v.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder="Select vendor…"
              />
            ) : (
              <p className="text-sm">{doc.vendor_name}</p>
            )}
          </div>
          <div className={field}>
            <Label>Bill date</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={field}>
            <Label>Due date</Label>
            {editable ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.due_date ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>Vendor ref #</Label>
            {editable ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-3`}>
            <Label>Memo</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!editable} />

        <div className="space-y-2">
          <Label>Lines</Label>
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
