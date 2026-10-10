'use client'

import { sum } from '@openbooks/engine/src/money/money.ts'
import { useMoney } from '@/components/money-provider'
import type { MoneyValue } from '@/lib/money-format'
import type { Dispatch, SetStateAction } from 'react'
import { useId, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Ban, CheckCheck, Link2, Pencil, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { SearchInput } from '../../../../../../components/search-input'
import { Pagination } from '../../../../../../components/pagination'
import { SortTh } from '../../../../../../components/sortable-th'
import { confirmDialog } from '../../../../../../lib/confirm'
import { promptDialog } from '../../../../../../lib/prompt'
import { isZeroAmount } from './DifferenceBadge'
import { canonicalDecimal } from '../../../../../../lib/exact-decimal'
import { useDirtyClose } from '../../../../../../lib/use-dirty-close'
import { InteractiveTableRow } from '@/components/interactive-table-row'

type Search = Record<string, string | string[] | undefined>
interface PaneParams {
  q: string | undefined
  sort: string
  dir: 'asc' | 'desc'
  page: number
  perPage: number
}

interface StmtRow {
  id: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref: string | null
}
interface GlRow {
  id: string
  posting_date: string
  entry_number: string
  amount: string
  memo: string | null
  party: string | null
}
interface MatchedRow {
  id: string
  statement_line_id: string
  matched_by: 'auto' | 'manual' | 'rule'
  confidence: string | null
  stmt_date: string
  stmt_amount: string
  stmt_description: string | null
  entry_number: string
  gl_date: string
  gl_amount: string
  gl_memo: string | null
}

interface GlClearing {
  group_id: string
  lines: number
  entries: string | null
  total: string
}
interface ReconciliationActionResult {
  error?: string
  matched?: number
  highConfidence?: number
  mediumConfidence?: number
  journalLinesReconciled?: number
}

interface SignOffBlocker {
  id: string
  postedOn: string
  amount: string
  description: string | null
}

// The blockers endpoint returns the engine's camelCase SignOffBlocker;
// normalize once so the list below never renders a blank date.
function blockerPostedOn(line: SignOffBlocker & { posted_on?: string }): string {
  return line.postedOn ?? line.posted_on ?? ''
}

const selectedRow = 'bg-teal-50 dark:bg-teal-950/40'

function useScopedSelection<T>(scope: string, initialValue: T): readonly [T, Dispatch<SetStateAction<T>>] {
  const [stored, setStored] = useState<{ scope: string; value: T }>(() => ({ scope, value: initialValue }))
  const value = stored.scope === scope ? stored.value : initialValue
  const setValue: Dispatch<SetStateAction<T>> = (next) => setStored((current) => {
    const previous = current.scope === scope ? current.value : initialValue
    return { scope, value: typeof next === 'function' ? (next as (value: T) => T)(previous) : next }
  })
  return [value, setValue]
}

// Known matched_by enum values — unknown values render verbatim.
const MATCHED_BY_KEYS = ['auto', 'manual', 'rule']

/**
 * Two-pane matching workspace: unmatched bank statement lines (left) against
 * unreconciled posted GL lines (right). Click a bank line, tick 1..n GL lines,
 * Match. Sign-off unlocks only at a 0.00 difference.
 */
type ReconcileWorkspaceProps = {
  basePath: string
  accountPath: string
  currentParams: Search
  reconciliation: { id: string; status: string; throughDate: string; statementBalance: string; currency: string }
  difference: string
  canReconcile: boolean
  stmtRows: StmtRow[]
  stmtTotal: number
  stmtOutstandingTotal: string
  stmtParams: PaneParams
  glRows: GlRow[]
  glTotal: number
  glOutstandingTotal: string
  glParams: PaneParams
  matchedRows: MatchedRow[]
  matchedTotal: number
  mParams: PaneParams
  glClearings?: GlClearing[]
}

export function ReconcileWorkspace(props: ReconcileWorkspaceProps) {
  return <ReconcileWorkspaceForId key={props.reconciliation.id} {...props} />
}

function ReconcileWorkspaceForId({
  basePath,
  accountPath,
  currentParams,
  reconciliation,
  difference,
  canReconcile,
  stmtRows,
  stmtTotal,
  stmtOutstandingTotal,
  stmtParams,
  glRows,
  glTotal,
  glOutstandingTotal,
  glParams,
  matchedRows,
  matchedTotal,
  mParams,
  glClearings = [],
}: ReconcileWorkspaceProps) {
  const { money: formatMoney } = useMoney(reconciliation.currency)
  const money = (value: MoneyValue) => formatMoney(value, { maximumFractionDigits: 4 })
  const t = useTranslations('banking.workspace')
  const tMatch = useTranslations('banking.match')
  const tBanking = useTranslations('banking')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  // A refused sign-off that only fires a transient toast reads as "nothing
  // happened" once it dismisses: the typed refusal persists as a workspace
  // alert with the blocking lines beside it, cleared by the next success.
  const [signOffError, setSignOffError] = useState<string | null>(null)
  const [blockers, setBlockers] = useState<{ lines: SignOffBlocker[]; total: number } | null>(null)
  const subjectKey = reconciliation.id
  const selectionKey = JSON.stringify([
    subjectKey,
    stmtParams.q, stmtParams.sort, stmtParams.dir, stmtParams.page, stmtParams.perPage,
    glParams.q, glParams.sort, glParams.dir, glParams.page, glParams.perPage,
  ])
  const [selectedStmts, setSelectedStmts] = useScopedSelection<Set<string>>(selectionKey, new Set())
  const [selectedGl, setSelectedGl] = useScopedSelection<Set<string>>(selectionKey, new Set())
  const [adjustOpen, setAdjustOpen] = useState(false)
  const adjustThroughDateId = useId()
  const adjustStatementBalanceId = useId()
  const [throughDate, setThroughDate] = useState(reconciliation.throughDate)
  const [statementBalance, setStatementBalance] = useState(() =>
    reconciliation.statementBalance,
  )
  const closeAdjust = () => {
    setAdjustOpen(false)
    setThroughDate(reconciliation.throughDate)
    setStatementBalance(reconciliation.statementBalance)
  }
  const adjustCloseGuard = useDirtyClose({
    dirty: throughDate !== reconciliation.throughDate || statementBalance !== reconciliation.statementBalance,
    busy, onClose: closeAdjust,
    message: tCommon('feedback.unsavedChanges'), confirmLabel: tCommon('confirm.discardChanges'),
  })

  const signedOff = reconciliation.status === 'signed_off'
  const zero = isZeroAmount(difference)
  const readOnly = signedOff || !canReconcile

  const stmtSelectionSum = useMemo(
    () => sum(stmtRows.filter((r) => selectedStmts.has(r.id)).map((r) => r.amount)),
    [stmtRows, selectedStmts],
  )
  const glSelectionSum = useMemo(
    () => sum(glRows.filter((r) => selectedGl.has(r.id)).map((r) => r.amount)),
    [glRows, selectedGl],
  )

  async function call(method: string, url: string, body?: unknown, onError?: (message: string) => void): Promise<ReconciliationActionResult | null> {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      // The error body may not be JSON (empty body, proxy 5xx page): never
      // let the read itself throw, or the failure goes silent with an
      // unhandled rejection.
      const data = await res.json().catch(() => null) as ReconciliationActionResult | null
      if (!res.ok) {
        const message = data?.error ?? tBanking('errors.requestFailed')
        if (onError) onError(message); else toast.error(message)
        return null
      }
      // A success moves the session: any persisted refusal is stale.
      setSignOffError(null)
      setBlockers(null)
      return data
    } catch {
      const message = tBanking('errors.requestFailed')
      if (onError) onError(message); else toast.error(message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function loadBlockers() {
    // Supplementary read beside the persisted refusal: its own failure must
    // never toast or wedge — the refusal already shows without the list.
    try {
      const res = await fetch(`/api/banking/reconciliations/${reconciliation.id}/blockers`)
      const data = await res.json().catch(() => null) as { lines?: SignOffBlocker[]; total?: number } | null
      if (res.ok && Array.isArray(data?.lines)) {
        setBlockers({ lines: data.lines, total: typeof data.total === 'number' ? data.total : data.lines.length })
      }
    } catch {
      // ignore: the refusal alert stands on its own
    }
  }

  async function runAutoMatch() {
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/auto-match`)
    if (!data) return
    if (data.matched === 0) toast.info(t('noAutoMatches'))
    else
      toast.success(
        t('autoMatchedToast', {
          count: data.matched ?? 0,
          high: data.highConfidence ?? 0,
          medium: data.mediumConfidence ?? 0,
        }),
      )
    router.refresh()
  }

  async function matchSelected() {
    if (selectedStmts.size === 0 || selectedGl.size === 0) return
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/matches`, {
      statementLineIds: [...selectedStmts],
      journalLineIds: [...selectedGl],
    })
    if (!data) return
    toast.success(t('matchedToast'))
    setSelectedStmts(new Set())
    setSelectedGl(new Set())
    router.refresh()
  }

  async function clearSelected() {
    // GL-only offsetting lines with no bank counterpart clear as a zero-sum
    // group — no statement selection required.
    if (selectedStmts.size > 0 || selectedGl.size === 0) return
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/gl-clearing`, {
      journalLineIds: [...selectedGl],
    })
    if (!data) return
    toast.success(t('clearedToast'))
    setSelectedGl(new Set())
    router.refresh()
  }

  async function unmatchClearing(groupId: string) {
    const data = await call('DELETE', `/api/banking/reconciliations/${reconciliation.id}/gl-clearing?groupId=${groupId}`)
    if (!data) return
    toast.success(t('unmatchedToast'))
    router.refresh()
  }

  async function unmatch(statementLineId: string) {
    const data = await call(
      'DELETE',
      `/api/banking/reconciliations/${reconciliation.id}/matches?statementLineId=${statementLineId}`,
    )
    if (!data) return
    toast.success(t('unmatchedToast'))
    router.refresh()
  }

  async function signOff() {
    const ok = await confirmDialog({
      message: t('signOffConfirm'),
    })
    if (!ok) return
    setSignOffError(null)
    setBlockers(null)
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/sign-off`, undefined, (message) => {
      setSignOffError(message)
      toast.error(message)
    })
    if (!data) {
      // List the lines the refusal counts, with dates, amounts and links —
      // a bare "N line(s) remain unmatched" names no actionable row.
      await loadBlockers()
      return
    }
    toast.success(t('signedOffToast', { count: data.journalLinesReconciled ?? 0 }))
    router.refresh()
  }

  async function excludeStatementLine(id: string) {
    const reason = await promptDialog({
      title: tMatch('excludeReasonTitle'),
      label: tMatch('excludeReasonLabel'),
      placeholder: tMatch('excludeReasonPlaceholder'),
      confirmLabel: tMatch('exclude'),
    })
    if (!reason) return
    const data = await call('PATCH', `/api/banking/statement-lines/${id}`, { action: 'exclude', reason })
    if (!data) return
    toast.success(tMatch('excludedToast'))
    router.refresh()
  }

  async function discard() {
    const ok = await confirmDialog({
      message: t('discardConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    const data = await call('DELETE', `/api/banking/reconciliations/${reconciliation.id}`)
    if (!data) return
    toast.success(t('discardedToast'))
    router.push((accountPath))
    router.refresh()
  }

  async function saveAdjust() {
    const data = await call('PATCH', `/api/banking/reconciliations/${reconciliation.id}`, {
      throughDate,
      statementBalance,
    })
    if (!data) return
    toast.success(t('updatedToast'))
    setAdjustOpen(false)
    router.refresh()
  }

  const paneTitle = 'text-sm font-semibold text-slate-900 dark:text-slate-100'

  return (
    <div className="space-y-6">
      {signedOff ? (
        <Alert variant="success">{t('signedOffAlert')}</Alert>
      ) : (
        canReconcile && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={busy} onClick={runAutoMatch}>
              <Wand2 size={15} /> {t('autoMatch')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setAdjustOpen(true)}>
              <Pencil size={15} /> {t('adjust')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={discard} className="text-red-600 dark:text-red-400">
              <Trash2 size={15} /> {t('discardSession')}
            </Button>
            <span className="flex-1" />
            {selectedStmts.size > 0 || selectedGl.size > 0 ? (
              <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                {t('selectionSummary', { bank: money(stmtSelectionSum), gl: money(glSelectionSum) })}
              </span>
            ) : null}
            <Button disabled={busy || selectedStmts.size === 0 || selectedGl.size === 0} onClick={matchSelected}>
              <Link2 size={15} /> {t('matchSelected')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || selectedStmts.size > 0 || selectedGl.size === 0}
              onClick={clearSelected}
              title={t('clearSelectedTitle')}
            >
              {t('clearSelected')}
            </Button>
            <Button disabled={busy || !zero} onClick={signOff} title={zero ? undefined : t('signOffDisabledTitle')}>
              <CheckCheck size={15} /> {t('signOff')}
            </Button>
          </div>
        )
      )}

      {signOffError ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{signOffError}</p>
          {blockers && blockers.lines.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium">{t('blockingLines')}</p>
              <ul className="list-disc pl-5">
                {blockers.lines.map((line) => (
                  <li key={line.id}>
                    <a className="underline" href={`#stmt-line-${line.id}`}>
                      {blockerPostedOn(line)} · {money(line.amount)} · {line.description ?? '—'}
                    </a>
                  </li>
                ))}
              </ul>
              {blockers.total > blockers.lines.length ? (
                <p>{t('moreBlockingLines', { shown: blockers.lines.length, total: blockers.total })}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        {/* -------- left: unmatched statement lines -------- */}
        {/* Outstanding evidence renders for signed-off sessions too,
            read-only: a signed-off difference of zero must still show the
            book entries with no bank line, or state there are none. */}
          <section className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={cn(paneTitle, 'mr-auto')}>
                {t('bankLinesTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{t('bankLinesCount', { count: stmtTotal })}</span>
              </h2>
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{t('outstandingTotal', { total: money(stmtOutstandingTotal) })}</span>
              <SearchInput placeholder={t('searchBankLines')} paramKey="stmtQ" pageParamKey="stmtPage" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHead className="w-8" /> : null}
                  <SortTh basePath={basePath} currentParams={currentParams} column="date" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{tCommon('labels.date')}</SortTh>
                  <SortTh basePath={basePath} currentParams={currentParams} column="description" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{tCommon('labels.description')}</SortTh>
                  <SortTh basePath={basePath} currentParams={currentParams} column="amount" sort={stmtParams.sort} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage" align="right">{tCommon('labels.amount')}</SortTh>
                  {!readOnly ? <TableHead><span className="sr-only">{tMatch('exclude')}</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {stmtRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={readOnly ? 3 : 5} className="text-center text-slate-500 dark:text-slate-400">
                      {stmtParams.q ? t('noBankLinesSearch') : t('allBankLinesMatched')}
                    </TableCell>
                  </TableRow>
                ) : (
                  stmtRows.map((l) => {
                    const selected = selectedStmts.has(l.id)
                    const toggleStmt = () => setSelectedStmts((current) => {
                      const next = new Set(current)
                      if (next.has(l.id)) next.delete(l.id); else next.add(l.id)
                      return next
                    })
                    return (
                      <InteractiveTableRow
                        key={l.id}
                        id={`stmt-line-${l.id}`}
                        aria-label={t('selectBankLineAria', { date: l.posted_on, amount: money(l.amount) })}
                        className={cn(!readOnly && 'cursor-pointer', selected && selectedRow, 'scroll-mt-24')}
                        onClick={readOnly ? undefined : toggleStmt}
                      >
                        {!readOnly ? (
                          <TableCell className="w-8">
                            <input
                              type="checkbox"
                              aria-label={t('selectBankLineAria', { date: l.posted_on, amount: money(l.amount) })}
                              checked={selected}
                              onChange={toggleStmt}
                              onClick={(e) => e.stopPropagation()}
                              className="accent-teal-700"
                            />
                          </TableCell>
                        ) : null}
                        <TableCell className="whitespace-nowrap">{l.posted_on}</TableCell>
                        <TableCell className="max-w-[16rem] truncate">
                          {l.description ?? '—'}
                          {l.counterparty_ref ? (
                            <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">{l.counterparty_ref}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                        {!readOnly ? (
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="sm" disabled={busy} title={tMatch('exclude')} onClick={() => excludeStatementLine(l.id)}>
                              <Ban size={14} />
                            </Button>
                          </TableCell>
                        ) : null}
                      </InteractiveTableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
            <Pagination basePath={basePath} currentParams={currentParams} total={stmtTotal} page={stmtParams.page} perPage={stmtParams.perPage} pageParamKey="stmtPage" />
          </section>

          {/* -------- right: unreconciled GL lines -------- */}
          <section className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={cn(paneTitle, 'mr-auto')}>
                {t('ledgerLinesTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{t('ledgerLinesCount', { count: glTotal })}</span>
              </h2>
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{t('outstandingTotal', { total: money(glOutstandingTotal) })}</span>
              <SearchInput placeholder={t('searchGlLines')} paramKey="glQ" pageParamKey="glPage" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHead className="w-8" /> : null}
                  <SortTh basePath={basePath} currentParams={currentParams} column="date" sort={glParams.sort} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage">{tCommon('labels.date')}</SortTh>
                  <SortTh basePath={basePath} currentParams={currentParams} column="entry" sort={glParams.sort} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage">{tBanking('labels.entry')}</SortTh>
                  <TableHead>{tCommon('labels.memo')}</TableHead>
                  <SortTh basePath={basePath} currentParams={currentParams} column="amount" sort={glParams.sort} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage" align="right">{tCommon('labels.amount')}</SortTh>
                </TableRow>
              </TableHeader>
              <TableBody>
                {glRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={readOnly ? 4 : 5} className="text-center text-slate-500 dark:text-slate-400">
                      {glParams.q ? t('noGlLinesSearch') : t('allGlLinesReconciled')}
                    </TableCell>
                  </TableRow>
                ) : (
                  glRows.map((l) => {
                    const selected = selectedGl.has(l.id)
                    const toggle = () =>
                      setSelectedGl((prev) => {
                        const next = new Set(prev)
                        if (next.has(l.id)) next.delete(l.id)
                        else next.add(l.id)
                        return next
                      })
                    return (
                      <InteractiveTableRow
                        key={l.id}
                        aria-label={t('selectGlLineAria', { entry: l.entry_number, amount: money(l.amount) })}
                        className={cn(!readOnly && 'cursor-pointer', selected && selectedRow)}
                        onClick={readOnly ? undefined : toggle}
                      >
                        {!readOnly ? (
                          <TableCell className="w-8">
                            <input
                              type="checkbox"
                              aria-label={t('selectGlLineAria', { entry: l.entry_number, amount: money(l.amount) })}
                              checked={selected}
                              onChange={toggle}
                              onClick={(e) => e.stopPropagation()}
                              className="accent-teal-700"
                            />
                          </TableCell>
                        ) : null}
                        <TableCell className="whitespace-nowrap">{l.posting_date}</TableCell>
                        <TableCell className="font-mono text-[13px]">{l.entry_number}</TableCell>
                        <TableCell className="max-w-[14rem] truncate">
                          {l.memo ?? l.party ?? '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                      </InteractiveTableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
            <Pagination basePath={basePath} currentParams={currentParams} total={glTotal} page={glParams.page} perPage={glParams.perPage} pageParamKey="glPage" />
          </section>
        </div>

      {/* -------- matched this session -------- */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={cn(paneTitle, 'mr-auto')}>
            {t('matchedTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{t('matchedCount', { count: matchedTotal })}</span>
          </h2>
          <SearchInput placeholder={t('searchMatches')} paramKey="mQ" pageParamKey="mPage" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <SortTh basePath={basePath} currentParams={currentParams} column="date" sort={mParams.sort} dir={mParams.dir} sortParamKey="mSort" dirParamKey="mDir" pageParamKey="mPage">{t('columns.bankDate')}</SortTh>
              <TableHead>{t('columns.bankDescription')}</TableHead>
              <TableHead className="text-right">{t('columns.bankAmount')}</TableHead>
              <TableHead>{tBanking('labels.entry')}</TableHead>
              <TableHead>{t('columns.glMemo')}</TableHead>
              <TableHead className="text-right">{t('columns.glAmount')}</TableHead>
              <SortTh basePath={basePath} currentParams={currentParams} column="by" sort={mParams.sort} dir={mParams.dir} sortParamKey="mSort" dirParamKey="mDir" pageParamKey="mPage">{t('columns.matchedBy')}</SortTh>
              {!readOnly ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matchedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={readOnly ? 7 : 8} className="text-center text-slate-500 dark:text-slate-400">
                  {mParams.q ? t('noMatchesSearch') : t('noMatchesYet')}
                </TableCell>
              </TableRow>
            ) : (
              matchedRows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap">{m.stmt_date}</TableCell>
                  <TableCell className="max-w-[14rem] truncate">{m.stmt_description ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.stmt_amount)}</TableCell>
                  <TableCell className="font-mono text-[13px]">{m.entry_number}</TableCell>
                  <TableCell className="max-w-[14rem] truncate">{m.gl_memo ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.gl_amount)}</TableCell>
                  <TableCell>
                    <Badge variant={m.matched_by === 'auto' ? 'default' : 'secondary'}>
                      {MATCHED_BY_KEYS.includes(m.matched_by) ? tBanking(`matchedBy.${m.matched_by}`) : m.matched_by}
                      {m.confidence ? ` · ${Number(m.confidence).toFixed(1)}` : ''}
                    </Badge>
                  </TableCell>
                  {!readOnly ? (
                    <TableCell>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => unmatch(m.statement_line_id)}>
                        {t('unmatch')}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <Pagination basePath={basePath} currentParams={currentParams} total={matchedTotal} page={mParams.page} perPage={mParams.perPage} pageParamKey="mPage" />
      </section>

      {/* -------- GL-only clearing groups (no bank counterpart) -------- */}
      {glClearings.length > 0 ? (
        <section className="space-y-2">
          <h2 className={cn(paneTitle, 'mr-auto')}>
            {t('clearingsTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{t('clearingsCount', { count: glClearings.length })}</span>
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tBanking('labels.entry')}</TableHead>
                <TableHead className="text-right">{tCommon('labels.lines')}</TableHead>
                <TableHead className="text-right">{tCommon('labels.amount')}</TableHead>
                {!readOnly ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {glClearings.map((g) => (
                <TableRow key={g.group_id}>
                  <TableCell className="font-mono text-[13px]">{g.entries ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.lines}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(g.total)}</TableCell>
                  {!readOnly ? (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => unmatchClearing(g.group_id)}>
                        {t('unmatch')}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {/* -------- adjust drawer -------- */}
      <Drawer
        open={adjustOpen}
        onClose={adjustCloseGuard.close}
        size="sm"
        title={t('adjustTitle')}
        description={t('adjustDescription')}
        headerActions={
          <>
            <Button variant="outline" disabled={busy} onClick={adjustCloseGuard.close}>
              {tCommon('actions.cancel')}
            </Button>
            <Button disabled={busy || !throughDate || canonicalDecimal(statementBalance, 4) === null} onClick={saveAdjust}>
              {tCommon('actions.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={adjustThroughDateId}>{tBanking('labels.reconcileThrough')}</Label>
            <Input id={adjustThroughDateId} type="date" disabled={busy} value={throughDate} onChange={(e) => setThroughDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={adjustStatementBalanceId}>{tBanking('labels.statementBalance')}</Label>
            <Input
              id={adjustStatementBalanceId}
              disabled={busy}
              inputMode="decimal"
              value={statementBalance}
              onChange={(e) => setStatementBalance(e.target.value)}
              className="text-right tabular-nums"
            />
          </div>
        </div>
      </Drawer>
    </div>
  )
}
