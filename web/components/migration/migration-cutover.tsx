'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Check, Circle, Loader2, Sparkles } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { ApiResponseError, apiJson } from '@/lib/api-error'
import { formatCivilDate } from '@/lib/format'
import { useViewerFormat } from '@/lib/viewer-format'
import { promptDialog } from '@/lib/prompt'
import { DataTransferPicker } from '@/components/data-transfer-picker'
import type { TransferJob } from '@/lib/data-io/transfer-contract'
import { addCalendarDays } from '@openbooks/engine/platform/civil-date'
import { MIGRATION_ASSISTANT_HREF } from '@/lib/migration/links'
import { deriveCutoverSteps, type CutoverStep } from '@/lib/migration/cutover-steps'
import { goLiveBlockers, isConnectorPath, MIGRATION_PATHS, type CutoverCheck, type MigrationPath, type MigrationPlan } from '@/lib/migration/plan-model'
import type { MigrationJourney } from '@/lib/migration/journey'

export interface CutoverAccountChoice {
  id: string
  number: string | null
  name: string
}

export interface MigrationCutoverProps {
  journey: MigrationJourney
  accounts: CutoverAccountChoice[]
  canDraftOpening: boolean
  canImport: boolean
  aiEnabled: boolean
}

interface OpeningPreview {
  lines: { rowNo: number; accountId: string; accountLabel: string; amount: string; description: string | null }[]
  totalDebits: string
  totalCredits: string
  net: string
  balancingLine: { accountId: string; accountLabel: string; amount: string } | null
  skippedZeroRows: number
  documentDate: string
}

interface OpeningDraft {
  journalId: string
  documentNumber: string | null
  status: string
  lineCount: number
  totalDebits: string
  href: string
}

function refusalIssues(reason: unknown): { rowNo: number; message: string }[] {
  if (reason instanceof ApiResponseError && reason.body !== null && typeof reason.body === 'object') {
    const issues = (reason.body as { issues?: unknown }).issues
    if (Array.isArray(issues)) {
      return issues.flatMap((issue) => {
        if (issue !== null && typeof issue === 'object') {
          const { rowNo, message } = issue as { rowNo?: unknown; message?: unknown }
          if (typeof rowNo === 'number' && typeof message === 'string') return [{ rowNo, message }]
        }
        return []
      })
    }
  }
  return []
}

function guessColumn(headers: string[], ...candidates: string[]): string {
  const lower = new Map(headers.map((header) => [header.toLowerCase(), header]))
  for (const candidate of candidates) {
    const hit = lower.get(candidate.toLowerCase())
    if (hit) return hit
  }
  return ''
}

function accountLabel(account: CutoverAccountChoice): string {
  return account.number ? `${account.number} ${account.name}` : account.name
}

/**
 * The guided migration cutover: the checklist every path works through,
 * with or without the assistant. Plan edits ride the audited migration
 * plan writer, the trial balance rides the native opening-balance preview
 * and draft, and go-live rides the governed go-live command — the same
 * commands the assistant uses, so this page can never bypass a refusal,
 * an approval, or an audit record those commands enforce. Steps never
 * gate each other: every step stays workable until go-live, which checks
 * its required evidence.
 */
