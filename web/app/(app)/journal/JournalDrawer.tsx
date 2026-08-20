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
};
interface SubsidiaryOpt {
  id: string
  name: string
  /** Root = 0; used to indent the picker like a tree. */
  depth: number
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
  partyId: string
  departmentId: string
  projectId: string
  subsidiaryId: string
  debit: string
  credit: string
}
interface JournalPayload {
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

// documents.status enum → common.status.* key (unknown values render verbatim).
const STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  approved: 'approved',
  pending_approval: 'pendingApproval',
  posted: 'posted',
  voided: 'voided',
  reversed: 'reversed',
}

const emptyLine = (): LineRow => ({
  accountId: '',
  description: '',
  partyId: '',
  departmentId: '',
  projectId: '',
  subsidiaryId: '',
  debit: '',
  credit: '',
})

/** Amount string → integer cents ('' / garbage → 0). */
const cents = (v: unknown): number => {
  if (v === '' || v == null) return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : Math.round(n * 100)
}

function toRow(l: Record<string, any>, lineDefs: CustomFieldDefClient[], segments: SegmentOpt[]): LineRow {
  const amt = Number(l.amount ?? 0)
  const row: LineRow = {
    accountId: l.account_id ?? '',
    description: l.description ?? '',
    partyId: l.party_id ?? '',
    departmentId: l.department_id ?? '',
    projectId: l.project_id ?? '',
    subsidiaryId: l.subsidiary_id ?? '',
    debit: amt > 0 ? amt.toFixed(2) : '',
    credit: amt < 0 ? (-amt).toFixed(2) : '',
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = (l.custom ?? {})[def.key] ?? ''
  for (const segment of segments) row[`seg_${segment.key}`] = (l.extra_dims ?? {})[segment.key] ?? ''
  return row
}

export function JournalDrawer({
  journal,
  initialMode = 'view',
  parties,
  accounts,
  departments,
  projects,
  subsidiaries,
  segments = [],
  headerDefs,
  lineDefs,
  layout,
}: {
  journal: JournalPayload
  initialMode?: DrawerMode
  parties: Opt[]
  accounts: Opt[]
  departments: Opt[]
  projects: Opt[]
  /** The org's subsidiaries (depth-first tree order). Only passed in
   *  multi-subsidiary orgs — empty/undefined renders NO subsidiary UI. */
  subsidiaries?: SubsidiaryOpt[]
  segments?: SegmentOpt[]
  headerDefs: CustomFieldDefClient[]
  lineDefs: CustomFieldDefClient[]
  layout?: FormLayoutConfig
}) {
  const { money } = useMoney()
  const t = useTranslations('journal.drawer')
  const tc = useTranslations('common')
  const router = useRouter()
  const doc = journal.doc
  const isDraft = doc.status === 'draft'
  // Existing records default to read-only; newly created drafts can explicitly
  // request edit mode. Draft and POSTED
  // journals are both editable — saving a posted journal re-materializes its
  // GL-Impact projection (the server blocks only GL changes into a closed
  // period). voided journals are read-only. Save is EXPLICIT — no autosave.
  const canEditStatus = doc.status === 'draft'
  const [mode, setMode] = useState<DrawerMode>(
    initialDrawerMode(initialMode, canEditStatus),
  )
  const editable = mode === 'edit' && canEditStatus

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? '')
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? '')
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? '')
  const [memo, setMemo] = useState<string>(doc.memo ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {})
  const [extraDims, setExtraDims] = useState<Record<string, string>>(doc.extra_dims ?? {})
  const [rows, setRows] = useState<LineRow[]>(
    journal.lines.length > 0 ? journal.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine(), emptyLine()],
  )
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // -- subsidiaries (multi-subsidiary orgs only; empty/undefined = no UI) ----
  // The header subsidiary is the journal's home entity; the OPTIONAL per-line
  // subsidiary override is the intercompany surface — the posting engine
  // auto-balances cross-subsidiary lines via due-to/due-from pairs.
  const multiSub = (subsidiaries?.length ?? 0) > 0
  const subsidiaryOpts = useMemo(
    () => (subsidiaries ?? []).map((s) => ({ value: s.id, label: '\u2003'.repeat(s.depth) + s.name })),
    [subsidiaries],
  )
  const rootSubsidiaryName = subsidiaries?.[0]?.name ?? '—'
  const subsidiaryName = (id: unknown): string =>
    id ? ((subsidiaries ?? []).find((s) => s.id === id)?.name ?? '—') : rootSubsidiaryName

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
      // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
      subsidiaryId: multiSub ? subsidiaryId || null : undefined,
      extraDims,
      custom: customValues,
      lines: rows
        .filter((r) => r.accountId && cents(r.debit) - cents(r.credit) !== 0)
        .map((r) => ({
          accountId: r.accountId,
          description: r.description,
          amount: ((cents(r.debit) - cents(r.credit)) / 100).toFixed(2), // signed: + debit / − credit
          partyId: r.partyId || null,
          departmentId: r.departmentId || null,
          projectId: r.projectId || null,
          // Intercompany line override (multi-subsidiary orgs only).
          subsidiaryId: multiSub ? r.subsidiaryId || null : undefined,
          extraDims: Object.fromEntries(segments.map((segment) => [segment.key, r[`seg_${segment.key}`]]).filter(([, value]) => value !== '' && value != null)),
          custom: Object.fromEntries(
            lineDefs.map((d) => [d.key, r[`cf_${d.key}`]]).filter(([, v]) => v !== '' && v != null),
          ),
        })),
    }),
    [partyId, documentDate, referenceNumber, memo, subsidiaryId, multiSub, customValues, extraDims, rows, lineDefs, segments],
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
    setSubsidiaryId(doc.subsidiary_id ?? '')
    setCustomValues(doc.custom ?? {})
    setExtraDims(doc.extra_dims ?? {})
    setRows(journal.lines.length > 0 ? journal.lines.map((l) => toRow(l, lineDefs, segments)) : [emptyLine(), emptyLine()])
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
    if (!res.ok) {
      toast.error(data.error ?? t('postFailed'))
      setBusy(false)
      return
    }
    if (data.pendingApproval) toast.success(tc('actions.submitForApproval'))
    else toast.success(t('postedToast'))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('deleteTitle'),
        message: t('deleteDraftBody'),
        confirmLabel: tc('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/journals/${doc.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(t('deleted'))
      router.push('/journal')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('deleteFailed'))
      setBusy(false)
    }
  }

  async function voidJournal() {
    const reason = await promptDialog({
      title: tc('amendment.voidTitle'),
      label: tc('amendment.reason'),
      placeholder: tc('amendment.voidPlaceholder'),
      confirmLabel: tc('actions.void'),
    })
    if (!reason) return
    setBusy(true)
    const res = await fetch(`/api/documents/${doc.id}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(data.error ?? t('postFailed'))
    else if (data.status === 'pending_approval') toast.success(tc('actions.submitForApproval'))
    else toast.success(tc('status.voided'))
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
        label: tc('labels.account'),
        width: 'minmax(200px,2fr)',
        type: 'search-select',
        required: true,
        options: accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
        placeholder: t('accountPlaceholder'),
      },
      description: { key: 'description', label: tc('labels.description'), width: 'minmax(160px,1.6fr)', type: 'text' },
      // Line-level entity: the customer/vendor/employee this leg belongs to
      // (source platform line "Name" / source platform line Entity). Required on AR/AP legs — the
      // kernel refuses a party-less open-item line; projects stay a sibling
      // column, exactly like the party/project kernel dimensions.
      party_id: {
        key: 'partyId',
        label: tc('labels.party'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: parties.map((p) => ({ value: p.id, label: p.display_name ?? p.name ?? '' })),
        placeholder: '—',
      },
      department_id: {
        key: 'departmentId',
        label: tc('labels.department'),
        width: '140px',
        type: 'select',
        options: [{ value: '', label: '—' }, ...departments.map((d) => ({ value: d.id, label: d.name ?? '' }))],
      },
      project_id: {
        key: 'projectId',
        label: tc('labels.project'),
        width: 'minmax(150px,1.2fr)',
        type: 'search-select',
        options: projects.map((p) => ({ value: p.id, label: p.name ?? '' })),
        placeholder: '—',
      },
      // Optional per-line subsidiary override — the intercompany journal
      // surface ('' = the header's subsidiary; posting auto-balances
      // cross-subsidiary lines via due-to/due-from pairs).
      ...(multiSub ? { subsidiary_id:
            {
              key: 'subsidiaryId',
              label: tc('labels.subsidiary'),
              width: '150px',
              type: 'select',
              options: [{ value: '', label: '—' }, ...subsidiaryOpts],
            } satisfies LineGridColumn<LineRow> } : {}),
      debit: { key: 'debit', label: t('columns.debit'), width: '120px', type: 'amount', align: 'right' },
      credit: { key: 'credit', label: t('columns.credit'), width: '120px', type: 'amount', align: 'right' },
      }
      const custom = new Map(customFieldColumns<LineRow>(lineDefs).map((column) => [column.key, column]))
      const segmentColumns: LineGridColumn<LineRow>[] = segments.filter((segment) => segment.showOnLines).map((segment) => ({
        key: `seg_${segment.key}`,
        label: segment.name,
        width: '150px',
        type: 'search-select',
        options: segment.values.map((value) => ({ value: value.id, label: `${value.code ? `${value.code} · ` : ''}${value.name}` })),
        placeholder: '—',
      }))
      if (!layout) return [...Object.values(builtIn), ...segmentColumns, ...custom.values()]
      const configured = layout.lines.columns.flatMap((placement) => {
        if (!placement.visible) return []
        const base = isCustomFieldKey(placement.key) ? custom.get(placement.key) : builtIn[placement.key]
        if (!base) return []
        return [{ ...base, width: placement.width ?? base.width, label: placement.labelOverride?.trim() || base.label }]
      })
      return [...configured, ...segmentColumns]
    },
    [accounts, departments, projects, multiSub, subsidiaryOpts, lineDefs, segments, layout, t, tc],
  )

  const field = 'space-y-1.5'
  const headerDefByKey = new Map(headerDefs.map((def) => [def.key, def]))
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const override = placement.labelOverride?.trim()
    if (isCustomFieldKey(placement.key)) {
      const def = headerDefByKey.get(customFieldDefKey(placement.key))
      return def ? <CustomFieldInput def={{ ...def, label: override || def.label, isRequired: placement.required ?? def.isRequired }} value={customValues[def.key]} onChange={(value) => setCustomValues((current) => ({ ...current, [def.key]: value }))} readOnly={!isEditable} /> : null
    }
    switch (placement.key) {
      case 'document_date':
        return <><Label>{override || tc('labels.date')}{isEditable ? <span className="text-red-500"> *</span> : null}</Label>{isEditable ? <Input type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} /> : <p className="text-sm">{doc.document_date}</p>}</>
      case 'party_id':
        return <><Label>{override || tc('labels.party')}</Label>{isEditable ? <SearchSelect options={parties.map((party) => ({ value: party.id, label: party.display_name ?? '' }))} value={partyId} onChange={(value) => setPartyId(value ?? '')} placeholder={t('noParty')} clearable emptyLabel={t('noParty')} /> : <p className="text-sm">{doc.party_name ?? '—'}</p>}</>
      case 'reference_number':
        return <><Label>{override || t('referenceNumber')}</Label>{isEditable ? <Input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} /> : <p className="text-sm">{doc.reference_number ?? '—'}</p>}</>
      case 'subsidiary_id':
        if (!multiSub) return null
        return <><Label>{override || tc('labels.subsidiary')}</Label>{isEditable && doc.status !== 'posted' ? <SearchSelect options={subsidiaryOpts} value={subsidiaryId} onChange={(value) => setSubsidiaryId(value ?? '')} clearable emptyLabel={rootSubsidiaryName} placeholder={rootSubsidiaryName} /> : <p className="text-sm">{subsidiaryName(subsidiaryId || doc.subsidiary_id)}</p>}</>
      case 'memo':
        return <><Label>{override || tc('labels.memo')}</Label>{isEditable ? <Input value={memo} onChange={(event) => setMemo(event.target.value)} /> : <p className="text-sm">{doc.memo ?? '—'}</p>}</>
      default:
        return null
    }
  }

  return (
    <TransactionDrawer
      closeHref="/journal"
      recordId={String(doc.id)}
      canEditAttachments
      panelClassName={docTypeMeta('journal').surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="journal" />
          <span className="font-mono">{doc.document_number}</span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? 'secondary'}>
            {STATUS_KEYS[doc.status] ? tc(`status.${STATUS_KEYS[doc.status]}`) : String(doc.status).replace('_', ' ')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? tc('feedback.editingHint') : (doc.party_name ?? undefined)}
      primaryAction={
        canEditStatus ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => mode === 'edit' ? cancel() : setMode('edit')}>
            {mode === 'edit' ? tc('actions.cancel') : tc('actions.edit')}
          </Button>
        ) : null
      }
      actions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tc('actions.saving') : tc('actions.save')}
              </Button>
            </>
          ) : (
            <>
              <PdfButton recordType="journal" recordId={String(doc.id)} />
              <FlowManualButtons subjectKind="journal" subjectId={String(doc.id)} />
              <ApprovalActions subjectKind="journal" subjectId={String(doc.id)} />
              {isDraft || doc.status === 'approved' ? (
                <Button disabled={busy || !balanced || dirty} onClick={post}>
                  {tc('actions.post')}
                </Button>
              ) : null}
              {doc.entry_id ? (
                <Button variant="outline" asChild>
                  <JournalEntryLink entryId={doc.entry_id}>{t('viewGlImpact')}</JournalEntryLink>
                </Button>
              ) : null}
              {doc.status === 'approved' || doc.status === 'posted' ? (
                <Button variant="ghost" disabled={busy} onClick={voidJournal} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tc('actions.void')}
                </Button>
              ) : null}
              {doc.status === 'draft' ? (
                <Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                  {tc('actions.delete')}
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
        {layout ? <HeaderFields layout={layout} editable={editable} renderField={renderHeaderField} /> : <><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          {multiSub ? (
            // Locked (read-only) once posted — the subsidiary shapes the GL
            // and intercompany balancing.
            <div className={field}>
              <Label>{tc('labels.subsidiary')}</Label>
              {editable && doc.status !== 'posted' ? (
                <SearchSelect
                  options={subsidiaryOpts}
                  value={subsidiaryId}
                  onChange={(v) => setSubsidiaryId(v ?? '')}
                  clearable
                  emptyLabel={rootSubsidiaryName}
                  placeholder={rootSubsidiaryName}
                />
              ) : (
                <p className="text-sm">{subsidiaryName(subsidiaryId || doc.subsidiary_id)}</p>
              )}
            </div>
          ) : null}
          <div className={`${field} lg:col-span-3`}>
            <Label>{tc('labels.memo')}</Label>
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
              return (
                <div className={field} key={segment.key}>
                  <Label>{segment.name}</Label>
                  {editable ? (
                    <SearchSelect
                      options={segment.values.map((value) => ({ value: value.id, label: `${value.code ? `${value.code} · ` : ''}${value.name}` }))}
                      value={selected}
                      onChange={(value) => setExtraDims((current) => ({ ...current, [segment.key]: value ?? '' }))}
                      placeholder="—"
                    />
                  ) : <p className="text-sm">{segment.values.find((value) => value.id === selected)?.name ?? '—'}</p>}
                </div>
              )
            })}
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>{tc('labels.lines')}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={handleRowsChange}
            emptyRow={emptyLine}
            readOnly={!editable}
            minRows={2}
            formatAmount={(value) => money(value, { currency: doc.currency })}
          />
        </div>

        {mode === 'view' ? (
          <ApprovalHistory subjectKind="journal" subjectId={String(doc.id)} />
        ) : null}
      </div>
    </TransactionDrawer>
  )
}
