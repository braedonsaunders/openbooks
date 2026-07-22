'use client'

import { useMoney } from '@/components/money-provider'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CheckCheck, Link2, Pencil, Trash2, Wand2 } from 'lucide-react'
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
import { SortableTh } from '../../../../../../components/sortable-th'
import { confirmDialog } from '../../../../../../lib/confirm'
import { isZeroAmount } from './DifferenceBadge'

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

const selectedRow = 'bg-teal-50 dark:bg-teal-950/40'

// Known matched_by enum values — unknown values render verbatim.
const MATCHED_BY_KEYS = ['auto', 'manual', 'rule']

/**
 * Two-pane matching workspace: unmatched bank statement lines (left) against
 * unreconciled posted GL lines (right). Click a bank line, tick 1..n GL lines,
 * Match. Sign-off unlocks only at a 0.00 difference.
 */
export function ReconcileWorkspace({
  basePath,
  accountPath,
  currentParams,
  reconciliation,
  difference,
  canReconcile,
  stmtRows,
  stmtTotal,
  stmtParams,
  glRows,
  glTotal,
  glParams,
  matchedRows,
  matchedTotal,
  mParams,
}: {
  basePath: string
  accountPath: string
  currentParams: Search
  reconciliation: { id: string; status: string; throughDate: string; statementBalance: string }
  difference: string
  canReconcile: boolean
  stmtRows: StmtRow[]
  stmtTotal: number
  stmtParams: PaneParams
  glRows: GlRow[]
  glTotal: number
  glParams: PaneParams
  matchedRows: MatchedRow[]
  matchedTotal: number
  mParams: PaneParams
}) {
  const { money } = useMoney()
  const t = useTranslations('banking.workspace')
  const tBanking = useTranslations('banking')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [selectedStmt, setSelectedStmt] = useState<string | null>(null)
  const [selectedGl, setSelectedGl] = useState<Set<string>>(new Set())
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [throughDate, setThroughDate] = useState(reconciliation.throughDate)
  const [statementBalance, setStatementBalance] = useState(() =>
    Number(reconciliation.statementBalance).toFixed(2),
  )

  const signedOff = reconciliation.status === 'signed_off'
  const zero = isZeroAmount(difference)
  const readOnly = signedOff || !canReconcile

  const stmtSelection = useMemo(() => stmtRows.find((r) => r.id === selectedStmt) ?? null, [stmtRows, selectedStmt])
  const glSelectionSum = useMemo(
    () => glRows.filter((r) => selectedGl.has(r.id)).reduce((a, r) => a + Number(r.amount), 0),
    [glRows, selectedGl],
  )

  async function call(method: string, url: string, body?: unknown): Promise<any | null> {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? tBanking('errors.requestFailed'))
        return null
      }
      return data
    } finally {
      setBusy(false)
    }
  }

  async function runAutoMatch() {
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/auto-match`)
    if (!data) return
    if (data.matched === 0) toast.info(t('noAutoMatches'))
    else
      toast.success(
        t('autoMatchedToast', {
          count: data.matched,
          high: data.highConfidence,
          medium: data.mediumConfidence,
        }),
      )
    router.refresh()
  }

  async function matchSelected() {
    if (!selectedStmt || selectedGl.size === 0) return
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/matches`, {
      statementLineId: selectedStmt,
      journalLineIds: [...selectedGl],
    })
    if (!data) return
    toast.success(t('matchedToast'))
    setSelectedStmt(null)
    setSelectedGl(new Set())
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
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/sign-off`)
    if (!data) return
    toast.success(t('signedOffToast', { count: data.journalLinesReconciled }))
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
    router.push(accountPath as any)
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
            {selectedStmt ? (
              <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                {t('selectionSummary', { bank: money(stmtSelection?.amount ?? 0), gl: money(glSelectionSum) })}
              </span>
            ) : null}
            <Button disabled={busy || !selectedStmt || selectedGl.size === 0} onClick={matchSelected}>
              <Link2 size={15} /> {t('matchSelected')}
            </Button>
            <Button disabled={busy || !zero} onClick={signOff} title={zero ? undefined : t('signOffDisabledTitle')}>
              <CheckCheck size={15} /> {t('signOff')}
            </Button>
          </div>
        )
      )}

      {!signedOff ? (
        <div className="grid gap-6 xl:grid-cols-2">
          {/* -------- left: unmatched statement lines -------- */}
          <section className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={cn(paneTitle, 'mr-auto')}>
                {t('bankLinesTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{t('bankLinesCount', { count: stmtTotal })}</span>
              </h2>
              <SearchInput placeholder={t('searchBankLines')} paramKey="stmtQ" pageParamKey="stmtPage" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHead className="w-8" /> : null}
                  <SortableTh basePath={basePath} currentParams={currentParams} column="date" active={stmtParams.sort === 'date'} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{tCommon('labels.date')}</SortableTh>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="description" active={stmtParams.sort === 'description'} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">{tCommon('labels.description')}</SortableTh>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="amount" active={stmtParams.sort === 'amount'} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage" align="right">{tCommon('labels.amount')}</SortableTh>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stmtRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={readOnly ? 3 : 4} className="text-center text-slate-500 dark:text-slate-400">
                      {stmtParams.q ? t('noBankLinesSearch') : t('allBankLinesMatched')}
                    </TableCell>
                  </TableRow>
                ) : (
                  stmtRows.map((l) => {
                    const selected = selectedStmt === l.id
                    return (
                      <TableRow
                        key={l.id}
                        className={cn(!readOnly && 'cursor-pointer', selected && selectedRow)}
                        onClick={readOnly ? undefined : () => setSelectedStmt(selected ? null : l.id)}
                      >
                        {!readOnly ? (
                          <TableCell className="w-8">
                            <input
                              type="radio"
                              name="stmt-line"
                              aria-label={t('selectBankLineAria', { date: l.posted_on, amount: money(l.amount) })}
                              checked={selected}
                              onChange={() => setSelectedStmt(selected ? null : l.id)}
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
                      </TableRow>
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
              <SearchInput placeholder={t('searchGlLines')} paramKey="glQ" pageParamKey="glPage" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHead className="w-8" /> : null}
                  <SortableTh basePath={basePath} currentParams={currentParams} column="date" active={glParams.sort === 'date'} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage">{tCommon('labels.date')}</SortableTh>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="entry" active={glParams.sort === 'entry'} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage">{tBanking('labels.entry')}</SortableTh>
                  <TableHead>{tCommon('labels.memo')}</TableHead>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="amount" active={glParams.sort === 'amount'} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage" align="right">{tCommon('labels.amount')}</SortableTh>
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
                      <TableRow
                        key={l.id}
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
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
            <Pagination basePath={basePath} currentParams={currentParams} total={glTotal} page={glParams.page} perPage={glParams.perPage} pageParamKey="glPage" />
          </section>
        </div>
      ) : null}

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
              <SortableTh basePath={basePath} currentParams={currentParams} column="date" active={mParams.sort === 'date'} dir={mParams.dir} sortParamKey="mSort" dirParamKey="mDir" pageParamKey="mPage">{t('columns.bankDate')}</SortableTh>
              <TableHead>{t('columns.bankDescription')}</TableHead>
              <TableHead className="text-right">{t('columns.bankAmount')}</TableHead>
              <TableHead>{tBanking('labels.entry')}</TableHead>
              <TableHead>{t('columns.glMemo')}</TableHead>
              <TableHead className="text-right">{t('columns.glAmount')}</TableHead>
              <SortableTh basePath={basePath} currentParams={currentParams} column="by" active={mParams.sort === 'by'} dir={mParams.dir} sortParamKey="mSort" dirParamKey="mDir" pageParamKey="mPage">{t('columns.matchedBy')}</SortableTh>
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

      {/* -------- adjust drawer -------- */}
      <Drawer
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        size="sm"
        title={t('adjustTitle')}
        description={t('adjustDescription')}
        headerActions={
          <>
            <Button variant="outline" onClick={() => setAdjustOpen(false)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button disabled={busy || !throughDate || statementBalance.trim() === '' || Number.isNaN(Number(statementBalance))} onClick={saveAdjust}>
              {tCommon('actions.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{tBanking('labels.reconcileThrough')}</Label>
            <Input type="date" value={throughDate} onChange={(e) => setThroughDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{tBanking('labels.statementBalance')}</Label>
            <Input
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
