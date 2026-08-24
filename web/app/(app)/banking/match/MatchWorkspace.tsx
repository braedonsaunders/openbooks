'use client'

import { useMoney } from '@/components/money-provider'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Ban, CheckCheck, FilePlus2, Link2, RotateCcw, Sparkles, Wand2, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge, Button, Drawer, EmptyState, Label, SearchSelect, Select, Table, TableBody,
  TableCell, TableHead, TableHeader, TableRow, cn,
} from '@openbooks/ui'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { compareDecimal } from '../../../../lib/exact-decimal'
import { confirmDialog } from '../../../../lib/confirm'
import { promptDialog } from '../../../../lib/prompt'
type Search = Record<string, string | string[] | undefined>
type Opt = { id: string; label: string; unmatched?: number };
interface Account { id: string; label: string }
interface Session { id: string; throughDate: string; statementBalance: string }
interface ListParams {
  q?: string
  page: number
  perPage: number
}
export interface StatementRow extends Record<string, unknown> {
  id: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref?: string | null
}
export interface GlRow extends Record<string, unknown> {
  id: string
  posting_date: string
  entry_number: string
  amount: string
  memo: string | null
  party: string | null
}
export interface ReviewRow extends Record<string, unknown> {
  id: string
  statement_line_id: string
  confidence: string | number
  stmt_date: string
  stmt_amount: string
  stmt_description: string | null
  entry_number: string
}
interface MatchData {
  stmtRows: StatementRow[]
  stmtTotal: number
  stmtParams: ListParams
  glRows: GlRow[]
  glTotal: number
  glParams: ListParams
  reviewRows: ReviewRow[]
  excludedRows: StatementRow[]
  excludedTotal: number
  exParams: ListParams
}
interface MatchTotals {
  statementBalance: string
  clearedBalance: string
  difference: string
}
interface MatchActionResult {
  error?: string
  matched?: number
  highConfidence?: number
  mediumConfidence?: number
  excluded?: number
  scanned?: number
  journalLinesReconciled?: number
}

const selectedRow = 'bg-teal-50 dark:bg-teal-950/40'