export function MigrationCutover(props: MigrationCutoverProps) {
  const t = useTranslations('sync.migrationAssistant')
  const { locale } = useViewerFormat()
  const [journey, setJourney] = useState(props.journey)
  const [checks, setChecks] = useState<CutoverCheck[] | null>(props.journey.checks)
  const [measuring, setMeasuring] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const steps = useMemo(() => deriveCutoverSteps(journey.facts, checks), [journey, checks])
  const done = steps.filter((step) => step.state === 'complete').length

  async function refresh(withChecks: boolean) {
    try {
      const body = await apiJson<{ journey?: MigrationJourney }>(
        `/api/migration/journey${withChecks ? '?checks=1' : ''}`,
        { cache: 'no-store' },
        t('plan.loadFailed'),
      )
      if (!body.journey?.facts || !Array.isArray(body.journey.stages)) throw new Error(t('plan.loadFailed'))
      setJourney(body.journey)
      if (body.journey.checks) setChecks(body.journey.checks)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('plan.loadFailed'))
    }
  }

  async function measure() {
    setMeasuring(true)
    await refresh(true)
    setMeasuring(false)
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{t('cutover.anyOrder')}</p>
      {error ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p> : null}
      {notice ? <p role="status" className="rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-800 dark:bg-teal-950/40 dark:text-teal-200">{notice}</p> : null}

      <PlanCard
        plan={journey.plan}
        accounts={props.accounts}
        goLiveAt={journey.plan.goLive?.at ?? null}
        onSaved={(plan) => {
          setJourney((current) => ({ ...current, plan, facts: { ...current.facts, plan } }))
          setNotice(t('cutover.saved'))
        }}
        onError={setError}
      />

      <section aria-label={t('cutover.steps.title')} className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cutover.steps.title')}</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('cutover.progress', { done, total: steps.length })}</p>
        </div>
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} journey={journey} checks={checks} locale={locale} />
          ))}
        </ol>
      </section>

      {journey.plan.path === null || journey.plan.path === 'spreadsheet' ? (
        <OpeningCard
          journey={journey}
          accounts={props.accounts}
          canDraftOpening={props.canDraftOpening}
          canImport={props.canImport}
          onChanged={() => void refresh(false)}
          onError={setError}
          onNotice={setNotice}
        />
      ) : null}

      <ChecksCard
        journey={journey}
        checks={checks}
        measuring={measuring}
        onMeasure={() => void measure()}
        onRecorded={() => void refresh(true)}
        onError={setError}
        onNotice={setNotice}
      />

      {props.aiEnabled ? (
        <section className="rounded-xl border border-teal-200/70 bg-teal-50/50 px-5 py-4 dark:border-teal-900/60 dark:bg-teal-950/20">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Sparkles className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            {t('cutover.helper.title')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{t('cutover.helper.description')}</p>
          <Link href={MIGRATION_ASSISTANT_HREF} className="mt-2 inline-flex items-center gap-0.5 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('cutover.helper.action')}<ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </section>
      ) : null}
    </div>
  )
}

