'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { money } from '../../../../../../lib/format'
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
        toast.error(data.error ?? 'Request failed')
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
    if (data.matched === 0) toast.info('No automatic matches found')
    else
      toast.success(
        `Auto-matched ${data.matched} line${data.matched === 1 ? '' : 's'} (${data.highConfidence} high, ${data.mediumConfidence} medium confidence)`,
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
    toast.success('Matched')
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
    toast.success('Unmatched')
    router.refresh()
  }

  async function signOff() {
    const ok = await confirmDialog({
      message:
        'Sign off this reconciliation? Matched journal lines are stamped as reconciled — this cannot be undone.',
    })
    if (!ok) return
    const data = await call('POST', `/api/banking/reconciliations/${reconciliation.id}/sign-off`)
    if (!data) return
    toast.success(`Signed off — ${data.journalLinesReconciled} journal line${data.journalLinesReconciled === 1 ? '' : 's'} reconciled`)
    router.refresh()
  }

  async function discard() {
    const ok = await confirmDialog({
      message: 'Discard this reconciliation session? Its matches are undone and statement lines released.',
      tone: 'danger',
    })
    if (!ok) return
    const data = await call('DELETE', `/api/banking/reconciliations/${reconciliation.id}`)
    if (!data) return
    toast.success('Reconciliation discarded')
    router.push(accountPath as any)
    router.refresh()
  }

  async function saveAdjust() {
    const data = await call('PATCH', `/api/banking/reconciliations/${reconciliation.id}`, {
      throughDate,
      statementBalance,
    })
    if (!data) return
    toast.success('Reconciliation updated')
    setAdjustOpen(false)
    router.refresh()
  }

  const paneTitle = 'text-sm font-semibold text-slate-900 dark:text-slate-100'

  return (
    <div className="space-y-6">
      {signedOff ? (
        <Alert variant="success">
          This reconciliation is signed off — the matched journal lines below are permanently stamped as reconciled.
        </Alert>
      ) : (
        canReconcile && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={busy} onClick={runAutoMatch}>
              <Wand2 size={15} /> Auto-match
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setAdjustOpen(true)}>
              <Pencil size={15} /> Adjust
            </Button>
            <Button variant="outline" disabled={busy} onClick={discard} className="text-red-600 dark:text-red-400">
              <Trash2 size={15} /> Discard session
            </Button>
            <span className="flex-1" />
            {selectedStmt ? (
              <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                Bank {money(stmtSelection?.amount ?? 0)} vs GL {money(glSelectionSum)} selected
              </span>
            ) : null}
            <Button disabled={busy || !selectedStmt || selectedGl.size === 0} onClick={matchSelected}>
              <Link2 size={15} /> Match selected
            </Button>
            <Button disabled={busy || !zero} onClick={signOff} title={zero ? undefined : 'Difference must be 0.00 to sign off'}>
              <CheckCheck size={15} /> Sign off
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
                Bank statement lines <span className="font-normal text-slate-500 dark:text-slate-400">({stmtTotal.toLocaleString()} unmatched)</span>
              </h2>
              <SearchInput placeholder="Search bank lines…" paramKey="stmtQ" pageParamKey="stmtPage" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHead className="w-8" /> : null}
                  <SortableTh basePath={basePath} currentParams={currentParams} column="date" active={stmtParams.sort === 'date'} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">Date</SortableTh>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="description" active={stmtParams.sort === 'description'} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage">Description</SortableTh>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="amount" active={stmtParams.sort === 'amount'} dir={stmtParams.dir} sortParamKey="stmtSort" dirParamKey="stmtDir" pageParamKey="stmtPage" align="right">Amount</SortableTh>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stmtRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={readOnly ? 3 : 4} className="text-center text-slate-500 dark:text-slate-400">
                      {stmtParams.q ? 'No bank lines match this search.' : 'Every statement line up to the cutoff is matched.'}
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
                              aria-label={`Select bank line of ${l.posted_on} for ${money(l.amount)}`}
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
                Ledger lines <span className="font-normal text-slate-500 dark:text-slate-400">({glTotal.toLocaleString()} unreconciled)</span>
              </h2>
              <SearchInput placeholder="Search GL lines…" paramKey="glQ" pageParamKey="glPage" />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {!readOnly ? <TableHead className="w-8" /> : null}
                  <SortableTh basePath={basePath} currentParams={currentParams} column="date" active={glParams.sort === 'date'} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage">Date</SortableTh>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="entry" active={glParams.sort === 'entry'} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage">Entry</SortableTh>
                  <TableHead>Memo</TableHead>
                  <SortableTh basePath={basePath} currentParams={currentParams} column="amount" active={glParams.sort === 'amount'} dir={glParams.dir} sortParamKey="glSort" dirParamKey="glDir" pageParamKey="glPage" align="right">Amount</SortableTh>
                </TableRow>
              </TableHeader>
              <TableBody>
                {glRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={readOnly ? 4 : 5} className="text-center text-slate-500 dark:text-slate-400">
                      {glParams.q ? 'No ledger lines match this search.' : 'Every posted line up to the cutoff is reconciled or matched.'}
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
                              aria-label={`Select ledger line ${l.entry_number} for ${money(l.amount)}`}
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
            Matched <span className="font-normal text-slate-500 dark:text-slate-400">({matchedTotal.toLocaleString()} pair{matchedTotal === 1 ? '' : 's'})</span>
          </h2>
          <SearchInput placeholder="Search matches…" paramKey="mQ" pageParamKey="mPage" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTh basePath={basePath} currentParams={currentParams} column="date" active={mParams.sort === 'date'} dir={mParams.dir} sortParamKey="mSort" dirParamKey="mDir" pageParamKey="mPage">Bank date</SortableTh>
              <TableHead>Bank description</TableHead>
              <TableHead className="text-right">Bank amount</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>GL memo</TableHead>
              <TableHead className="text-right">GL amount</TableHead>
              <SortableTh basePath={basePath} currentParams={currentParams} column="by" active={mParams.sort === 'by'} dir={mParams.dir} sortParamKey="mSort" dirParamKey="mDir" pageParamKey="mPage">Matched by</SortableTh>
              {!readOnly ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matchedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={readOnly ? 7 : 8} className="text-center text-slate-500 dark:text-slate-400">
                  {mParams.q ? 'No matches found for this search.' : 'Nothing matched yet — run Auto-match or pair lines manually above.'}
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
                      {m.matched_by}
                      {m.confidence ? ` · ${Number(m.confidence).toFixed(1)}` : ''}
                    </Badge>
                  </TableCell>
                  {!readOnly ? (
                    <TableCell>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => unmatch(m.statement_line_id)}>
                        Unmatch
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
        title="Adjust reconciliation"
        description="Change the cutoff date or the bank statement balance for this session."
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setAdjustOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !throughDate || statementBalance.trim() === '' || Number.isNaN(Number(statementBalance))} onClick={saveAdjust}>
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Reconcile through</Label>
            <Input type="date" value={throughDate} onChange={(e) => setThroughDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Statement balance</Label>
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
