'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, SearchSelect, Textarea } from '@openbooks/ui'
import { RegisteredListTable } from '@/components/registered-list-table'
import { useMoney } from '@/components/money-provider'
import type { HolderRow, ClassRow, ConvertibleRow, RoundModelResult, WaterfallResult, CompensationRunResult } from '@openbooks/engine/equity'
import type { CapTableViewData, CompensationViewData, SecuritiesViewData, StakeholdersViewData, StructureViewData, EquityContext } from './view'
import {
  CELL, Field, HEAD, LINK, NUM_CELL, NUM_HEAD, PillTabs, STATUS_VARIANT, SegmentTabs, Stat,
  percentText, postJson, priceText, searchText, useShares, withParams,
} from './shared'
import { DateField } from '@/components/date-field'

const BASE = '/equity'

/** The as-of date every tab reads the cap table on. */
export function EquityAsOf({ value, label }: { value: string; label: string }) {
  const router = useRouter()
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <DateField
        className="h-8 w-40"
        defaultValue={value}
        aria-label={label}
        onChange={(value) => {
          const next = value
          if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return
          const url = new URL(window.location.href)
          url.searchParams.set('asOf', next)
          router.push(`${url.pathname}?${url.searchParams.toString()}`)
        }}
      />
    </label>
  )
}

function PolicyBanner({ href }: { href: string }) {
  const t = useTranslations('equity')
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      {t('policy.missing')}{' '}
      <Link href={href} className="font-medium underline">{t('policy.setup')}</Link>
    </div>
  )
}

