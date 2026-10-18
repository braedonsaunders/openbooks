'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { SlidersHorizontal } from 'lucide-react'
import { Badge, EmptyState, Input, Popover, Select, TableCell, TableRow, cn } from '@openbooks/ui'
import type { WaterfallScenario } from '@openbooks/engine/equity'
import { add, cmp, sum } from '@openbooks/engine/money/money'
import { RegisteredListTable } from '@/components/registered-list-table'
import { ListFilterSelect } from '@/components/list-filter-select'
import { HomePanel, HomeStatTile } from '@/components/module-home/client'
import { MoneyProvider, useMoney } from '@/components/money-provider'
import { toChartNumber } from '@/lib/chart-number'
import { conversionDecisions, curveSeries, payoutLines, percentOf, waterfallSteps, type PayoutLine, type RecipientKey, type WaterfallStep } from '@/lib/equity-waterfall'
import { TrendChart, Waterfall } from '../analytics/_ui/charts'
import { EquityAsOfControl } from './AsOfControl'
import type { WaterfallViewData } from './view'
import { CELL, HEAD, NUM_CELL, NUM_HEAD, Refusal, TOTAL_ROW, percentText, postJson, priceText } from './shared'

const DECIMAL = /^\d+(\.\d{1,4})?$/

type Inputs = WaterfallViewData['inputs']

/**
 * The exit waterfall: an exit value distributed through the preference
 * stack on the as-of date, recomputed as the inputs change. It opens on the
 * latest priced round's post-money valuation with preset multiples, and
 * shows the payment cascade, each elector's choice with the amounts behind
 * it, the proceeds of every class across exit values, and the payouts by
 * class or holder. Nothing is recorded.
 */
export function EquityWaterfallPanel({ view }: { view: WaterfallViewData | null }) {
  if (!view) return null
  // A new entity or date is a new book: the scenario state starts again from
  // the server's first paint. Amounts and charts read in the entity's currency.
  return (
    <MoneyProvider currency={view.context.currency}>
      <WaterfallScenarioView key={`${view.context.subsidiaryId}:${view.context.asOf}`} view={view} />
    </MoneyProvider>
  )
}

