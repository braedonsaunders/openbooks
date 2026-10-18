'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, UrlDrawer } from '@openbooks/ui'
import type { RoundModelResult } from '@openbooks/engine/equity'
import { add } from '@openbooks/engine/money/money'
import { RegisteredListTable } from '@/components/registered-list-table'
import { useMoney } from '@/components/money-provider'
import type { EquityContext, RoundsViewData } from './view'
import { CELL, Field, HEAD, NUM_CELL, NUM_HEAD, Stat, percentText, postJson, priceText, useShares } from './shared'

/**
 * Priced financing rounds of the legal entity, with the round modeller one
 * click away in its drawer (`?model=round`): a pro-forma priced round against
 * the cap table on the as-of date. Nothing the modeller shows is recorded.
 */
export function EquityRoundsPanel({ view }: { view: RoundsViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const { money } = useMoney()
  if (!view) return null
  const classCodes = new Map(view.structure.classes.map((row) => [row.id, row.code]))
  return (
    <div className="space-y-3">
      <RegisteredListTable
        source="equity_rounds"
        rows={view.structure.rounds}
        rowKey={(row) => row.id}
        empty={t('rounds.empty')}
        toolbarAfter={
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="sm"><Link href={view.modelHref}>{t('rounds.model')}</Link></Button>
          </div>
        }
        columns={[
          { key: 'name', header: <>{t('rounds.columns.name')}</>, headerClassName: HEAD, className: `${CELL} font-medium`, cell: (row) => <>{row.name}</>, search: (row) => row.name },
          { key: 'class', header: <>{t('rounds.columns.class')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{classCodes.get(row.shareClassId) ?? '—'}</> },
          { key: 'closed', header: <>{t('rounds.columns.closedOn')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.closedOn}</> },
          { key: 'price', header: <>{t('rounds.columns.price')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{priceText(row.pricePerShare)}</> },
          { key: 'preMoney', header: <>{t('rounds.columns.preMoney')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.preMoneyValuation, { currency: row.currency })}</> },
          { key: 'raised', header: <>{t('rounds.columns.raised')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.raised, { currency: row.currency })}</> },
          { key: 'postMoney', header: <>{t('rounds.columns.postMoney')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(add(row.preMoneyValuation, row.raised), { currency: row.currency })}</strong> },
          { key: 'shares', header: <>{t('rounds.columns.shares')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.sharesIssued)}</> },
        ]}
      />
      {view.modelOpen && <RoundModelDrawer context={view.context} closeHref={view.modelCloseHref} />}
    </div>
  )
}

/** Pro-forma priced round: nothing is recorded; the model reads the cap table on the as-of date. */
function RoundModelDrawer({ context, closeHref }: { context: EquityContext; closeHref: string }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const { money } = useMoney()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ preMoneyValuation: '', investment: '', targetPoolPercent: '' })
  const [result, setResult] = useState<{ result: RoundModelResult; parties: Record<string, string> } | null>(null)
  async function run() {
    setBusy(true)
    try {
      setResult(await postJson('/api/equity/models/round', {
        subsidiaryId: context.subsidiaryId, asOf: context.asOf, preMoneyValuation: form.preMoneyValuation, investment: form.investment,
        targetPoolPercent: form.targetPoolPercent || null,
      }, t('model.failed')))
    } catch (error) {
      setResult(null)
      toast.error(error instanceof Error ? error.message : t('model.failed'))
    } finally {
      setBusy(false)
    }
  }
  const r = result?.result
  const label = (key: string) => key === 'new_investors' ? t('model.newInvestors') : key === 'pool' ? t('model.pool') : key === 'anti_dilution' ? t('model.antiDilution') : result?.parties[key] ?? key
  return (
    <UrlDrawer open closeHref={closeHref} size="xl" title={t('rounds.model')} description={t('model.description')}>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('model.preMoney')}><Input inputMode="decimal" value={form.preMoneyValuation} onChange={(e) => setForm({ ...form, preMoneyValuation: e.target.value })} /></Field>
          <Field label={t('model.investment')}><Input inputMode="decimal" value={form.investment} onChange={(e) => setForm({ ...form, investment: e.target.value })} /></Field>
          <Field label={t('model.targetPool')}><Input inputMode="decimal" value={form.targetPoolPercent} onChange={(e) => setForm({ ...form, targetPoolPercent: e.target.value })} placeholder="10" /></Field>
          <Button onClick={run} disabled={busy || !form.preMoneyValuation || !form.investment}>{t('model.run')}</Button>
        </div>
        {r ? (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('model.price')} value={priceText(r.pricePerShare)} />
              <Stat label={t('model.postMoney')} value={money(r.postMoneyValuation, { currency: context.currency })} />
              <Stat label={t('model.investorShares')} value={`${shares(r.investorShares)} · ${percentText(r.investorPercent)}`} />
              <Stat label={t('model.fullyDilutedAfter')} value={shares(r.fullyDilutedAfter)} />
              <Stat label={t('model.conversionShares')} value={shares(r.conversionShares)} />
              <Stat label={t('model.poolTopUp')} value={`${shares(r.poolTopUp)} · ${percentText(r.poolPercentAfter)}`} />
              <Stat label={t('model.antiDilutionShares')} value={shares(r.antiDilutionShares)} />
              <Stat label={t('model.cashRounding')} value={money(r.investorCashRounding, { currency: context.currency })} />
            </section>
            <RegisteredListTable
              source="equity_round_model"
              rows={r.dilution}
              rowKey={(row) => row.key}
              empty={t('model.empty')}
              searchable={false}
              columns={[
                { key: 'holder', header: <>{t('model.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{label(row.key)}</> },
                { key: 'before', header: <>{t('model.columns.sharesBefore')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.sharesBefore)}</> },
                { key: 'percentBefore', header: <>{t('model.columns.percentBefore')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.percentBefore)}</> },
                { key: 'after', header: <>{t('model.columns.sharesAfter')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.sharesAfter)}</> },
                { key: 'percentAfter', header: <>{t('model.columns.percentAfter')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.percentAfter)}</> },
              ]}
            />
            {r.conversions.length > 0 && (
              <RegisteredListTable
                source="equity_round_model_conversions"
                rows={r.conversions}
                rowKey={(row) => row.securityId}
                empty={t('model.empty')}
                searchable={false}
                columns={[
                  { key: 'holder', header: <>{t('model.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{row.holderPartyId ? result?.parties[row.holderPartyId] ?? '—' : '—'}</> },
                  { key: 'amount', header: <>{t('model.columns.amount')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.amount, { currency: context.currency })}</> },
                  { key: 'pricedBy', header: <>{t('model.columns.pricedBy')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{t(`model.pricedBy.${row.pricedBy}`)}</> },
                  { key: 'price', header: <>{t('model.columns.price')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{priceText(row.price)}</> },
                  { key: 'shares', header: <>{t('model.columns.shares')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.shares)}</> },
                ]}
              />
            )}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400 dark:border-slate-800 dark:text-slate-500">{t('model.prompt')}</p>
        )}
      </div>
    </UrlDrawer>
  )
}