export function MatchWorkspace({
  accounts, offsetAccounts, account, session, data, totals, currentParams, tab,
}: {
  accounts: Opt[]
  offsetAccounts: Opt[]
  account: Account | null
  session: Session | null
  data: MatchData | null
  totals: MatchTotals | null
  currentParams: Search
  tab: 'match' | 'review' | 'excluded'
}) {
  const { money } = useMoney()
  const t = useTranslations('banking.match')
  const tW = useTranslations('banking.workspace')
  const tCommon = useTranslations('common')
  const tBanking = useTranslations('banking')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [selectedStmt, setSelectedStmt] = useState<string | null>(null)
  const [selectedGl, setSelectedGl] = useState<Set<string>>(new Set())
  const [addLine, setAddLine] = useState<{ id: string; label: string } | null>(null)
  const [offsetId, setOffsetId] = useState('')
  // Suggest-mode rule proposals for the current account's unmatched lines,
  // keyed by statement line id. Computed live via the rules preview (no post).
  const [suggestions, setSuggestions] = useState<Map<string, { ruleId: string; ruleName: string }>>(new Map())

  useEffect(() => {
    if (!account || !session) {
      setSuggestions(new Map())
      return
    }
    const controller = new AbortController()
    fetch('/api/banking/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, onlyUnmatched: true, limit: 200 }),
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.matches) return
        const next = new Map<string, { ruleId: string; ruleName: string }>()
        for (const m of d.matches) {
          if (m.action === 'categorize' && m.ruleMode === 'suggest' && m.ruleId) {
            next.set(m.lineId, { ruleId: m.ruleId, ruleName: m.ruleName ?? '' })
          }
        }
        setSuggestions(next)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [account?.id, session?.id, data])

  async function confirmSuggestion(lineId: string, ruleId: string) {
    if (!session) return
    const d = await call('POST', '/api/banking/rules/apply-line', {
      statementLineId: lineId,
      ruleId,
      reconciliationId: session.id,
    })
    if (!d) return
    toast.success(tW('matchedToast'))
    router.refresh()
  }

  const glSelectionSum = useMemo(
    () => (data?.glRows ?? []).filter((r) => selectedGl.has(r.id)).reduce((a, r) => a + Number(r.amount), 0),
    [data, selectedGl],
  )

  async function call(method: string, url: string, body?: unknown): Promise<MatchActionResult | null> {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const d = await res.json() as MatchActionResult
      if (!res.ok) { toast.error(d.error ?? tBanking('errors.requestFailed')); return null }
      return d
    } finally { setBusy(false) }
  }

  function pickAccount(id: string) {
    router.push(((id ? `/banking/match?account=${id}` : '/banking/match')))
  }

  async function startMatching() {
    if (!account) return
    const d = await call('POST', '/api/banking/reconciliations/ensure', { accountId: account.id })
    if (!d) return
    router.refresh()
  }

  async function autoMatch() {
    if (!session) return
    const d = await call('POST', `/api/banking/reconciliations/${session.id}/auto-match`)
    if (!d) return
    d.matched === 0 ? toast.info(tW('noAutoMatches')) : toast.success(tW('autoMatchedToast', { count: d.matched ?? 0, high: d.highConfidence ?? 0, medium: d.mediumConfidence ?? 0 }))
    router.refresh()
  }

  async function runRules() {
    if (!account) return
    const d = await call('POST', '/api/banking/rules/apply', { accountId: account.id })
    if (!d) return
    d.matched === 0 && d.excluded === 0
      ? toast.info(tBanking('rules.runNoneMatched', { scanned: d.scanned ?? 0 }))
      : toast.success(tBanking('rules.runDone', { matched: d.matched ?? 0, excluded: d.excluded ?? 0 }))
    router.refresh()
  }

  async function matchSelected() {
    if (!session || !selectedStmt || selectedGl.size === 0) return
    const d = await call('POST', `/api/banking/reconciliations/${session.id}/matches`, { statementLineId: selectedStmt, journalLineIds: [...selectedGl] })
    if (!d) return
    toast.success(tW('matchedToast')); setSelectedStmt(null); setSelectedGl(new Set()); router.refresh()
  }

  async function exclude(id: string) {
    const reason = await promptDialog({
      title: t('excludeReasonTitle'),
      label: t('excludeReasonLabel'),
      placeholder: t('excludeReasonPlaceholder'),
      confirmLabel: t('exclude'),
    })
    if (!reason) return
    const d = await call('PATCH', `/api/banking/statement-lines/${id}`, { action: 'exclude', reason })
    if (!d) return
    toast.success(t('excludedToast')); if (selectedStmt === id) setSelectedStmt(null); router.refresh()
  }
  async function restore(id: string) {
    const d = await call('PATCH', `/api/banking/statement-lines/${id}`, { action: 'restore' })
    if (!d) return
    toast.success(t('restoredToast')); router.refresh()
  }
  async function unmatch(statementLineId: string) {
    if (!session) return
    const d = await call('DELETE', `/api/banking/reconciliations/${session.id}/matches?statementLineId=${statementLineId}`)
    if (!d) return
    toast.success(tW('unmatchedToast')); router.refresh()
  }

  async function confirmAddJournal() {
    if (!session || !addLine || !offsetId) return
    const d = await call('POST', `/api/banking/statement-lines/${addLine.id}/create-match`, { reconciliationId: session.id, offsetAccountId: offsetId })
    if (!d) return
    toast.success(t('addedToast')); setAddLine(null); setOffsetId(''); router.refresh()
  }

  async function signOff() {
    if (!session) return
    const ok = await confirmDialog({ message: tW('signOffConfirm') })
    if (!ok) return
    const d = await call('POST', `/api/banking/reconciliations/${session.id}/sign-off`)
    if (!d) return
    toast.success(tW('signedOffToast', { count: d.journalLinesReconciled ?? 0 })); router.refresh()
  }

  const zero = totals ? compareDecimal(String(totals.difference ?? '0'), '0') === 0 : false

  // ---- account picker (always shown) --------------------------------------
  const picker = (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="text-sm">{t('accountLabel')}</Label>
      <div className="min-w-[18rem]">
        <SearchSelect
          options={accounts.map((a) => ({ value: a.id, label: a.unmatched ? `${a.label}  ·  ${t('unmatchedCount', { count: a.unmatched })}` : a.label }))}
          value={account?.id ?? ''}
          onChange={(v) => pickAccount(v ?? '')}
          placeholder={t('selectAccount')}
        />
      </div>
    </div>
  )

  if (!account) {
    return (
      <div className="space-y-4">
        {picker}
        <EmptyState title={t('pickTitle')} description={t('pickDescription')} />
      </div>
    )
  }

  if (!session || !data || !totals) {
    return (
      <div className="space-y-4">
        {picker}
        <EmptyState
          title={t('noSessionTitle')}
          description={t('noSessionDescription')}
          action={<Button disabled={busy} onClick={startMatching}><Wand2 size={15} /> {t('startMatching')}</Button>}
        />
      </div>
    )
  }

  const tabHref = (tb: string) => {
    const p = new URLSearchParams()
    p.set('account', account.id)
    if (tb !== 'match') p.set('tab', tb)
    return `/banking/match?${p.toString()}`
  }
  const tabBtn = (tb: 'match' | 'review' | 'excluded', label: string, count?: number) => (
    <Link
      href={(tabHref(tb))}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        tab === tb ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
      )}
    >
      {label}{typeof count === 'number' ? <span className="ml-1.5 text-xs text-slate-400">{count}</span> : null}
    </Link>
  )

  const stat = 'rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900'
  const statLabel = 'text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400'

  return (
    <div className="space-y-4">
      {picker}

      {/* stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className={stat}><div className={statLabel}>{tBanking('labels.statementBalance')}</div><div className="text-sm font-semibold tabular-nums">{money(totals.statementBalance)}</div></div>
        <div className={stat}><div className={statLabel}>{tBanking('reconcile.stats.clearedGlBalance')}</div><div className="text-sm font-semibold tabular-nums">{money(totals.clearedBalance)}</div></div>
        <div className={stat}><div className={statLabel}>{tBanking('reconcile.stats.difference')}</div><div className={cn('text-sm font-semibold tabular-nums', zero ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')}>{money(totals.difference)}</div></div>
        <div className={stat}><div className={statLabel}>{t('throughDate')}</div><div className="text-sm font-semibold">{session.throughDate}</div></div>
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={busy} onClick={autoMatch}><Wand2 size={15} /> {tW('autoMatch')}</Button>
        <Button variant="outline" disabled={busy} onClick={runRules}><Workflow size={15} /> {tBanking('rules.runRules')}</Button>
        <span className="flex-1" />
        {selectedStmt ? <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">{tW('selectionSummary', { bank: money((data.stmtRows.find((r) => r.id === selectedStmt)?.amount) ?? 0), gl: money(glSelectionSum) })}</span> : null}
        <Button disabled={busy || !selectedStmt || selectedGl.size === 0} onClick={matchSelected}><Link2 size={15} /> {tW('matchSelected')}</Button>
        <Button disabled={busy || !zero} onClick={signOff} title={zero ? undefined : tW('signOffDisabledTitle')}><CheckCheck size={15} /> {tW('signOff')}</Button>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 pb-2 dark:border-slate-800">
        {tabBtn('match', t('tabs.toMatch'), data.stmtTotal)}
        {tabBtn('review', t('tabs.review'), data.reviewRows.length)}
        {tabBtn('excluded', t('tabs.excluded'), data.excludedTotal)}
      </div>

      {tab === 'match' ? (
        <div className="grid gap-6 xl:grid-cols-2">
          {/* left: unmatched statement lines */}
          <section className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100">{tW('bankLinesTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{tW('bankLinesCount', { count: data.stmtTotal })}</span></h2>
              <SearchInput placeholder={tW('searchBankLines')} paramKey="stmtQ" pageParamKey="stmtPage" />
            </div>
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-8" />
                <TableHead>{tCommon('labels.date')}</TableHead>
                <TableHead>{tCommon('labels.description')}</TableHead>
                <TableHead className="text-right">{tCommon('labels.amount')}</TableHead>
                <TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {data.stmtRows.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-slate-500 dark:text-slate-400">{data.stmtParams.q ? tW('noBankLinesSearch') : tW('allBankLinesMatched')}</TableCell></TableRow>
                ) : data.stmtRows.map((l) => {
                  const sel = selectedStmt === l.id
                  return (
                    <TableRow key={l.id} className={cn('cursor-pointer', sel && selectedRow)} onClick={() => setSelectedStmt(sel ? null : l.id)}>
                      <TableCell className="w-8"><input type="radio" name="stmt" checked={sel} onChange={() => setSelectedStmt(sel ? null : l.id)} onClick={(e) => e.stopPropagation()} className="accent-teal-700" aria-label={tW('selectBankLineAria', { date: l.posted_on, amount: money(l.amount) })} /></TableCell>
                      <TableCell className="whitespace-nowrap">{l.posted_on}</TableCell>
                      <TableCell className="max-w-[14rem]">
                        <div className="truncate">{l.description ?? '—'}{l.counterparty_ref ? <span className="ml-1.5 text-xs text-slate-400">{l.counterparty_ref}</span> : null}</div>
                        {suggestions.has(l.id) ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); confirmSuggestion(l.id, suggestions.get(l.id)!.ruleId) }}
                            disabled={busy}
                            className="mt-1 inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700 transition-colors hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:bg-teal-900/40"
                            title={t('postAndMatch')}
                          >
                            <Sparkles size={11} /> {t('suggestedBy', { rule: suggestions.get(l.id)!.ruleName })}
                          </button>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          {suggestions.has(l.id) ? (
                            <Button variant="ghost" size="sm" disabled={busy} title={t('postAndMatch')} onClick={() => confirmSuggestion(l.id, suggestions.get(l.id)!.ruleId)}><Link2 size={14} /></Button>
                          ) : null}
                          <Button variant="ghost" size="sm" disabled={busy} title={t('createRule')} onClick={() => router.push((`/banking/rules?rule=new&fromLine=${l.id}`))}><Workflow size={14} /></Button>
                          <Button variant="ghost" size="sm" disabled={busy} title={t('addJournal')} onClick={() => { setAddLine({ id: l.id, label: `${l.posted_on} · ${money(l.amount)}` }); setOffsetId('') }}><FilePlus2 size={14} /></Button>
                          <Button variant="ghost" size="sm" disabled={busy} title={t('exclude')} onClick={() => exclude(l.id)}><Ban size={14} /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <Pagination basePath="/banking/match" currentParams={currentParams} total={data.stmtTotal} page={data.stmtParams.page} perPage={data.stmtParams.perPage} pageParamKey="stmtPage" />
          </section>

          {/* right: available GL lines */}
          <section className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100">{tW('ledgerLinesTitle')} <span className="font-normal text-slate-500 dark:text-slate-400">{tW('ledgerLinesCount', { count: data.glTotal })}</span></h2>
              <SearchInput placeholder={tW('searchGlLines')} paramKey="glQ" pageParamKey="glPage" />
            </div>
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-8" />
                <TableHead>{tCommon('labels.date')}</TableHead>
                <TableHead>{tBanking('labels.entry')}</TableHead>
                <TableHead>{tCommon('labels.memo')}</TableHead>
                <TableHead className="text-right">{tCommon('labels.amount')}</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.glRows.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-slate-500 dark:text-slate-400">{data.glParams.q ? tW('noGlLinesSearch') : tW('allGlLinesReconciled')}</TableCell></TableRow>
                ) : data.glRows.map((l) => {
                  const sel = selectedGl.has(l.id)
                  const toggle = () => setSelectedGl((p) => { const n = new Set(p); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })
                  return (
                    <TableRow key={l.id} className={cn('cursor-pointer', sel && selectedRow)} onClick={toggle}>
                      <TableCell className="w-8"><input type="checkbox" checked={sel} onChange={toggle} onClick={(e) => e.stopPropagation()} className="accent-teal-700" aria-label={tW('selectGlLineAria', { entry: l.entry_number, amount: money(l.amount) })} /></TableCell>
                      <TableCell className="whitespace-nowrap">{l.posting_date}</TableCell>
                      <TableCell className="font-mono text-[13px]">{l.entry_number}</TableCell>
                      <TableCell className="max-w-[12rem] truncate">{l.memo ?? l.party ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <Pagination basePath="/banking/match" currentParams={currentParams} total={data.glTotal} page={data.glParams.page} perPage={data.glParams.perPage} pageParamKey="glPage" />
          </section>
        </div>
      ) : null}

      {tab === 'review' ? (
        <section className="space-y-2">
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('reviewHint')}</p>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('columns.bankDate')}</TableHead>
              <TableHead>{tCommon('labels.description')}</TableHead>
              <TableHead className="text-right">{tCommon('labels.amount')}</TableHead>
              <TableHead>{tBanking('labels.entry')}</TableHead>
              <TableHead className="text-right">{t('columns.confidence')}</TableHead>
              <TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {data.reviewRows.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-slate-500 dark:text-slate-400">{t('noReview')}</TableCell></TableRow>
              ) : data.reviewRows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap">{m.stmt_date}</TableCell>
                  <TableCell className="max-w-[14rem] truncate">{m.stmt_description ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.stmt_amount)}</TableCell>
                  <TableCell className="font-mono text-[13px]">{m.entry_number}</TableCell>
                  <TableCell className="text-right"><Badge variant="warning">{Number(m.confidence).toFixed(1)}</Badge></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="sm" disabled={busy} onClick={() => unmatch(m.statement_line_id)}>{tW('unmatch')}</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {tab === 'excluded' ? (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm text-slate-500 dark:text-slate-400">{t('excludedHint')}</p>
            <SearchInput placeholder={t('searchExcluded')} paramKey="exQ" pageParamKey="exPage" />
          </div>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tCommon('labels.date')}</TableHead>
              <TableHead>{tCommon('labels.description')}</TableHead>
              <TableHead className="text-right">{tCommon('labels.amount')}</TableHead>
              <TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {data.excludedRows.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center text-slate-500 dark:text-slate-400">{t('noExcluded')}</TableCell></TableRow>
              ) : data.excludedRows.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap">{l.posted_on}</TableCell>
                  <TableCell className="max-w-[18rem] truncate">{l.description ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.amount)}</TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="sm" disabled={busy} onClick={() => restore(l.id)}><RotateCcw size={14} /> {t('restore')}</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination basePath="/banking/match" currentParams={currentParams} total={data.excludedTotal} page={data.exParams.page} perPage={data.exParams.perPage} pageParamKey="exPage" />
        </section>
      ) : null}

      {/* add-journal drawer */}
      <Drawer open={!!addLine} onClose={() => setAddLine(null)} size="sm" title={t('addJournalTitle')} description={addLine?.label}
        headerActions={<>
          <Button variant="outline" onClick={() => setAddLine(null)}>{tCommon('actions.cancel')}</Button>
          <Button disabled={busy || !offsetId} onClick={confirmAddJournal}>{busy ? tCommon('actions.saving') : t('addJournal')}</Button>
        </>}>
        <div className="space-y-1.5 p-1">
          <Label>{t('offsetAccount')}</Label>
          <SearchSelect options={offsetAccounts.map((a) => ({ value: a.id, label: a.label }))} value={offsetId} onChange={(v) => setOffsetId(v ?? '')} placeholder={tBanking('drawer.accountPlaceholder')} />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('addJournalHint')}</p>
        </div>
      </Drawer>
    </div>
  )
}
