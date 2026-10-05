'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DisclosureSection,
  Drawer,
  EmptyState,
  Input,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ListDrawerLink } from '../../../../components/list-drawer-link'
import { useMoney } from '../../../../components/money-provider'
import { confirmDialog } from '../../../../lib/confirm'
import type {
  PayoutBatchRow,
  PayoutQueueRow,
  PayoutTile,
  PayoutsStrings,
} from './view'
import { adjustmentCurrency } from './adjustment-currency'

/**
 * Banking → Payouts workspace: one state graph for the cockpit and the
 * payout drawer. Everyday depth is the tiles plus the next action on every
 * row; the drawer holds matching configuration; the month-end accrual and
 * the scheduled-pull toggles sit inside collapsed DisclosureSections.
 * Numbers arrive server-formatted; every button names its consequence
 * (the drawer previews the journal effect before each commit).
 */

export interface PayoutsWorkspaceProps {
  canReconcile: boolean
  tiles: [PayoutTile, PayoutTile, PayoutTile]
  queue: PayoutQueueRow[]
  batches: PayoutBatchRow[]
  reportHref: string
  queueAllHref: string
  strings: PayoutsStrings
  emptyTitle: string
  emptyDescription: string
}

interface DetailLine {
  id: string
  lineNumber: number
  kind: string
  externalRef: string | null
  description: string | null
  amount: string
  currency: string | null
  documentId: string | null
  documentKind: string | null
  documentNumber: string | null
}

interface DetailBatch {
  id: string
  provider: string
  externalRef: string
  status: string
  currency: string
  netAmount: string
  settlementDate: string
}

interface TieoutDeposit {
  statementLineId: string
  postedOn: string
  amount: string
  currency: string
  description: string | null
}

interface DetailTieout {
  status: 'tied' | 'untied' | 'not_posted'
  netAmount?: string
  currency?: string
  depositLines?: TieoutDeposit[]
  gapAmount?: string | null
}

interface DetailAccrual {
  id: string
  accrualDate: string
  reversalDate: string
  amount: string
  currency: string
  status: string
}

interface BatchDetail {
  batch: DetailBatch
  lines: DetailLine[]
  tieout: DetailTieout
  accruals: DetailAccrual[]
}

interface MatchVerdict {
  status: 'matched' | 'unmatched' | 'not_applicable'
  lineId: string
  kind?: string
  reason?: string
  remedy?: string
  documentNumber?: string | null
}