function WaterfallScenarioView({ view }: { view: WaterfallViewData }) {
  const t = useTranslations('equity')
  const { money, moneyCompact } = useMoney()
  const { context } = view
  const [inputs, setInputs] = useState<Inputs>(view.inputs)
  const [scenario, setScenario] = useState<WaterfallScenario | null>(view.scenario)
  const [refusal, setRefusal] = useState(view.refusal)
  const [busy, setBusy] = useState(false)
  const [assumptionsOpen, setAssumptionsOpen] = useState(false)
  const [payoutsBy, setPayoutsBy] = useState<'class' | 'holder'>('class')
  const sequence = useRef(0)
  const first = useRef(true)

  const valid = DECIMAL.test(inputs.exitValue) && (inputs.transactionFees === '' || DECIMAL.test(inputs.transactionFees))
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // Keep the scenario in the URL so a reload or a shared link opens it.
    const url = new URL(window.location.href)
    const set = (key: string, value: string | null) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key))
    set('exit', inputs.exitValue || null)
    set('fees', inputs.transactionFees || null)
    set('unvested', inputs.unvestedAwards === 'cancel' ? 'cancel' : null)
    set('coc', inputs.changeOfControl ? null : '0')
    set('terminated', inputs.terminated ? '1' : null)
    window.history.replaceState(null, '', `${url.pathname}?${url.searchParams.toString()}`)
    if (!valid) return
    const id = ++sequence.current
    const timer = window.setTimeout(async () => {
      setBusy(true)
      try {
        const next = await postJson<WaterfallScenario>('/api/equity/models/waterfall', {
          subsidiaryId: context.subsidiaryId, asOf: context.asOf, exitValue: inputs.exitValue, transactionFees: inputs.transactionFees || null,
          unvestedAwards: inputs.unvestedAwards, changeOfControl: inputs.changeOfControl, terminated: inputs.terminated,
        }, t('waterfall.failed'))
        if (id !== sequence.current) return
        setScenario(next)
        setRefusal(null)
      } catch (error) {
        if (id !== sequence.current) return
        setRefusal({ message: error instanceof Error ? error.message : t('waterfall.failed'), remedy: t('waterfall.retry') })
      } finally {
        if (id === sequence.current) setBusy(false)
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [inputs, valid, context.subsidiaryId, context.asOf, t])

  const result = scenario?.result ?? null
  const steps = useMemo(() => (result && scenario ? waterfallSteps(result, scenario.transactionFees) : []), [result, scenario])
  const lines = useMemo(() => (result ? payoutLines(result) : []), [result])
  const decisions = useMemo(() => (result ? conversionDecisions(result) : []), [result])
  const curve = useMemo(() => (scenario ? curveSeries(scenario.curve) : { exitValues: [], series: [] }), [scenario])
  const codeOf = (key: RecipientKey) => (key.startsWith('class:') ? result?.classes.find((row) => `class:${row.shareClassId}` === key)?.code ?? '' : '')
  const recipientLabel = (key: RecipientKey) => (key.startsWith('class:') ? codeOf(key) : key === 'safes' ? t('kindPlural.safe') : t(`waterfall.recipients.${key as 'awards' | 'notes' | 'unallocated'}`))
  const stepLabel = (step: WaterfallStep) => {
    switch (step.kind) {
      case 'preference': return t('waterfall.steps.preference', { code: step.code ?? '' })
      case 'participation': return result?.classes.find((row) => row.code === step.code && row.kind === 'preferred' && !row.converted) ? t('waterfall.steps.participation', { code: step.code ?? '' }) : step.code ?? ''
      default: return t(`waterfall.steps.${step.kind}`)
    }
  }

  const preferredTotal = result ? sum(result.classes.filter((row) => row.kind === 'preferred').map((row) => row.total)) : '0.0000'
  const commonTotal = result
    ? add(sum(result.classes.filter((row) => row.kind !== 'preferred').map((row) => row.total)), sum(result.payouts.filter((row) => row.kind === 'award').map((row) => row.amount)))
    : '0.0000'
  const update = (patch: Partial<Inputs>) => setInputs((current) => ({ ...current, ...patch }))
  const isPreset = (value: string) => DECIMAL.test(inputs.exitValue) && cmp(value, inputs.exitValue) === 0

  const bar = (
    <EquityAsOfControl
      control={view.asOfControl}
      compact={false}
      leading={
        <>
          <label className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">{t('waterfall.exitValue')}</span>
            <Input inputMode="decimal" value={inputs.exitValue} onChange={(e) => update({ exitValue: e.target.value.trim() })} aria-invalid={inputs.exitValue !== '' && !DECIMAL.test(inputs.exitValue)} className="h-8 w-36 tabular-nums" placeholder="25000000" />
          </label>
          {view.presets.length > 0 && (
            <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t('waterfall.presets', { round: view.anchor?.roundName ?? '' })}>
              {view.presets.map((preset) => (
                <button
                  key={preset.multiple}
                  type="button"
                  aria-pressed={isPreset(preset.value)}
                  title={money(preset.value)}
                  onClick={() => update({ exitValue: preset.value.replace(/\.0000$/, '') })}
                  className={cn(
                    'h-7 rounded-full px-2.5 text-xs font-medium tabular-nums transition-colors',
                    isPreset(preset.value)
                      ? 'bg-teal-600 text-white dark:bg-teal-500'
                      : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  {`${preset.multiple}×`}
                </button>
              ))}
            </div>
          )}
          <label className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">{t('waterfall.fees')}</span>
            <Input inputMode="decimal" value={inputs.transactionFees} onChange={(e) => update({ transactionFees: e.target.value.trim() })} aria-invalid={inputs.transactionFees !== '' && !DECIMAL.test(inputs.transactionFees)} className="h-8 w-32 tabular-nums" placeholder="0" />
          </label>
        </>
      }
      actions={
        <>
          {busy && <span className="text-xs text-slate-400" role="status">{t('waterfall.updating')}</span>}
          <Popover
            open={assumptionsOpen}
            onOpenChange={setAssumptionsOpen}
            align="end"
            label={t('waterfall.assumptions')}
            trigger={
              <button type="button" onClick={() => setAssumptionsOpen((open) => !open)} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
                <SlidersHorizontal size={14} /> {t('waterfall.assumptions')}
              </button>
            }
          >
            <div className="w-72 space-y-3 p-3 text-sm">
              <label className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">{t('waterfall.unvested')}</span>
                <Select value={inputs.unvestedAwards} onChange={(e) => update({ unvestedAwards: e.target.value === 'cancel' ? 'cancel' : 'participate' })} className="h-8 w-48">
                  <option value="participate">{t('waterfall.unvestedParticipate')}</option>
                  <option value="cancel">{t('waterfall.unvestedCancel')}</option>
                </Select>
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">{t('waterfall.changeOfControl')}</span>
                <input type="checkbox" checked={inputs.changeOfControl} onChange={(e) => update({ changeOfControl: e.target.checked })} className="h-4 w-4 accent-teal-600" />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">{t('waterfall.terminated')}</span>
                <input type="checkbox" checked={inputs.terminated} onChange={(e) => update({ terminated: e.target.checked })} className="h-4 w-4 accent-teal-600" />
              </label>
              <p className="text-xs text-slate-400 dark:text-slate-500">{t('waterfall.assumptionsHelp')}</p>
            </div>
          </Popover>
        </>
      }
    />
  )

  if (!result || !scenario) {
    return (
      <div className="space-y-4">
        {bar}
        {refusal ? <Refusal refusal={refusal} /> : <EmptyState title={t('waterfall.promptTitle')} description={view.anchor ? t('waterfall.prompt') : t('waterfall.promptNoRound', { currency: context.currency })} />}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {bar}
      {refusal && <Refusal refusal={refusal} />}
      <div className={cn('space-y-4 transition-opacity', busy && 'opacity-60')} aria-busy={busy}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <HomeStatTile icon="wallet" accent="teal" label={t('waterfall.tiles.proceeds')} value={moneyCompact(result.exitValue)}
            sub={cmp(scenario.transactionFees, '0') > 0 ? t('waterfall.tiles.proceedsSub', { exit: moneyCompact(scenario.grossExitValue), fees: moneyCompact(scenario.transactionFees) }) : t('waterfall.tiles.noFees')} />
          <HomeStatTile icon="trending-up" accent="sky" label={t('waterfall.pricePerShare')} value={money(result.pricePerCommonShare, { maximumFractionDigits: 4 })} sub={t('waterfall.tiles.priceSub')} />
          <HomeStatTile icon="scale" accent="violet" label={t('waterfall.tiles.preferred')} value={moneyCompact(preferredTotal)} sub={t('waterfall.tiles.ofProceeds', { percent: percentOf(preferredTotal, result.exitValue) })} />
          <HomeStatTile icon="users" accent="emerald" label={t('waterfall.tiles.common')} value={moneyCompact(commonTotal)} sub={t('waterfall.tiles.ofProceeds', { percent: percentOf(commonTotal, result.exitValue) })} />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <HomePanel title={t('waterfall.cascadeTitle')} icon="area-chart" hint={t('waterfall.cascadeHint')} className="lg:col-span-2">
            <Waterfall
              magnitudeLabels
              height={280}
              steps={[
                { label: t('waterfall.steps.exit'), amount: toChartNumber(scenario.grossExitValue), kind: 'start' },
                ...steps.map((step) => ({ label: stepLabel(step), amount: -toChartNumber(step.amount), kind: 'deduct' as const })),
              ]}
            />
          </HomePanel>
          <HomePanel title={t('waterfall.decisionsTitle')} icon="scale" bodyClassName="p-0">
            {decisions.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{t('waterfall.noDecisions')}</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {decisions.map((decision) => {
                  const converted = decision.decision === 'converts' || decision.decision === 'safe_converts'
                  const name = decision.subject === 'class' ? decision.code : scenario.parties[decision.holderPartyId ?? ''] ?? t('kind.safe')
                  const amounts = {
                    amount: money(decision.amount), entitlement: money(decision.entitlement),
                    alternative: decision.alternative ? money(decision.alternative) : '', cap: decision.cap ? money(decision.cap) : '',
                  }
                  const key = decision.alternative || decision.decision === 'participates' ? decision.decision : `${decision.decision}_only`
                  return (
                    <li key={decision.key} className="space-y-1 px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn('font-medium text-slate-800 dark:text-slate-100', decision.subject === 'class' && 'font-mono')}>{name}</span>
                        <Badge variant={converted ? 'success' : 'secondary'}>{converted ? t('waterfall.converts') : t('waterfall.takesPreference')}</Badge>
                      </div>
                      <p className="text-slate-500 dark:text-slate-400">{t(`waterfall.decisions.${key}`, amounts)}</p>
                    </li>
                  )
                })}
              </ul>
            )}
          </HomePanel>
        </div>
        {curve.series.length > 0 && (
          <HomePanel title={t('waterfall.curveTitle')} icon="trending-up" hint={t('waterfall.curveHint')}>
            <TrendChart
              height={260}
              maxTicks={9}
              labels={curve.exitValues.map((value) => moneyCompact(value))}
              series={curve.series.map((series) => ({ name: recipientLabel(series.key), data: series.data.map((value) => toChartNumber(value)) }))}
            />
          </HomePanel>
        )}
        {payoutsBy === 'class' ? (
          <RegisteredListTable
            source="equity_waterfall_classes"
            rows={lines}
            rowKey={(row) => row.key}
            empty={t('waterfall.empty')}
            searchable={false}
            toolbarAfter={<PayoutsFilter value={payoutsBy} onChange={setPayoutsBy} />}
            columns={[
              { key: 'recipient', header: <>{t('waterfall.columns.recipient')}</>, headerClassName: HEAD, className: CELL, cell: (row: PayoutLine) => <span className={row.code ? 'font-mono font-medium' : ''}>{recipientLabel(row.key)}</span> },
              { key: 'election', header: <>{t('waterfall.columns.election')}</>, headerClassName: HEAD, className: CELL, cell: (row: PayoutLine) => <>{row.converted === null ? '—' : row.converted ? t('waterfall.converts') : t('waterfall.takesPreference')}</> },
              { key: 'preference', header: <>{t('waterfall.columns.preference')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: PayoutLine) => <>{row.preference ? money(row.preference) : '—'}</> },
              { key: 'participation', header: <>{t('waterfall.columns.participation')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: PayoutLine) => <>{row.participation ? money(row.participation) : '—'}</> },
              { key: 'total', header: <>{t('waterfall.columns.total')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: PayoutLine) => <strong>{money(row.total)}</strong> },
              { key: 'perShare', header: <>{t('waterfall.columns.perShare')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: PayoutLine) => <>{row.perShare ? priceText(row.perShare) : '—'}</> },
              { key: 'percent', header: <>{t('waterfall.columns.percent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: PayoutLine) => <>{row.percent}%</> },
            ]}
            footer={
              <TableRow className={TOTAL_ROW}>
                <TableCell className={CELL} colSpan={4}>{t('waterfall.columns.total')}</TableCell>
                <TableCell className={NUM_CELL}>{money(result.exitValue)}</TableCell>
                <TableCell className={NUM_CELL} />
                <TableCell className={NUM_CELL}>{percentText('100')}</TableCell>
              </TableRow>
            }
          />
        ) : (
          <RegisteredListTable
            source="equity_waterfall_holders"
            rows={result.holders}
            rowKey={(row) => row.holderPartyId}
            empty={t('waterfall.empty')}
            toolbarAfter={<PayoutsFilter value={payoutsBy} onChange={setPayoutsBy} />}
            columns={[
              { key: 'holder', header: <>{t('capTable.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{scenario.parties[row.holderPartyId] ?? row.holderPartyId}</>, search: (row) => scenario.parties[row.holderPartyId] ?? '' },
              { key: 'amount', header: <>{t('waterfall.columns.payout')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(row.amount)}</strong> },
              { key: 'percent', header: <>{t('waterfall.columns.percent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.percent)}</> },
            ]}
          />
        )}
      </div>
    </div>
  )
}

function PayoutsFilter({ value, onChange }: { value: 'class' | 'holder'; onChange: (value: 'class' | 'holder') => void }) {
  const t = useTranslations('equity')
  return (
    <ListFilterSelect
      basePath="/equity" currentParams={{}} paramKey="payouts" pageParamKey={null} label={t('waterfall.payoutsBy')}
      value={value} onValueChange={(next) => onChange(next === 'holder' ? 'holder' : 'class')}
      options={[{ value: 'class', label: t('waterfall.byClass') }, { value: 'holder', label: t('waterfall.byHolder') }]}
    />
  )
}