/** Cap table by class or by holder, with class amendments and splits for approvers. */
export function EquityCapTablePanel({ view }: { view: CapTableViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const [classAction, setClassAction] = useState<ClassRow | null>(null)
  if (!view) return null
  const { table } = view
  const classCodes = new Map(table.classes.map((row) => [row.shareClassId, row.code]))
  return (
    <div className="space-y-4">
      {!view.hasAccountPolicy && <PolicyBanner href={view.accountsSetupHref} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs tabs={view.byTabs} label={t('capTable.byLabel')} />
        {view.reportHref && <Link href={view.reportHref} className={`text-xs ${LINK}`}>{t('capTable.report')}</Link>}
      </div>
      {view.by === 'class' ? (
        <RegisteredListTable
          source="equity_cap_table_classes"
          rows={table.classes}
          rowKey={(row) => row.shareClassId}
          empty={t('capTable.emptyClasses')}
          searchable={false}
          columns={[
            {
              key: 'class', header: <>{t('capTable.columns.class')}</>, headerClassName: HEAD, className: CELL,
              cell: (row) => (
                <span>
                  <span className="font-mono font-medium">{row.code}</span> <span className="text-slate-500">{row.name}</span>{' '}
                  <Badge variant="outline">{t(`classKind.${row.kind}`)}</Badge>
                </span>
              ),
            },
            { key: 'authorized', header: <>{t('capTable.columns.authorized')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.authorized)}</> },
            { key: 'outstanding', header: <>{t('capTable.columns.outstanding')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.outstanding)}</> },
            { key: 'asConverted', header: <>{t('capTable.columns.asConverted')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.asConvertedOutstanding)}</> },
            { key: 'awards', header: <>{t('capTable.columns.awards')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.awardsOutstanding)}</> },
            { key: 'pool', header: <>{t('capTable.columns.pool')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.poolAvailable)}</> },
            { key: 'fullyDiluted', header: <>{t('capTable.columns.fullyDiluted')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.fullyDiluted)}</> },
            { key: 'outstandingPercent', header: <>{t('capTable.columns.outstandingPercent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.outstandingPercent)}</> },
            { key: 'fullyDilutedPercent', header: <>{t('capTable.columns.fullyDilutedPercent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.fullyDilutedPercent)}</> },
            {
              key: 'actions', header: <span className="sr-only">{t('capTable.columns.actions')}</span>, headerClassName: HEAD, className: `${CELL} text-right`,
              cell: (row) => view.context.canApprove
                ? <Button size="sm" variant="ghost" onClick={() => setClassAction(row)}>{t('capTable.amend')}</Button>
                : null,
            },
          ]}
          footer={
            <div className="flex flex-wrap justify-end gap-6 px-4 py-2 text-sm tabular-nums">
              <span>{t('capTable.totalOutstanding')}: <strong>{shares(table.totals.outstanding)}</strong></span>
              <span>{t('capTable.totalFullyDiluted')}: <strong>{shares(table.totals.fullyDiluted)}</strong></span>
            </div>
          }
        />
      ) : (
        <RegisteredListTable
          source="equity_cap_table_holders"
          rows={table.holders}
          rowKey={(row) => row.holderPartyId}
          empty={t('capTable.emptyHolders')}
          columns={[
            {
              key: 'holder', header: <>{t('capTable.columns.holder')}</>, headerClassName: HEAD, className: CELL,
              cell: (row: HolderRow) => (
                <Link className={LINK} href={withParams(BASE, view.context.params, { view: 'securities', holder: row.holderPartyId })}>
                  {view.parties[row.holderPartyId] ?? row.holderPartyId}
                </Link>
              ),
              search: (row) => view.parties[row.holderPartyId] ?? '',
            },
            ...table.classes.map((shareClass) => ({
              key: `class:${shareClass.shareClassId}`,
              header: <span className="font-mono">{shareClass.code}</span>,
              headerClassName: NUM_HEAD,
              className: NUM_CELL,
              cell: (row: HolderRow) => <>{row.sharesByClass[shareClass.shareClassId] ? shares(row.sharesByClass[shareClass.shareClassId]) : '—'}</>,
            })),
            { key: 'options', header: <>{t('capTable.columns.options')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: HolderRow) => <>{shares(row.options)}</> },
            { key: 'rsus', header: <>{t('capTable.columns.rsus')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: HolderRow) => <>{shares(row.rsus)}</> },
            { key: 'warrants', header: <>{t('capTable.columns.warrants')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: HolderRow) => <>{shares(row.warrants)}</> },
            { key: 'fullyDiluted', header: <>{t('capTable.columns.fullyDiluted')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: HolderRow) => <>{shares(row.fullyDiluted)}</> },
            { key: 'outstandingPercent', header: <>{t('capTable.columns.outstandingPercent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: HolderRow) => <>{percentText(row.outstandingPercent)}</> },
            { key: 'fullyDilutedPercent', header: <>{t('capTable.columns.fullyDilutedPercent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: HolderRow) => <>{percentText(row.fullyDilutedPercent)}</> },
          ]}
          footer={
            <div className="flex flex-wrap justify-end gap-6 px-4 py-2 text-sm tabular-nums">
              <span>{t('capTable.poolUnallocated')}: <strong>{shares(table.totals.poolAvailable)}</strong></span>
              <span>{t('capTable.totalFullyDiluted')}: <strong>{shares(table.totals.fullyDiluted)}</strong></span>
            </div>
          }
        />
      )}
      {classAction && (
        <ClassActionDrawer
          shareClass={classAction}
          code={classCodes.get(classAction.shareClassId) ?? classAction.code}
          context={view.context}
          onClose={() => setClassAction(null)}
        />
      )}
    </div>
  )
}

/** Approver actions on a class: amend the authorized shares or conversion price, or record a split. */
function ClassActionDrawer({ shareClass, code, context, onClose }: { shareClass: ClassRow; code: string; context: EquityContext; onClose: () => void }) {
  const t = useTranslations('equity')
  const router = useRouter()
  const [mode, setMode] = useState<'authorized_shares' | 'conversion_price' | 'split'>('authorized_shares')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ effectiveOn: context.asOf, value: '', numerator: '', denominator: '', reason: '' })
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  async function submit() {
    setBusy(true)
    try {
      if (mode === 'split') {
        await postJson(`/api/equity/classes/${shareClass.shareClassId}/splits`, { effectiveOn: form.effectiveOn, ratioNumerator: form.numerator, ratioDenominator: form.denominator, reason: form.reason }, t('classActions.failed'))
      } else {
        await postJson(`/api/equity/classes/${shareClass.shareClassId}/amendments`, {
          kind: mode, effectiveOn: form.effectiveOn, reason: form.reason,
          ...(mode === 'authorized_shares' ? { authorizedShares: form.value } : { conversionPrice: form.value }),
        }, t('classActions.failed'))
      }
      toast.success(t('classActions.saved'))
      onClose()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('classActions.failed'))
    } finally {
      setBusy(false)
    }
  }
  const modes = [
    { key: 'authorized_shares' as const, label: t('classActions.authorized') },
    ...(shareClass.kind === 'preferred' ? [{ key: 'conversion_price' as const, label: t('classActions.conversionPrice') }] : []),
    { key: 'split' as const, label: t('classActions.split') },
  ]
  const ready = form.effectiveOn && form.reason.trim().length >= 5 && (mode === 'split' ? form.numerator && form.denominator : form.value)
  return (
    <Drawer open onClose={onClose} title={t('classActions.title', { code })} description={t('classActions.description')}>
      <div className="space-y-4 p-4">
        <SegmentTabs value={mode} onChange={setMode} tabs={modes} label={t('classActions.title', { code })} />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => set('effectiveOn')(value)} /></Field>
          {mode === 'authorized_shares' && (
            <Field label={t('fields.authorizedShares')} hint={t('classActions.currentAuthorized', { value: shareClass.authorized })}>
              <Input inputMode="numeric" value={form.value} onChange={(e) => set('value')(e.target.value)} />
            </Field>
          )}
          {mode === 'conversion_price' && (
            <Field label={t('fields.conversionPrice')} hint={t('classActions.currentConversionPrice', { value: priceText(shareClass.conversionPrice) })}>
              <Input inputMode="decimal" value={form.value} onChange={(e) => set('value')(e.target.value)} />
            </Field>
          )}
          {mode === 'split' && (
            <>
              <Field label={t('fields.splitNew')}><Input inputMode="numeric" value={form.numerator} onChange={(e) => set('numerator')(e.target.value)} placeholder="2" /></Field>
              <Field label={t('fields.splitOld')}><Input inputMode="numeric" value={form.denominator} onChange={(e) => set('denominator')(e.target.value)} placeholder="1" /></Field>
            </>
          )}
        </div>
        {mode === 'split' && <p className="text-sm text-slate-500 dark:text-slate-400">{t('classActions.splitHelp')}</p>}
        <Field label={t('fields.reason')}><Textarea rows={3} value={form.reason} onChange={(e) => set('reason')(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={submit} disabled={busy || !ready}>{t('actions.save')}</Button>
        </div>
      </div>
    </Drawer>
  )
}

/** The securities register: every certificate, award and convertible, each row opening its drawer. */
export function EquitySecuritiesPanel({ view }: { view: SecuritiesViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const { money } = useMoney()
  if (!view) return null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs tabs={view.kindTabs} label={t('securities.kindFilter')} />
        {view.holderPartyId && (
          <Link href={withParams(BASE, view.context.params, { view: 'securities', kind: view.kind ?? undefined })} className={`text-xs ${LINK}`}>
            {t('securities.clearHolder', { name: view.holderName ?? '' })}
          </Link>
        )}
      </div>
      <RegisteredListTable
        source="equity_securities"
        rows={view.rows}
        rowKey={(row) => row.id}
        empty={t('securities.empty')}
        columns={[
          {
            key: 'number', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
            cell: (row) => <Link className={`font-mono ${LINK}`} href={row.href}>{row.securityNumber}</Link>,
            search: searchText,
          },
          { key: 'kind', header: <>{t('securities.columns.kind')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{t(`kind.${row.kind}`)}</> },
          { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{row.holderName}</> },
          { key: 'class', header: <>{t('securities.columns.class')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.shareClassCode ?? '—'}</> },
          { key: 'issued', header: <>{t('securities.columns.issued')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.issueDate}</> },
          {
            key: 'status', header: <>{t('securities.columns.status')}</>, headerClassName: HEAD, className: CELL,
            cell: (row) => <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{t(`status.${row.status}`)}</Badge>,
          },
          {
            key: 'outstanding', header: <>{t('securities.columns.outstanding')}</>, headerClassName: NUM_HEAD, className: NUM_CELL,
            cell: (row) => <>{row.principal ? money(row.principal, { currency: row.currency }) : shares(row.outstanding)}</>,
          },
          { key: 'vested', header: <>{t('securities.columns.vested')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{row.vested ? shares(row.vested) : '—'}</> },
          { key: 'price', header: <>{t('securities.columns.price')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{priceText(row.price)}</> },
        ]}
      />
    </div>
  )
}

/** Holders on the cap table with their directory details and ownership. */
export function EquityStakeholdersPanel({ view }: { view: StakeholdersViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  if (!view) return null
  return (
    <RegisteredListTable
      source="equity_stakeholders"
      rows={view.table.holders}
      rowKey={(row) => row.holderPartyId}
      empty={t('stakeholders.empty')}
      columns={[
        {
          key: 'name', header: <>{t('stakeholders.columns.name')}</>, headerClassName: HEAD, className: CELL,
          cell: (row) => (
            <Link className={LINK} href={withParams(BASE, view.context.params, { view: 'securities', holder: row.holderPartyId })}>
              {view.parties[row.holderPartyId]?.name ?? row.holderPartyId}
            </Link>
          ),
          search: (row) => `${view.parties[row.holderPartyId]?.name ?? ''} ${view.parties[row.holderPartyId]?.email ?? ''}`,
        },
        { key: 'kind', header: <>{t('stakeholders.columns.kind')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{view.parties[row.holderPartyId]?.kind ? t(`partyKind.${view.parties[row.holderPartyId]!.kind}`) : '—'}</> },
        { key: 'email', header: <>{t('stakeholders.columns.email')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{view.parties[row.holderPartyId]?.email ?? '—'}</> },
        { key: 'shares', header: <>{t('stakeholders.columns.shares')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.asConvertedOutstanding)}</> },
        { key: 'vested', header: <>{t('stakeholders.columns.vestedAwards')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.vestedAwards)}</> },
        { key: 'fullyDiluted', header: <>{t('stakeholders.columns.fullyDiluted')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.fullyDiluted)}</> },
        { key: 'percent', header: <>{t('stakeholders.columns.percent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.fullyDilutedPercent)}</> },
      ]}
    />
  )
}

/** Plans and their pools as of the date; approvers change a plan's reserve. */
export function EquityPlansPanel({ view }: { view: StructureViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const [reservePlan, setReservePlan] = useState<{ id: string; code: string } | null>(null)
  if (!view) return null
  const classCodes = new Map(view.structure.classes.map((row) => [row.id, row.code]))
  return (
    <div className="space-y-3">
      <RegisteredListTable
        source="equity_plans"
        rows={view.structure.plans}
        rowKey={(row) => row.id}
        empty={t('plans.empty')}
        searchable={false}
        columns={[
          { key: 'code', header: <>{t('plans.columns.plan')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <span><span className="font-mono font-medium">{row.code}</span> <span className="text-slate-500">{row.name}</span></span> },
          { key: 'class', header: <>{t('plans.columns.class')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{classCodes.get(row.shareClassId) ?? '—'}</> },
          { key: 'reserved', header: <>{t('plans.columns.reserved')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.reserved)}</> },
          { key: 'used', header: <>{t('plans.columns.used')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.used)}</> },
          { key: 'returned', header: <>{t('plans.columns.returned')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.returned)}</> },
          { key: 'available', header: <>{t('plans.columns.available')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{shares(row.available)}</strong> },
          {
            key: 'recycling', header: <>{t('plans.columns.recycling')}</>, headerClassName: HEAD, className: `${CELL} text-xs`,
            cell: (row) => <>{[row.recycleForfeited && t('plans.recycle.forfeited'), row.recycleExpired && t('plans.recycle.expired'), row.recycleRepurchased && t('plans.recycle.repurchased')].filter(Boolean).join(' · ') || t('plans.recycle.none')}</>,
          },
          {
            key: 'actions', header: <span className="sr-only">{t('capTable.columns.actions')}</span>, headerClassName: HEAD, className: `${CELL} text-right`,
            cell: (row) => view.context.canApprove ? <Button size="sm" variant="ghost" onClick={() => setReservePlan({ id: row.id, code: row.code })}>{t('plans.changeReserve')}</Button> : null,
          },
        ]}
      />
      {reservePlan && <ReserveDrawer plan={reservePlan} context={view.context} onClose={() => setReservePlan(null)} />}
    </div>
  )
}

function ReserveDrawer({ plan, context, onClose }: { plan: { id: string; code: string }; context: EquityContext; onClose: () => void }) {
  const t = useTranslations('equity')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ effectiveOn: context.asOf, shareDelta: '', reason: '' })
  async function submit() {
    setBusy(true)
    try {
      await postJson(`/api/equity/plans/${plan.id}/reserve-changes`, form, t('plans.reserveFailed'))
      toast.success(t('plans.reserveSaved'))
      onClose()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('plans.reserveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer open onClose={onClose} title={t('plans.reserveTitle', { code: plan.code })} description={t('plans.reserveDescription')}>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => setForm({ ...form, effectiveOn: value })} /></Field>
          <Field label={t('fields.shareDelta')} hint={t('plans.deltaHelp')}><Input inputMode="numeric" value={form.shareDelta} onChange={(e) => setForm({ ...form, shareDelta: e.target.value })} /></Field>
        </div>
        <Field label={t('fields.reason')}><Textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={submit} disabled={busy || !form.shareDelta || form.reason.trim().length < 5}>{t('actions.save')}</Button>
        </div>
      </div>
    </Drawer>
  )
}

/** Rounds, the convertibles awaiting conversion, and the pro-forma round modeller — one body at a time. */
export function EquityRoundsPanel({ view }: { view: StructureViewData | null }) {
  const t = useTranslations('equity')
  const [section, setSection] = useState<'rounds' | 'convertibles' | 'model'>('rounds')
  if (!view) return null
  return (
    <div className="space-y-4">
      <SegmentTabs
        value={section}
        onChange={setSection}
        label={t('tabs.rounds')}
        tabs={[
          { key: 'rounds', label: t('rounds.sections.rounds') },
          { key: 'convertibles', label: t('rounds.sections.convertibles') },
          { key: 'model', label: t('rounds.sections.model') },
        ]}
      />
      {section === 'rounds' && <RoundsTable view={view} />}
      {section === 'convertibles' && <ConvertiblesTable view={view} />}
      {section === 'model' && <RoundModeller context={view.context} />}
    </div>
  )
}

function RoundsTable({ view }: { view: StructureViewData }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const { money } = useMoney()
  const classCodes = new Map(view.structure.classes.map((row) => [row.id, row.code]))
  return (
    <RegisteredListTable
      source="equity_rounds"
      rows={view.structure.rounds}
      rowKey={(row) => row.id}
      empty={t('rounds.empty')}
      searchable={false}
      columns={[
        { key: 'name', header: <>{t('rounds.columns.name')}</>, headerClassName: HEAD, className: `${CELL} font-medium`, cell: (row) => <>{row.name}</> },
        { key: 'class', header: <>{t('rounds.columns.class')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{classCodes.get(row.shareClassId) ?? '—'}</> },
        { key: 'closed', header: <>{t('rounds.columns.closedOn')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.closedOn}</> },
        { key: 'price', header: <>{t('rounds.columns.price')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{priceText(row.pricePerShare)}</> },
        { key: 'preMoney', header: <>{t('rounds.columns.preMoney')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.preMoneyValuation, { currency: row.currency })}</> },
        { key: 'raised', header: <>{t('rounds.columns.raised')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.raised, { currency: row.currency })}</> },
        { key: 'shares', header: <>{t('rounds.columns.shares')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.sharesIssued)}</> },
      ]}
    />
  )
}

function ConvertiblesTable({ view }: { view: StructureViewData }) {
  const t = useTranslations('equity')
  const { money } = useMoney()
  return (
    <RegisteredListTable
      source="equity_convertibles"
      rows={view.convertibles}
      rowKey={(row) => row.securityId}
      empty={t('rounds.convertiblesEmpty')}
      columns={[
        {
          key: 'number', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
          cell: (row: ConvertibleRow) => <Link className={`font-mono ${LINK}`} href={withParams(BASE, view.context.params, { view: 'securities', security: row.securityId })}>{row.securityNumber}</Link>,
          search: searchText,
        },
        { key: 'kind', header: <>{t('securities.columns.kind')}</>, headerClassName: HEAD, className: CELL, cell: (row: ConvertibleRow) => <>{t(`kind.${row.kind}`)}{row.safeType ? ` · ${t(`safeType.${row.safeType}`)}` : ''}</> },
        { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row: ConvertibleRow) => <>{view.parties[row.holderPartyId] ?? '—'}</> },
        { key: 'status', header: <>{t('securities.columns.status')}</>, headerClassName: HEAD, className: CELL, cell: (row: ConvertibleRow) => <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{t(`status.${row.status}`)}</Badge> },
        { key: 'principal', header: <>{t('rounds.columns.principal')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: ConvertibleRow) => <>{money(row.principal, { currency: row.currency })}</> },
        { key: 'interest', header: <>{t('rounds.columns.interest')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: ConvertibleRow) => <>{money(row.accruedInterest, { currency: row.currency })}</> },
        { key: 'cap', header: <>{t('rounds.columns.cap')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: ConvertibleRow) => <>{row.valuationCap ? money(row.valuationCap, { currency: row.currency }) : '—'}</> },
        { key: 'discount', header: <>{t('rounds.columns.discount')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row: ConvertibleRow) => <>{percentText(row.discountPercent)}</> },
      ]}
    />
  )
}

/** Pro-forma priced round: nothing is recorded; the model reads the cap table on the as-of date. */
function RoundModeller({ context }: { context: EquityContext }) {
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
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('model.description')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('model.preMoney')}><Input inputMode="decimal" value={form.preMoneyValuation} onChange={(e) => setForm({ ...form, preMoneyValuation: e.target.value })} /></Field>
        <Field label={t('model.investment')}><Input inputMode="decimal" value={form.investment} onChange={(e) => setForm({ ...form, investment: e.target.value })} /></Field>
        <Field label={t('model.targetPool')}><Input inputMode="decimal" value={form.targetPoolPercent} onChange={(e) => setForm({ ...form, targetPoolPercent: e.target.value })} placeholder="10" /></Field>
        <Button onClick={run} disabled={busy || !form.preMoneyValuation || !form.investment}>{t('model.run')}</Button>
      </div>
      {r && (
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
      )}
    </div>
  )
}

/** Exit waterfall: an exit value distributed through the preference stack. Nothing is recorded. */
export function EquityWaterfallPanel({ view }: { view: { context: EquityContext } | null }) {
  const t = useTranslations('equity')
  const { money } = useMoney()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ exitValue: '', unvestedAwards: 'participate', changeOfControl: true, terminated: false })
  const [section, setSection] = useState<'classes' | 'holders'>('classes')
  const [result, setResult] = useState<{ result: WaterfallResult; parties: Record<string, string>; classes: Record<string, string> } | null>(null)
  if (!view) return null
  const { context } = view
  async function run() {
    setBusy(true)
    try {
      setResult(await postJson('/api/equity/models/waterfall', { subsidiaryId: context.subsidiaryId, asOf: context.asOf, ...form }, t('waterfall.failed')))
    } catch (error) {
      setResult(null)
      toast.error(error instanceof Error ? error.message : t('waterfall.failed'))
    } finally {
      setBusy(false)
    }
  }
  const r = result?.result
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('waterfall.description')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('waterfall.exitValue')}><Input inputMode="decimal" value={form.exitValue} onChange={(e) => setForm({ ...form, exitValue: e.target.value })} /></Field>
        <Field label={t('waterfall.unvested')}>
          <SearchSelect
            value={form.unvestedAwards}
            options={[{ value: 'participate', label: t('waterfall.unvestedParticipate') }, { value: 'cancel', label: t('waterfall.unvestedCancel') }]}
            onChange={(value) => setForm({ ...form, unvestedAwards: value ?? 'participate' })}
            ariaLabel={t('waterfall.unvested')}
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={form.changeOfControl} onChange={(e) => setForm({ ...form, changeOfControl: e.target.checked })} />{t('waterfall.changeOfControl')}</label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={form.terminated} onChange={(e) => setForm({ ...form, terminated: e.target.checked })} />{t('waterfall.terminated')}</label>
        <Button onClick={run} disabled={busy || !form.exitValue}>{t('waterfall.run')}</Button>
      </div>
      {r && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={t('waterfall.exitValue')} value={money(r.exitValue, { currency: context.currency })} />
            <Stat label={t('waterfall.pricePerShare')} value={priceText(r.pricePerCommonShare)} />
            <Stat label={t('waterfall.unallocated')} value={money(r.unallocated, { currency: context.currency })} />
          </section>
          <SegmentTabs value={section} onChange={setSection} label={t('tabs.waterfall')} tabs={[{ key: 'classes', label: t('waterfall.byClass') }, { key: 'holders', label: t('waterfall.byHolder') }]} />
          {section === 'classes' ? (
            <RegisteredListTable
              source="equity_waterfall_classes"
              rows={r.classes}
              rowKey={(row) => row.shareClassId}
              empty={t('waterfall.empty')}
              searchable={false}
              columns={[
                { key: 'class', header: <>{t('capTable.columns.class')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.code}</> },
                { key: 'converted', header: <>{t('waterfall.columns.election')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{row.converted ? t('waterfall.converts') : t('waterfall.takesPreference')}</> },
                { key: 'preference', header: <>{t('waterfall.columns.preference')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.preference, { currency: context.currency })}</> },
                { key: 'participation', header: <>{t('waterfall.columns.participation')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.participation, { currency: context.currency })}</> },
                { key: 'total', header: <>{t('waterfall.columns.total')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(row.total, { currency: context.currency })}</strong> },
                { key: 'perShare', header: <>{t('waterfall.columns.perShare')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{priceText(row.perShare)}</> },
              ]}
            />
          ) : (
            <RegisteredListTable
              source="equity_waterfall_holders"
              rows={r.holders}
              rowKey={(row) => row.holderPartyId}
              empty={t('waterfall.empty')}
              columns={[
                { key: 'holder', header: <>{t('capTable.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{result?.parties[row.holderPartyId] ?? row.holderPartyId}</>, search: (row) => result?.parties[row.holderPartyId] ?? '' },
                { key: 'amount', header: <>{t('waterfall.columns.payout')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(row.amount, { currency: context.currency })}</strong> },
                { key: 'percent', header: <>{t('waterfall.columns.percent')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(row.percent)}</> },
              ]}
            />
          )}
        </>
      )}
    </div>
  )
}

/** Stock compensation through the as-of date per award, and the runs already posted. */
export function EquityCompensationPanel({ view }: { view: CompensationViewData | null }) {
  const t = useTranslations('equity')
  const { money } = useMoney()
  const router = useRouter()
  const [section, setSection] = useState<'schedule' | 'runs'>('schedule')
  const [busy, setBusy] = useState(false)
  if (!view) return null
  const { preview, context } = view
  async function post() {
    setBusy(true)
    try {
      const run = await postJson<CompensationRunResult>('/api/equity/compensation/runs', { subsidiaryId: context.subsidiaryId, throughDate: preview.throughDate }, t('compensation.failed'))
      toast.success(run.replayed ? t('compensation.replayed', { date: run.throughDate }) : t('compensation.posted', { date: run.throughDate }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('compensation.failed'))
    } finally {
      setBusy(false)
    }
  }
  const alreadyRun = view.runs.some((run) => run.throughDate === preview.throughDate)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentTabs value={section} onChange={setSection} label={t('tabs.compensation')} tabs={[{ key: 'schedule', label: t('compensation.schedule') }, { key: 'runs', label: t('compensation.runs') }]} />
        <div className="flex items-center gap-3">
          {view.reportHref && <Link href={view.reportHref} className={`text-xs ${LINK}`}>{t('compensation.report')}</Link>}
          {context.canApprove && section === 'schedule' && (
            <Button onClick={post} disabled={busy || alreadyRun || (preview.lastRunThrough !== null && preview.throughDate < preview.lastRunThrough)}>
              {t('compensation.post', { date: preview.throughDate })}
            </Button>
          )}
        </div>
      </div>
      {section === 'schedule' ? (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {preview.lastRunThrough ? t('compensation.lastRun', { date: preview.lastRunThrough }) : t('compensation.noRuns')} · {t('compensation.total')}: <strong>{money(preview.total, { currency: preview.currency })}</strong>
          </p>
          <RegisteredListTable
            source="equity_compensation_lines"
            rows={preview.lines}
            rowKey={(row) => row.securityId}
            empty={t('compensation.empty')}
            columns={[
              {
                key: 'security', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
                cell: (row) => <Link className={`font-mono ${LINK}`} href={withParams(BASE, context.params, { view: 'securities', security: row.securityId })}>{row.securityNumber}</Link>,
                search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ''}`,
              },
              { key: 'kind', header: <>{t('securities.columns.kind')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{t(`kind.${row.kind}`)}</> },
              { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{view.parties[row.holderPartyId] ?? '—'}</> },
              { key: 'cumulative', header: <>{t('compensation.columns.cumulative')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.cumulative, { currency: preview.currency })}</> },
              { key: 'previous', header: <>{t('compensation.columns.previous')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.previous, { currency: preview.currency })}</> },
              { key: 'period', header: <>{t('compensation.columns.period')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(row.period, { currency: preview.currency })}</strong> },
            ]}
          />
        </>
      ) : (
        <RegisteredListTable
          source="equity_compensation_runs"
          rows={view.runs}
          rowKey={(row) => row.id}
          empty={t('compensation.runsEmpty')}
          searchable={false}
          columns={[
            { key: 'through', header: <>{t('compensation.columns.through')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.throughDate}</> },
            { key: 'total', header: <>{t('compensation.columns.total')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.total, { currency: row.currency })}</> },
            {
              key: 'entry', header: <>{t('compensation.columns.entry')}</>, headerClassName: HEAD, className: `${CELL} font-mono`,
              cell: (row) => row.journalEntryId ? <Link className={LINK} href={`/journal?entry=${row.journalEntryId}`}>{row.entryNumber ?? row.journalEntryId}</Link> : <>{t('compensation.noEntry')}</>,
            },
          ]}
        />
      )}
    </div>
  )
}