function PlanCard({ plan, accounts, goLiveAt, onSaved, onError }: {
  plan: MigrationPlan
  accounts: CutoverAccountChoice[]
  goLiveAt: string | null
  onSaved: (plan: MigrationPlan) => void
  onError: (message: string) => void
}) {
  const t = useTranslations('sync.migrationAssistant')
  const [path, setPath] = useState<MigrationPath | null>(plan.path)
  const [sourceLabel, setSourceLabel] = useState(plan.sourceLabel ?? '')
  const [cutoverDate, setCutoverDate] = useState(plan.cutoverDate ?? '')
  const [clearing, setClearing] = useState(plan.openingBalanceAccountId ?? '')
  const [saving, setSaving] = useState(false)
  const frozen = goLiveAt !== null
  const connector = isConnectorPath(path)

  async function save() {
    setSaving(true)
    try {
      const body = await apiJson<{ plan?: MigrationPlan }>('/api/migration/plan', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path,
          sourceSystem: path === 'fresh' ? null : path === 'spreadsheet' ? 'spreadsheet' : undefined,
          sourceLabel: sourceLabel.trim() ? sourceLabel.trim() : null,
          cutoverDate: cutoverDate ? cutoverDate : null,
          openingBalanceAccountId: clearing ? clearing : null,
        }),
      }, t('cutover.requestFailed'))
      if (!body.plan) throw new Error(t('cutover.requestFailed'))
      onSaved(body.plan)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('cutover.requestFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section id="cutover-plan" aria-label={t('cutover.setup.title')} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cutover.setup.title')}</h2>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('cutover.setup.description')}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.setup.path')}
          <select value={path ?? 'spreadsheet'} disabled={frozen} onChange={(event) => setPath(event.target.value as MigrationPath)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
            {MIGRATION_PATHS.map((option) => (
              <option key={option} value={option}>{t(`cutover.setup.paths.${option}`)}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.setup.source')}
          <input value={sourceLabel} disabled={frozen} onChange={(event) => setSourceLabel(event.target.value)}
            placeholder={t('cutover.setup.sourcePlaceholder')}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950" />
        </label>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.setup.cutoverDate')}
          <input type="date" value={cutoverDate} disabled={frozen} onChange={(event) => setCutoverDate(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950" />
          <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">{t('cutover.setup.cutoverDateHint')}</span>
        </label>
        <ClearingSelect value={clearing} accounts={accounts} disabled={frozen} onChange={setClearing} />
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('cutover.setup.pathHint')}</p>
      {connector ? (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          {t('cutover.setup.connector')}{' '}
          <Link href="/sync" className="font-medium text-teal-700 hover:underline dark:text-teal-300">{t('cutover.setup.openSync')}</Link>
        </div>
      ) : null}
      {path === 'fresh' ? <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('cutover.setup.freshNote')}</p> : null}
      <div className="mt-3">
        <Button type="button" size="sm" disabled={saving || frozen} onClick={() => void save()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {saving ? t('cutover.saving') : t('cutover.save')}
        </Button>
      </div>
    </section>
  )
}

function StepRow({ step, journey, checks, locale }: { step: CutoverStep; journey: MigrationJourney; checks: CutoverCheck[] | null; locale: string }) {
  const t = useTranslations('sync.migrationAssistant')
  const facts = journey.facts
  const href = step.key === 'checks' ? '#migration-checks'
    : step.key === 'opening' && facts.plan.path === 'spreadsheet' ? '#migration-opening'
    : step.key === 'plan' || step.key === 'cutoverDate' ? '#cutover-plan'
    : step.href
  const anchor = href.startsWith('#')
  return (
    <li className="flex gap-3 px-5 py-3">
      <span className={cn(
        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs',
        step.state === 'complete' && 'border-teal-600 bg-teal-600 text-white',
        step.state === 'current' && 'border-teal-500 bg-white text-teal-700 dark:bg-slate-950 dark:text-teal-300',
        step.state === 'upcoming' && 'border-slate-300 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-950',
      )}>
        {step.state === 'complete' ? <Check className="h-4 w-4" /> : step.state === 'current' ? <span className="h-2 w-2 rounded-full bg-teal-500" /> : <Circle className="h-2 w-2 fill-current" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={cn('text-sm font-medium', step.state === 'upcoming' ? 'text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-slate-100')}>{t(`cutover.steps.${step.key}.title`)}</p>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-800 dark:text-slate-300">
            {t(`cutover.state.${step.state}`)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t(`cutover.steps.${step.key}.description`)}</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"><StepDetail step={step} journey={journey} checks={checks} locale={locale} /></p>
        {anchor ? (
          <a href={href} className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t(`cutover.steps.${step.key}.action`)}<ArrowUpRight className="h-3 w-3" />
          </a>
        ) : (
          <Link href={href} className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t(`cutover.steps.${step.key}.action`)}<ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </li>
  )
}

function StepDetail({ step, journey, checks, locale }: { step: CutoverStep; journey: MigrationJourney; checks: CutoverCheck[] | null; locale: string }) {
  const t = useTranslations('sync.migrationAssistant')
  const facts = journey.facts
  switch (step.key) {
    case 'plan': return <>{facts.sourceName ?? t('plan.notSet')}</>
    case 'cutoverDate':
      return <>{journey.plan.cutoverDate ? formatCivilDate(journey.plan.cutoverDate, locale) : t('details.noCutover')}</>
    case 'opening': {
      const journal = facts.openingJournal
      if (!journal) return <>{t('cutover.stepDetail.noJournal')}</>
      return <>{t(journal.status === 'posted' ? 'cutover.stepDetail.journalPosted' : 'cutover.stepDetail.journalDraft', { number: journal.documentNumber ?? '' })}</>
    }
    case 'receivables':
    case 'payables': {
      const resource = step.key === 'receivables' ? 'txn:customer_invoice' : 'txn:vendor_bill'
      const found = facts.imports.find((entry) => entry.resource === resource)
      return <>{found ? t('cutover.stepDetail.imported', { count: found.committedJobs }) : t('cutover.stepDetail.notImported')}</>
    }
    case 'assets': {
      const found = facts.imports.find((entry) => entry.resource === 'fixed-assets')
      return <>{found ? t('cutover.stepDetail.imported', { count: found.committedJobs }) : t('cutover.stepDetail.notImported')}</>
    }
    case 'bank':
      return <>{facts.counts.bankAccounts > 0 ? t('cutover.stepDetail.bankReady', { count: facts.counts.bankAccounts }) : t('cutover.stepDetail.noBank')}</>
    case 'checks': {
      if (journey.plan.goLive) return <>{t('cutover.stepDetail.live', { date: formatCivilDate(journey.plan.goLive.cutoverDate, locale) })}</>
      if (!checks) return <>{t('checks.hint')}</>
      const blockers = goLiveBlockers(checks)
      return <>{blockers.length ? t('cutover.stepDetail.blockers', { count: blockers.length }) : t('cutover.stepDetail.ready')}</>
    }
  }
}

function ClearingSelect({ value, accounts, disabled, onChange }: { value: string; accounts: CutoverAccountChoice[]; disabled: boolean; onChange: (id: string) => void }) {
  const t = useTranslations('sync.migrationAssistant')
  return (
    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
      {t('cutover.setup.clearing')}
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
        <option value="">{t('cutover.setup.none')}</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>{accountLabel(account)}</option>
        ))}
      </select>
      <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">{t('cutover.setup.clearingHint')}</span>
    </label>
  )
}

function OpeningCard({ journey, accounts, canDraftOpening, canImport, onChanged, onError, onNotice }: {
  journey: MigrationJourney
  accounts: CutoverAccountChoice[]
  canDraftOpening: boolean
  canImport: boolean
  onChanged: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const t = useTranslations('sync.migrationAssistant')
  const { plan } = journey
  const [job, setJob] = useState<TransferJob | null>(null)
  const [columnAccount, setColumnAccount] = useState('')
  const [columnDebit, setColumnDebit] = useState('')
  const [columnCredit, setColumnCredit] = useState('')
  const [columnAmount, setColumnAmount] = useState('')
  const [columnDescription, setColumnDescription] = useState('')
  const [documentDate, setDocumentDate] = useState('')
  const [memo, setMemo] = useState('')
  const [receivablesLine, setReceivablesLine] = useState('')
  const [payablesLine, setPayablesLine] = useState('')
  const [equity, setEquity] = useState('')
  const [preview, setPreview] = useState<OpeningPreview | null>(null)
  const [draft, setDraft] = useState<OpeningDraft | null>(null)
  const [issues, setIssues] = useState<{ rowNo: number; message: string }[]>([])
  const [working, setWorking] = useState(false)
  const [draftKey] = useState(() => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `draft-${Date.now()}`)
  const hasJournal = journey.facts.openingJournal !== null || draft !== null
  // The journal is dated the day before the cutover. An empty field reads
  // as that date — including a cutover saved above after this card first
  // rendered — while anything the operator typed always wins.
  const effectiveDate = documentDate || (plan.cutoverDate ? addCalendarDays(plan.cutoverDate, -1) : '')

  function pickJob(next: TransferJob) {
    setJob(next)
    setPreview(null)
    setDraft(null)
    setIssues([])
    setColumnAccount(guessColumn(next.headers, 'Account'))
    setColumnDebit(guessColumn(next.headers, 'Debit'))
    setColumnCredit(guessColumn(next.headers, 'Credit'))
    setColumnAmount(guessColumn(next.headers, 'Amount', 'Balance'))
    setColumnDescription(guessColumn(next.headers, 'Description', 'Memo', 'Narration'))
  }

  function requestBody() {
    const remap = [
      ...(receivablesLine.trim() && plan.openingBalanceAccountId ? [{ from: receivablesLine.trim(), toAccountId: plan.openingBalanceAccountId }] : []),
      ...(payablesLine.trim() && plan.openingBalanceAccountId ? [{ from: payablesLine.trim(), toAccountId: plan.openingBalanceAccountId }] : []),
    ]
    return {
      transferId: job!.id,
      columns: {
        account: columnAccount,
        ...(columnAmount ? { amount: columnAmount } : { debit: columnDebit || undefined, credit: columnCredit || undefined }),
        ...(columnDescription ? { description: columnDescription } : {}),
      },
      documentDate: effectiveDate,
      ...(memo.trim() ? { memo: memo.trim() } : {}),
      ...(equity ? { balancingAccountId: equity } : {}),
      ...(remap.length ? { accountRemap: remap } : {}),
    }
  }

  async function runPreview() {
    if (!job) return
    setWorking(true)
    setIssues([])
    try {
      const body = await apiJson<{ preview?: OpeningPreview }>('/api/migration/opening-balances/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody()),
      }, t('cutover.requestFailed'))
      if (!body.preview) throw new Error(t('cutover.requestFailed'))
      setPreview(body.preview)
      setDraft(null)
    } catch (reason) {
      setIssues(refusalIssues(reason))
      onError(reason instanceof Error ? reason.message : t('cutover.requestFailed'))
    } finally {
      setWorking(false)
    }
  }

  async function runDraft() {
    if (!job || !preview) return
    setWorking(true)
    try {
      const body = await apiJson<{ draft?: OpeningDraft }>('/api/migration/opening-balances/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody(), idempotencyKey: draftKey }),
      }, t('cutover.requestFailed'))
      if (!body.draft) throw new Error(t('cutover.requestFailed'))
      setDraft(body.draft)
      onNotice(t('cutover.opening.drafted', { number: body.draft.documentNumber ?? '' }))
      onChanged()
    } catch (reason) {
      setIssues(refusalIssues(reason))
      onError(reason instanceof Error ? reason.message : t('cutover.requestFailed'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <section id="migration-opening" aria-label={t('cutover.opening.title')} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cutover.opening.title')}</h2>
      <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{t('cutover.opening.description')}</p>
      {!canDraftOpening ? (
        <p role="note" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {t('cutover.opening.needsPermission')}
        </p>
      ) : null}
      {!plan.cutoverDate ? (
        <p role="note" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {t('cutover.opening.needsCutover')}
        </p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          {canImport ? <DataTransferPicker kind="import" job={job} onChange={pickJob} /> : null}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {job ? t('cutover.opening.staged', { name: job.filename, rows: job.totalRows }) : t('cutover.opening.noFile')}{' '}
            <Link href="/data/import" className="font-medium text-teal-700 hover:underline dark:text-teal-300">{t('cutover.opening.upload')}</Link>
          </p>
        </div>
        <ColumnSelect label={t('cutover.opening.columnAccount')} value={columnAccount} headers={job?.headers ?? []} onChange={setColumnAccount} />
        <ColumnSelect label={t('cutover.opening.columnDescription')} value={columnDescription} headers={job?.headers ?? []} onChange={setColumnDescription} optional />
        <ColumnSelect label={t('cutover.opening.columnDebit')} value={columnDebit} headers={job?.headers ?? []} onChange={setColumnDebit} optional />
        <ColumnSelect label={t('cutover.opening.columnCredit')} value={columnCredit} headers={job?.headers ?? []} onChange={setColumnCredit} optional />
        <div className="sm:col-span-2">
          <ColumnSelect label={t('cutover.opening.columnAmount')} value={columnAmount} headers={job?.headers ?? []} onChange={setColumnAmount} optional />
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('cutover.opening.columnAmountHint')}</p>
        </div>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.opening.documentDate')}
          <input type="date" value={effectiveDate} onChange={(event) => setDocumentDate(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950" />
          <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">{t('cutover.opening.documentDateHint')}</span>
        </label>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.opening.memo')}
          <input value={memo} onChange={(event) => setMemo(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950" />
        </label>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.opening.receivablesLine')}
          <input value={receivablesLine} onChange={(event) => setReceivablesLine(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950" />
        </label>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('cutover.opening.payablesLine')}
          <input value={payablesLine} onChange={(event) => setPayablesLine(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950" />
        </label>
        <div className="sm:col-span-2">
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('cutover.opening.remapHint')}</p>
        </div>
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 sm:col-span-2">
          {t('cutover.opening.equity')}
          <select value={equity} onChange={(event) => setEquity(event.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
            <option value="">{t('cutover.setup.none')}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{accountLabel(account)}</option>
            ))}
          </select>
          <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">{t('cutover.opening.equityHint')}</span>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={working || !job || !columnAccount || !effectiveDate || !canDraftOpening} onClick={() => void runPreview()}>
          {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {working ? t('cutover.opening.previewing') : t('cutover.opening.preview')}
        </Button>
        <Button type="button" size="sm" disabled={working || !preview || hasJournal && !draft} onClick={() => void runDraft()}>
          {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {working ? t('cutover.opening.drafting') : t('cutover.opening.draft')}
        </Button>
      </div>
      {preview ? (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/60">
          <p className="font-medium text-slate-800 dark:text-slate-200">{t('cutover.opening.totals', { debits: preview.totalDebits, credits: preview.totalCredits })}</p>
          <p className="mt-0.5 text-slate-500 dark:text-slate-400">{t('cutover.opening.lines', { count: preview.lines.length, skipped: preview.skippedZeroRows })}</p>
          {preview.balancingLine ? (
            <p className="mt-0.5 text-slate-500 dark:text-slate-400">{preview.balancingLine.accountLabel} · {preview.balancingLine.amount}</p>
          ) : null}
        </div>
      ) : null}
      {issues.length ? (
        <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <p className="font-medium">{t('cutover.opening.issues')}</p>
          <ul className="mt-1 list-disc pl-4">
            {issues.map((issue, index) => <li key={index}>{issue.message}</li>)}
          </ul>
        </div>
      ) : null}
      {draft ? (
        <p className="mt-3 text-xs">
          <Link href={draft.href} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{t('cutover.opening.openDraft')}</Link>
        </p>
      ) : null}
    </section>
  )
}

function ColumnSelect({ label, value, headers, onChange, optional = false }: {
  label: string
  value: string
  headers: string[]
  onChange: (header: string) => void
  optional?: boolean
}) {
  return (
    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
        {optional ? <option value="">—</option> : null}
        {headers.map((header) => (
          <option key={header} value={header}>{header}</option>
        ))}
      </select>
    </label>
  )
}

function ChecksCard({ journey, checks, measuring, onMeasure, onRecorded, onError, onNotice }: {
  journey: MigrationJourney
  checks: CutoverCheck[] | null
  measuring: boolean
  onMeasure: () => void
  onRecorded: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const t = useTranslations('sync.migrationAssistant')
  const { locale } = useViewerFormat()
  const [recording, setRecording] = useState(false)
  const blockers = checks ? goLiveBlockers(checks) : []
  const live = journey.plan.goLive

  async function recordGoLive() {
    if (!journey.plan.cutoverDate || recording) return
    const reason = await promptDialog({
      title: t('cutover.goLive.record'),
      message: t('cutover.goLive.confirm', { date: formatCivilDate(journey.plan.cutoverDate, locale) }),
      label: t('cutover.goLive.reason'),
      placeholder: t('cutover.goLive.reasonPlaceholder'),
      confirmLabel: t('cutover.goLive.record'),
    })
    if (!reason) return
    setRecording(true)
    try {
      const body = await apiJson<{ goLive?: { cutoverDate: string } }>('/api/migration/go-live', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: reason }),
      }, t('cutover.requestFailed'))
      if (!body.goLive) throw new Error(t('cutover.requestFailed'))
      onNotice(t('cutover.goLive.recorded', { date: formatCivilDate(body.goLive.cutoverDate, locale) }))
      onRecorded()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('cutover.requestFailed'))
    } finally {
      setRecording(false)
    }
  }

  return (
    <section id="migration-checks" aria-label={t('checks.title')} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('checks.title')}</h2>
        <Button type="button" size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={onMeasure} disabled={measuring}>
          {measuring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {measuring ? t('checks.running') : checks ? t('checks.rerun') : t('checks.run')}
        </Button>
      </div>
      {checks ? (
        <>
          <ul className="mt-3 space-y-2">
            {checks.filter((check) => check.state !== 'not_applicable').map((check) => (
              <li key={check.key} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 shrink-0">
                  {check.state === 'pass' ? <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> : <Circle className="h-3.5 w-3.5 text-slate-400" />}
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={check.href} className="font-medium text-slate-800 hover:underline dark:text-slate-200">{t(`checks.items.${check.key}`)}</Link>
                  <span className="ml-1.5 text-slate-400">{check.required ? t('checks.required') : t('checks.advisory')}</span>
                  <p className="text-slate-500 dark:text-slate-400">{t(`checks.state.${check.state}`)}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className={cn('mt-3 text-xs', blockers.length ? 'text-amber-700 dark:text-amber-300' : 'text-teal-700 dark:text-teal-300')}>
            {live ? t('checks.live') : blockers.length ? t('checks.blocked', { count: blockers.length }) : t('checks.ready')}
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('checks.hint')}</p>
      )}
      {!live ? (
        <div className="mt-3">
          <Button type="button" size="sm" disabled={recording || !journey.plan.cutoverDate} onClick={() => void recordGoLive()}>
            {recording ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {recording ? t('cutover.goLive.recording') : t('cutover.goLive.record')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