async function postSettlements(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown; error?: string; remedy?: string }> {
  const res = await fetch('/api/psp/settlements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // The refusal is read before it is parsed: an error body never reaches
  // res.json(), so the operator always sees the message, never a parse error.
  if (!res.ok) {
    let error = `Request failed (${res.status})`
    let remedy: string | undefined
    try {
      const data = await res.json()
      if (typeof data?.error === 'string') error = data.error
      if (typeof data?.remedy === 'string') remedy = data.remedy
    } catch {
      // A non-JSON error body still refuses by status, never by parse error.
    }
    return { ok: false, status: res.status, data: null, error, remedy }
  }
  return { ok: true, status: res.status, data: await res.json() }
}

function MatchBadge({ status, strings }: { status: MatchVerdict['status']; strings: PayoutsStrings }) {
  if (status === 'matched') return <Badge variant="success">{strings.matchedLabel}</Badge>
  if (status === 'unmatched') return <Badge variant="warning">{strings.unmatchedRowLabel}</Badge>
  return <Badge variant="secondary">{strings.notApplicableLabel}</Badge>
}

function PayoutsDrawer({
  batchId,
  canReconcile,
  strings,
  onClose,
  onChanged,
}: {
  batchId: string
  canReconcile: boolean
  strings: PayoutsStrings
  onClose: () => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  const [verdicts, setVerdicts] = useState<MatchVerdict[] | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [linkLineId, setLinkLineId] = useState<string | null>(null)
  const [docOptions, setDocOptions] = useState<{ value: string; label: string; hint?: string }[]>([])
  const [docLoading, setDocLoading] = useState(false)
  const [docStatus, setDocStatus] = useState<string | null>(null)
  // Drawer amounts arrive as raw major-unit strings from the detail API;
  // the house formatter renders them exactly like the workspace tiles.
  const { money } = useMoney()
  // Parameterized sentences translate with their variables at the call
  // site, never pre-rendered on the server without them.
  const t = useTranslations('banking.payouts')

  // One shell for the whole record lifecycle: the Drawer stays mounted
  // through loading, refusal and retry — only its body changes. The fetch
  // itself sets no state; the effect and the action handlers settle the
  // shell from its async continuations, exactly like the settlements
  // workspace detail loader.
  const fetchDetail = useCallback(async (signal?: AbortSignal): Promise<BatchDetail> => {
    const res = await fetch(`/api/psp/settlements?batchId=${encodeURIComponent(batchId)}`, { signal })
    if (!res.ok) {
      let message = strings.loadFailedLabel
      try {
        const data = await res.json()
        if (typeof data?.error === 'string') message = data.error
      } catch {
        // Keep the fallback message when the error body is not JSON.
      }
      throw new Error(message)
    }
    return (await res.json()) as BatchDetail
  }, [batchId, strings.loadFailedLabel])

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setFailed(null)
    try {
      const data = await fetchDetail(signal)
      if (signal?.aborted) return
      setDetail(data)
      setLoading(false)
    } catch {
      // Aborts and network loss both land here; an abort means a newer
      // load owns the shell, so only a live shell reports failure.
      if (!signal?.aborted) {
        setFailed(strings.loadFailedLabel)
        setLoading(false)
      }
    }
  }, [fetchDetail, strings.loadFailedLabel])

  useEffect(() => {
    const controller = new AbortController()
    void fetchDetail(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return
        setDetail(data)
        setLoading(false)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setFailed(error instanceof Error ? error.message : strings.loadFailedLabel)
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [fetchDetail, strings.loadFailedLabel])

  const runMatch = useCallback(async () => {
    setActing('match')
    const result = await postSettlements({ action: 'match', batchId })
    setActing(null)
    if (!result.ok) {
      toast.error(result.remedy ? `${result.error} — ${result.remedy}` : (result.error ?? strings.loadFailedLabel))
      return
    }
    setVerdicts((result.data as { lines: MatchVerdict[] }).lines)
    toast.success(strings.matchedToast)
    onChanged()
    await load()
  }, [batchId, load, onChanged, strings])

  const linkLine = useCallback(async (lineId: string, documentId: string) => {
    setActing(`link:${lineId}`)
    const result = await postSettlements({ action: 'link', batchId, lineId, documentId })
    setActing(null)
    if (!result.ok) {
      toast.error(result.remedy ? `${result.error} — ${result.remedy}` : (result.error ?? strings.loadFailedLabel))
      return
    }
    setLinkLineId(null)
    toast.success(strings.linkedToast)
    onChanged()
    await load()
  }, [batchId, load, onChanged, strings])

  const unlinkLine = useCallback(async (lineId: string) => {
    setActing(`unlink:${lineId}`)
    const result = await postSettlements({ action: 'unlink', batchId, lineId })
    setActing(null)
    if (!result.ok) {
      toast.error(result.error ?? strings.loadFailedLabel)
      return
    }
    toast.success(strings.unlinkedToast)
    onChanged()
    await load()
  }, [batchId, load, onChanged, strings])

  const markAdjustment = useCallback(async (lineId: string, lineKind: string, lineAmount: string, lineCurrency: string | null) => {
    // No guessed currency: without a line or batch currency there is no
    // honest figure to confirm, so the adjustment refuses with a remedy.
    const currency = adjustmentCurrency(lineCurrency, detail?.batch.currency)
    if (!currency) {
      toast.error(t('adjustMissingCurrency', { kind: lineKind }))
      return
    }
    const confirmed = await confirmDialog({
      title: strings.adjustConfirmTitle,
      message: t('adjustConfirmMessage', { kind: lineKind, amount: money(lineAmount, { currency }) }),
      confirmLabel: strings.adjustLabel,
      tone: 'default',
    })
    if (!confirmed) return
    setActing(`adjust:${lineId}`)
    const result = await postSettlements({ action: 'markAdjustment', batchId, lineId })
    setActing(null)
    if (!result.ok) {
      toast.error(result.remedy ? `${result.error} — ${result.remedy}` : (result.error ?? strings.loadFailedLabel))
      return
    }
    toast.success(strings.adjustedToast)
    onChanged()
    await load()
  }, [batchId, detail?.batch.currency, load, money, onChanged, strings, t])

  const searchDocs = useCallback(async (query: string) => {
    if (query.trim() === '') {
      setDocOptions([])
      return
    }
    setDocLoading(true)
    setDocStatus(null)
    const res = await fetch(`/api/psp/settlements?resolveDoc=${encodeURIComponent(query.trim())}`)
    if (!res.ok) {
      setDocLoading(false)
      setDocStatus(strings.loadFailedLabel)
      return
    }
    const data = await res.json()
    setDocOptions((data.documents as { id: string; kind: string; documentNumber: string | null; total: string; currency: string }[]).map((doc) => ({
      value: doc.id,
      label: doc.documentNumber ?? doc.id,
      hint: `${doc.kind} · ${doc.total} ${doc.currency}`,
    })))
    setDocLoading(false)
  }, [strings.loadFailedLabel])

  const verdictByLine = useMemo(() => {
    const map = new Map<string, MatchVerdict>()
    for (const verdict of verdicts ?? []) map.set(verdict.lineId, verdict)
    return map
  }, [verdicts])

  const title = detail
    ? t('drawerTitle', { ref: detail.batch.externalRef, provider: detail.batch.provider })
    : strings.batchesTitle

  return (
    <Drawer open onClose={onClose} size="lg" title={title}>
      {loading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{strings.loadingLabel}</p>
      ) : failed || !detail ? (
        <div className="py-4 text-center text-sm text-muted-foreground">
          <p>{failed ?? strings.loadFailedLabel}</p>
          <Button size="sm" className="mt-2" onClick={() => void load()}>{strings.retryLabel}</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {detail.tieout.status === 'tied' ? (
            <div className="space-y-1 text-sm">
              <p>
                <Badge variant="success">{strings.tiedLabel}</Badge>{' '}
                <span className="text-muted-foreground">
                  {strings.gapLabel}: {detail.tieout.gapAmount ? money(detail.tieout.gapAmount, { currency: detail.tieout.currency ?? detail.batch.currency }) : '—'}
                </span>
              </p>
              {(detail.tieout.depositLines ?? []).length > 0 ? (
                <ul className="space-y-0.5 text-muted-foreground">
                  {(detail.tieout.depositLines ?? []).map((deposit) => (
                    <li key={deposit.statementLineId}>
                      {deposit.postedOn}: {money(deposit.amount, { currency: deposit.currency })}{deposit.description ? ` — ${deposit.description}` : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : detail.tieout.status === 'untied' ? (
            <p className="text-sm">
              <Badge variant="warning">{strings.untiedLabel}</Badge>{' '}
              <span className="text-muted-foreground">{strings.untiedHint}</span>
            </p>
          ) : null}
          {canReconcile ? (
            <div>
              <Button size="sm" disabled={acting !== null} onClick={() => void runMatch()}>
                {acting === 'match' ? strings.workingLabel : strings.matchLabel}
              </Button>
            </div>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{strings.lineHead}</TableHead>
                <TableHead>{strings.kindHead}</TableHead>
                <TableHead>{strings.amountHead}</TableHead>
                <TableHead>{strings.documentHead}</TableHead>
                <TableHead>{strings.matchHead}</TableHead>
                {canReconcile ? <TableHead>{strings.actionHead}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.map((line) => {
                const verdict = verdictByLine.get(line.id)
                const status: MatchVerdict['status'] = verdict?.status ?? (line.documentId ? 'matched' : 'unmatched')
                return (
                  <TableRow key={line.id}>
                    <TableCell>{line.lineNumber}</TableCell>
                    <TableCell>{strings.kindLabels[line.kind] ?? line.kind}</TableCell>
                    <TableCell>{money(line.amount, { currency: line.currency ?? detail.batch.currency })}</TableCell>
                    <TableCell>
                      {line.documentId ? (
                        <span className="flex items-center gap-2">
                          {line.documentKind === 'cash_sale' && line.documentNumber ? (
                            <ListDrawerLink href={`/cash-sales?doc=${encodeURIComponent(line.documentId)}`}>
                              {line.documentNumber}
                            </ListDrawerLink>
                          ) : line.documentKind === 'customer_payment' && line.documentNumber ? (
                            <ListDrawerLink href={`/receipts?payment=${encodeURIComponent(line.documentId)}`}>
                              {line.documentNumber}
                            </ListDrawerLink>
                          ) : (
                            line.documentNumber ?? line.documentId
                          )}
                          {canReconcile ? (
                            <Button size="sm" variant="ghost" disabled={acting !== null} onClick={() => void unlinkLine(line.id)}>
                              {strings.unlinkLabel}
                            </Button>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <MatchBadge status={status} strings={strings} />
                        {verdict?.status === 'unmatched' ? (
                          <span className="text-xs text-muted-foreground">
                            {strings.reasonLabels[verdict.reason ?? ''] ?? verdict.reason}: {verdict.remedy}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    {canReconcile ? (
                      <TableCell>
                        {!line.documentId ? (
                          <span className="flex flex-col gap-1">
                            {linkLineId === line.id ? (
                              <span className="flex items-center gap-1">
                                <SearchSelect
                                  value=""
                                  onChange={(value) => { if (value) void linkLine(line.id, value) }}
                                  options={docOptions}
                                  placeholder={strings.resolvePlaceholder}
                                  remote
                                  loading={docLoading}
                                  statusMessage={docStatus ?? undefined}
                                  onSearchChange={(query) => void searchDocs(query)}
                                />
                                <Button size="sm" variant="ghost" onClick={() => setLinkLineId(null)}>
                                  {strings.closeLabel}
                                </Button>
                              </span>
                            ) : (
                              <Button size="sm" variant="outline" disabled={acting !== null} onClick={() => setLinkLineId(line.id)}>
                                {strings.linkLabel}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={acting !== null}
                              onClick={() => void markAdjustment(line.id, strings.kindLabels[line.kind] ?? line.kind, line.amount, line.currency)}
                            >
                              {acting === `adjust:${line.id}` ? strings.workingLabel : strings.adjustLabel}
                            </Button>
                          </span>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {detail.accruals.length > 0 ? (
            <div>
              <h3 className="text-sm font-medium">{strings.accrualTitle}</h3>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {detail.accruals.map((accrual) => (
                  <li key={accrual.id}>
                    {accrual.accrualDate} → {accrual.reversalDate}: {money(accrual.amount, { currency: accrual.currency })} ({accrual.status})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}

export function PayoutsWorkspace(props: PayoutsWorkspaceProps) {
  const { canReconcile, queue, batches, reportHref, queueAllHref, strings, emptyTitle, emptyDescription } = props
  const router = useRouter()
  const t = useTranslations('banking.payouts')
  // The drawer opens from the `payout` URL parameter (deep-linkable, one
  // shell per record) but reads it once on mount: no Suspense boundary is
  // needed and closing always clears the parameter again.
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('payout'),
  )
  const [accrualDate, setAccrualDate] = useState('')
  const [accruing, setAccruing] = useState(false)
  const [accrueResult, setAccrueResult] = useState<string | null>(null)

  const openDrawer = useCallback((batchId: string) => {
    setSelectedBatchId(batchId)
    router.replace(`?payout=${encodeURIComponent(batchId)}`, { scroll: false })
  }, [router])

  const closeDrawer = useCallback(() => {
    setSelectedBatchId(null)
    router.replace('?', { scroll: false })
  }, [router])

  const refresh = useCallback(() => {
    router.refresh()
  }, [router])

  const runAccrual = useCallback(async () => {
    if (accrualDate.trim() === '') return
    const confirmed = await confirmDialog({
      title: strings.accrueLabel,
      message: t('accrueConfirmMessage', { date: accrualDate.trim() }),
      confirmLabel: strings.accrueLabel,
      tone: 'default',
    })
    if (!confirmed) return
    setAccruing(true)
    const result = await postSettlements({ action: 'accrue', accrualDate: accrualDate.trim() })
    setAccruing(false)
    if (!result.ok) {
      toast.error(result.remedy ? `${result.error} — ${result.remedy}` : (result.error ?? strings.loadFailedLabel))
      return
    }
    const run = result.data as { accrued: unknown[]; reversed: unknown[]; skipped: unknown[] }
    setAccrueResult(
      t('accrueResultMessage', {
        accrued: String(run.accrued.length),
        reversed: String(run.reversed.length),
        skipped: String(run.skipped.length),
      }),
    )
    toast.success(strings.accruedToast)
    refresh()
  }, [accrualDate, refresh, strings, t])

  const statusTone = useCallback((status: string): 'success' | 'secondary' | 'warning' | 'destructive' | 'default' | 'outline' => {
    if (status === 'posted') return 'success'
    if (status === 'draft') return 'secondary'
    return 'outline'
  }, [])

  return (
    <div className="space-y-4">
      {batches.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <>
          {queue.length > 0 ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{strings.queueTitle}</CardTitle>
                  <a className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300" href={queueAllHref}>
                    {strings.queueAllLabel}
                  </a>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{strings.payoutHead}</TableHead>
                      <TableHead>{strings.dateHead}</TableHead>
                      <TableHead>{strings.kindHead}</TableHead>
                      <TableHead>{strings.amountHead}</TableHead>
                      <TableHead>{strings.actionHead}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.map((row) => (
                      <TableRow key={row.lineId}>
                        <TableCell>{row.provider} · {row.externalRef}</TableCell>
                        <TableCell>{row.settlementDate}</TableCell>
                        <TableCell>{strings.kindLabels[row.kind] ?? row.kind}</TableCell>
                        <TableCell>{row.amount}</TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" onClick={() => openDrawer(row.batchId)}>
                            {strings.reviewLabel}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <EmptyState title={strings.queueEmpty} />
          )}
          <Card>
            <CardHeader>
              <CardTitle>{strings.batchesTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              {batches.length === 0 ? (
                <p className="text-sm text-muted-foreground">{strings.batchesEmpty}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{strings.payoutHead}</TableHead>
                      <TableHead>{strings.dateHead}</TableHead>
                      <TableHead>{strings.netHead}</TableHead>
                      <TableHead>{strings.statusHead}</TableHead>
                      <TableHead>{strings.unmatchedHead}</TableHead>
                      <TableHead>{strings.depositHead}</TableHead>
                      <TableHead>{strings.actionHead}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map((batch) => (
                      <TableRow key={batch.id}>
                        <TableCell>{batch.provider} · {batch.externalRef}</TableCell>
                        <TableCell>{batch.settlementDate}</TableCell>
                        <TableCell>{batch.netAmount}</TableCell>
                        <TableCell><Badge variant={statusTone(batch.status)}>{batch.statusLabel}</Badge></TableCell>
                        <TableCell>
                          {batch.unmatchedLines > 0 ? (
                            <Badge variant="warning">{batch.unmatchedLines}</Badge>
                          ) : (
                            <Badge variant="success">0</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {batch.status !== 'posted' ? (
                            <span className="text-muted-foreground">—</span>
                          ) : batch.tied ? (
                            <Badge variant="success">{strings.tiedLabel}</Badge>
                          ) : (
                            <Badge variant="warning">{strings.untiedLabel}</Badge>
                          )}
                          {batch.accrued ? (
                            <> <Badge variant="secondary">{strings.inTransitBadge}</Badge></>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" onClick={() => openDrawer(batch.id)}>
                            {strings.openLabel}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {canReconcile ? (
        <DisclosureSection
          title={strings.accrueTitle}
          summary={accrueResult ?? strings.accrueSummary}
          forceOpen={false}
        >
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {strings.accrualDateLabel}
              <Input
                type="date"
                value={accrualDate}
                onChange={(event) => setAccrualDate(event.target.value)}
              />
            </label>
            <Button size="sm" disabled={accruing || accrualDate.trim() === ''} onClick={() => void runAccrual()}>
              {accruing ? strings.workingLabel : strings.accrueLabel}
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{strings.accrueHint}</p>
          <p className="mt-2 text-sm">
            <a className="underline" href={reportHref}>{strings.reportLinkLabel}</a>
          </p>
        </DisclosureSection>
      ) : (
        <p className="text-sm">
          <a className="underline" href={reportHref}>{strings.reportLinkLabel}</a>
        </p>
      )}
      {selectedBatchId ? (
        <PayoutsDrawer
          key={selectedBatchId}
          batchId={selectedBatchId}
          canReconcile={canReconcile}
          strings={strings}
          onClose={closeDrawer}
          onChanged={refresh}
        />
      ) : null}
    </div>
  )
}

