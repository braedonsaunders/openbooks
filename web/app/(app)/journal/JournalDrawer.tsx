'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, UrlDrawer } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { CustomFieldInputs, customFieldColumns, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { AttachmentPanel } from '../../../components/attachment-panel'
import { confirmDialog } from '../../../lib/confirm'
import { money } from '../../../lib/format'

interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
}
interface LineRow extends Record<string, unknown> {
  accountId: string
  description: string
  departmentId: string
  projectId: string
  debit: string
  credit: string
}
interface JournalPayload {
  doc: Record<string, any>
  lines: Record<string, any>[]
}

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  draft: 'secondary',
  voided: 'outline',
}

const emptyLine = (): LineRow => ({
  accountId: '',
  description: '',
  departmentId: '',
  projectId: '',
  debit: '',
  credit: '',
})

/** Amount string → integer cents ('' / garbage → 0). */
const cents = (v: unknown): number => {
  if (v === '' || v == null) return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : Math.round(n * 100)
}

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[]): LineRow {
  const amt = Number(l.amount ?? 0)
  const row: LineRow = {
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    debit: amt > 0 ? amt.toFixed(2) : '',
    credit: amt < 0 ? (-amt).toFixed(2) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  return row
}

export function JournalDrawer({
  journal,
  parties,
  accounts,
  departments,
  projects,
  headerDefs,
  lineDefs,
}: {
  journal: JournalPayload
  parties: Opt[]
  accounts: Opt[]
  departments: Opt[]
  projects: Opt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
}) {
  const router = useRouter()
  const doc = journal.doc
  const isDraft = doc.status === 'draft'

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    journal.lines.length > 0 ? journal.lines.map((l) => toRow(l, lineDefs)) : [emptyLine(), emptyLine()],
  )
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  /** Each row carries exactly one side: entering one clears the other. */
  function handleRowsChange(next: LineRow[]) {
    setRows(
      next.map((r, i) => {
        const prev = rows[i]
        if (!prev) return r
        if (r.debit !== prev.debit && r.debit !== '') return { ...r, credit: '' }
        if (r.credit !== prev.credit && r.credit !== '') return { ...r, debit: '' }
        return r
      }),
    )
  }

  const { debits, credits, diff } = useMemo(() => {
    let d = 0
    let c = 0
    for (const r of rows) {
      d += cents(r.debit)
      c += cents(r.credit)
    }
    return { debits: d, credits: c, diff: d - c }
  }, [rows])
  const balanced = diff === 0 && debits > 0

  // -- autosave (drafts only) ----------------------------------------------
  const payload = useMemo(
    () => ({
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && cents(r.debit) - cents(r.credit) !== 0)
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: ((cents(r.debit) - cents(r.credit)) / 100).toFixed(2), // signed: + debit / − credit
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }),
    [partyId, documentDate, referenceNumber, memo, customValues, rows, lineDefs],
  )
  const first = useRef(true)
  useEffect(() => {
    if (!isDraft) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/journals/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, isDraft])

  async function post() {
    setBusy(true)
    const res = await fetch('/api/journals/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'post', documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Posting failed')
    else toast.success('Posted to the ledger')
    setBusy(false)
    router.refresh()
  }

  async function edit() {
    if (
      !(await confirmDialog({
        title: 'Edit this journal?',
        message: 'Editing reverses the current GL posting and reopens this as a draft. Continue?',
        confirmLabel: 'Edit',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch('/api/journals/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reopen', documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Action failed')
    else toast.success('Reopened as a draft — the GL posting was reversed')
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
      ...customFieldColumns<LineRow>(lineDefs),
      { key: 'debit', label: 'Debit', width: '120px', type: 'amount', align: 'right' },
      { key: 'credit', label: 'Credit', width: '120px', type: 'amount', align: 'right' },
    ],
    [accounts, departments, projects, lineDefs],
  )

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/journal"
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
        isDraft
          ? 'Draft — changes save automatically. Debits and credits must balance to post.'
          : (doc.party_name ?? undefined)
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {isDraft
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
            Debits <strong className="text-slate-900 dark:text-slate-100">{money(debits / 100)}</strong> · Credits{' '}
            <strong className="text-slate-900 dark:text-slate-100">{money(credits / 100)}</strong>
          </span>
          {isDraft ? (
            diff !== 0 ? (
              <Badge variant="destructive">Out of balance · {money(Math.abs(diff) / 100)}</Badge>
            ) : debits > 0 ? (
              <Badge variant="success">Balanced</Badge>
            ) : null
          ) : null}
          {isDraft ? (
            <Button disabled={busy || !balanced || saveState !== 'saved'} onClick={post}>
              Post
            </Button>
          ) : null}
          {doc.status === 'posted' ? (
            <Button variant="outline" disabled={busy} onClick={edit}>
              Edit
            </Button>
          ) : null}
          {doc.entry_id ? (
            <Button variant="outline" asChild>
              <Link href={`/journal/${doc.entry_id}`}>View GL impact</Link>
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>Date{isDraft ? <span className="text-red-500"> *</span> : null}</Label>
            {isDraft ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>Party</Label>
            {isDraft ? (
              <SearchSelect
                options={parties.map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder="No party"
                clearable
                emptyLabel="No party"
              />
            ) : (
              <p className="text-sm">{doc.party_name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>Reference #</Label>
            {isDraft ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-3`}>
            <Label>Memo</Label>
            {isDraft ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!isDraft} />

        <div className="space-y-2">
          <Label>Lines</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={handleRowsChange}
            emptyRow={emptyLine}
            readOnly={!isDraft}
            minRows={2}
          />
        </div>

        <AttachmentPanel targetTable="documents" targetId={doc.id} canEdit />
      </div>
    </UrlDrawer>
  )
}
