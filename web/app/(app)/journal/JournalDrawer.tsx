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
import { DocTypeBadge } from '../../../components/doc-type-badge'
import { money } from '../../../lib/format'
import { confirmDialog } from '../../../lib/confirm'

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

// documents.status enum → common.status.* key (unknown values render verbatim).
const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  posted: 'posted',
  voided: 'voided',
  reversed: 'reversed',
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
  const t = useTranslations('journal.drawer')
  const tc = useTranslations('common')
  const router = useRouter()
  const doc = journal.doc
  const isDraft = doc.status === 'draft'
  // NetSuite-style record model: the flyout opens READ-ONLY (view mode) with an
  // Edit button; a brand-new draft opens straight into edit. Draft and POSTED
  // journals are both editable — saving a posted journal re-materializes its
  // GL-Impact projection (the server blocks only GL changes into a closed
  // period). voided journals are read-only. Save is EXPLICIT — no autosave.
  const canEditStatus = doc.status === 'draft' || doc.status === 'posted'
  const [mode, setMode] = useState<'view' | 'edit'>(isDraft ? 'edit' : 'view')
  const editable = mode === 'edit' && canEditStatus

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

  // -- explicit save (no autosave) -----------------------------------------
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
    setReferenceNumber(doc.reference_number ?? '')
    setMemo(doc.memo ?? '')
    setCustomValues(doc.custom ?? {})
    setRows(journal.lines.length > 0 ? journal.lines.map((l) => toRow(l, lineDefs)) : [emptyLine(), emptyLine()])
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/journals/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('postFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function post() {
    setBusy(true)
    const res = await fetch('/api/journals/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'post', documentId: doc.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('postFailed'))
    else toast.success(t('postedToast'))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    const posted = doc.status === 'posted'
    if (
      !(await confirmDialog({
        title: 'Delete this journal?',
        message: posted
          ? 'This permanently deletes the journal and removes its ledger impact. This cannot be undone.'
          : 'This permanently deletes the draft journal. This cannot be undone.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/journals/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Journal deleted')
      router.push('/journal')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? 'Delete failed')
      setBusy(false)
    }
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(
    () => [
      {
        key: 'accountId',
        label: tc('labels.account'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('accountPlaceholder'),
      },
      { key: 'description', label: tc('labels.description'), width: 'minmax(160px,1.6fr)', type: 'text' },
      {
        key: 'departmentId',
        label: tc('labels.department'),
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      {
        key: 'projectId',
        label: tc('labels.project'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
      ...customFieldColumns<LineRow>(lineDefs),
      { key: 'debit', label: t('columns.debit'), width: '120px', type: 'amount', align: 'right' },
      { key: 'credit', label: t('columns.credit'), width: '120px', type: 'amount', align: 'right' },
    ],
    [accounts, departments, projects, lineDefs, t, tc],
  )

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/journal"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="journal" />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {STATUS_KEYS[doc.status] ? tc(`status.${STATUS_KEYS[doc.status]}`) : String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? 'Editing — Save to apply changes' : (doc.party_name ?? undefined)}
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {canEditStatus ? (
                <Button variant="outline" onClick={() => setMode('edit')}>
                  Edit
                </Button>
              ) : null}
              {isDraft ? (
                <Button disabled={busy || !balanced || dirty} onClick={post}>
                  {tc('actions.post')}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <Link href={`/journal/${doc.entry_id}`}>{t('viewGlImpact')}</Link>
                </Button>
              ) : null}
              {doc.status !== 'voided' ? (
                <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  Delete
                </Button>
              ) : null}
            </>
          )}
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
            {mode === 'edit'
              ? saveState === 'saving'
                ? tc('actions.saving')
                : saveState === 'error'
                  ? t('saveFailedRetry')
                  : dirty
                    ? t('unsavedChanges')
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t.rich('totals', {
              debits: money(debits / 100),
              credits: money(credits / 100),
              strong: (chunks) => (
                <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>
              ),
            })}
          </span>
          {isDraft ? (
            diff !== 0 ? (
              <Badge variant="destructive">{t('outOfBalance', { amount: money(Math.abs(diff) / 100) })}</Badge>
            ) : debits > 0 ? (
              <Badge variant="success">{t('balanced')}</Badge>
            ) : null
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>{tc('labels.date')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
            {editable ? (
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{tc('labels.party')}</Label>
            {editable ? (
              <SearchSelect
                options={parties.map((p) => ({ value: p.id, label: p.display_name ?? '' }))}
                value={partyId}
                onChange={(v) => setPartyId(v ?? '')}
                placeholder={t('noParty')}
                clearable
                emptyLabel={t('noParty')}
              />
            ) : (
              <p className="text-sm">{doc.party_name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('referenceNumber')}</Label>
            {editable ? (
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.reference_number ?? '—'}</p>
            )}
          </div>
          <div className={`${field} lg:col-span-3`}>
            <Label>{tc('labels.memo')}</Label>
            {editable ? (
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? '—'}</p>
            )}
          </div>
        </div>

        <CustomFieldInputs defs={headerDefs} values={customValues} onChange={setCustomValues} readOnly={!editable} />

        <div className="space-y-2">
          <Label>{tc('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={handleRowsChange}
            emptyRow={emptyLine}
            readOnly={!editable}
            minRows={2}
          />
        </div>

        <AttachmentPanel targetTable="documents" targetId={doc.id} canEdit />
      </div>
    </UrlDrawer>
  )
}
