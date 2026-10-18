'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, SearchSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, UrlDrawer } from '@openbooks/ui'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import { useMoney } from '@/components/money-provider'
import type { RecordEventResult } from '@openbooks/engine/equity'
import type { SecurityDrawerData } from './view'
import { Field, LINK, PendingActions, STATUS_VARIANT, SegmentTabs, Stat, isPendingApproval, percentText, postJson, priceText, useShares, withParams } from './shared'
import { DateField } from '@/components/date-field'

type ActionKind = 'exercise' | 'settle' | 'forfeit' | 'expire' | 'cancel' | 'transfer' | 'convert' | 'repurchase' | 'void' | 'repay' | 'election_83b'
type Panel = 'overview' | 'vesting' | 'history' | 'mfn' | 'actions'

/**
 * The events each kind admits (equity.manage). Voids, repurchases and the
 * repayment or cancellation of a SAFE or note are governed: an Equity
 * action Flow may hold them for approval.
 */
const ACTIONS: Record<string, ActionKind[]> = {
  option: ['exercise', 'forfeit', 'expire', 'cancel', 'void'],
  rsu: ['settle', 'forfeit', 'cancel', 'void'],
  warrant: ['exercise', 'expire', 'cancel', 'transfer', 'void'],
  share: ['transfer', 'convert', 'election_83b', 'repurchase', 'void'],
  safe: ['convert', 'repay', 'cancel', 'void'],
  note: ['convert', 'repay', 'cancel', 'void'],
}
const NEEDS_REASON: ActionKind[] = ['forfeit', 'expire', 'cancel', 'repurchase', 'void']

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/**
 * One security: its terms, its state on the as-of date, its vesting
 * schedule, its history with the journal entries it posted, its MFN terms
 * for an MFN SAFE, and the events it admits for the reader's duties.
 * Overview, vesting, history, MFN and actions are sibling tabs; one body
 * shows at a time. A recorded forfeiture, expiry, cancellation, repurchase,
 * repayment or 83(b) election can be reversed from the history. Governed
 * actions an Equity action Flow holds for approval are listed above the
 * tabs until decided.
 */
export function SecurityDrawer({ context, detail, closeHref, holders, rounds, commonClasses, considerationAccounts }: SecurityDrawerData) {
  const t = useTranslations('equity')
  const shares = useShares()
  const { money } = useMoney()
  const s = detail.security
  const kind = String(s.kind)
  const convertible = kind === 'safe' || kind === 'note'
  const status = detail.state?.status ?? detail.convertible?.status ?? 'outstanding'
  const live = !['void', 'converted', 'repaid', 'cancelled'].includes(status)
  const actions = live
    ? (context.canManage ? ACTIONS[kind] ?? [] : [])
      .filter((action) => !(action === 'convert' && kind === 'share' && detail.shareClass?.kind !== 'preferred'))
      .filter((action) => action !== 'election_83b' || detail.election83b?.state === 'open')
    : []
  const [panel, setPanel] = useState<Panel>('overview')
  const [reversing, setReversing] = useState<{ id: string; kind: string; effectiveOn: string } | null>(null)
  const currency = String(s.currency)
  const amount = (value: unknown) => (str(value) ? money(String(value), { currency }) : '—')
  const functional = (value: unknown) => (str(value) ? money(String(value), { currency: detail.entity.currency }) : '—')
  const terms: [string, string][] = [
    [t('fields.holder'), detail.holderName],
    [t('fields.kind'), t(`kind.${kind}`)],
    [t('fields.issueDate'), String(s.issue_date)],
    ...(currency !== detail.entity.currency ? [[t('fields.currency'), `${currency} · ${t('drawer.issueRate', { rate: String(s.fx_rate) })}`] as [string, string]] : []),
    ...(detail.shareClass ? [[t('fields.shareClass'), `${detail.shareClass.code} · ${detail.shareClass.name}`] as [string, string]] : []),
    ...(detail.plan ? [[t('fields.plan'), `${detail.plan.code} · ${detail.plan.name}`] as [string, string]] : []),
    ...(detail.round ? [[t('fields.round'), detail.round.name] as [string, string]] : []),
    ...(str(s.quantity) ? [[t('fields.quantityIssued'), shares(String(s.quantity))] as [string, string]] : []),
    ...(detail.exercisePrice ? [[t('fields.exercisePrice'), priceText(detail.exercisePrice)] as [string, string]] : []),
    ...(kind === 'share' && str(s.price_per_share) ? [[t('fields.pricePerShare'), priceText(String(s.price_per_share))] as [string, string]] : []),
    ...(str(s.consideration_amount) ? [[convertible ? t('fields.principal') : t('fields.consideration'), amount(s.consideration_amount)] as [string, string]] : []),
    ...(str(s.option_type) ? [[t('fields.optionType'), t(`optionType.${String(s.option_type)}`)] as [string, string]] : []),
    ...(s.early_exercise === true ? [[t('fields.earlyExercise'), t(`repurchaseBasis.${String(s.unvested_repurchase_basis ?? 'none')}`)] as [string, string]] : []),
    ...(str(s.expiration_date) ? [[t('fields.expirationDate'), String(s.expiration_date)] as [string, string]] : []),
    ...(detail.convertible?.safeType ? [[t('fields.safeType'), t(`safeType.${detail.convertible.safeType}`)] as [string, string]] : []),
    ...(s.mfn === true ? [[t('fields.mfn'), detail.convertible?.electionId ? t('drawer.mfnAdopted') : t('drawer.mfnOpen')] as [string, string]] : []),
    ...(detail.convertible?.valuationCap ? [[t('fields.valuationCap'), amount(detail.convertible.valuationCap)] as [string, string]] : []),
    ...(detail.convertible?.discountPercent ? [[t('fields.discountPercent'), percentText(detail.convertible.discountPercent)] as [string, string]] : []),
    ...(str(s.interest_rate_percent) ? [[t('fields.interestRatePercent'), `${percentText(String(s.interest_rate_percent))} · ${t(`interestBasis.${String(s.interest_basis)}`)} · ${t(`dayCount.${String(s.interest_day_count)}`)}`] as [string, string]] : []),
    ...(str(s.maturity_date) ? [[t('fields.maturityDate'), String(s.maturity_date)] as [string, string]] : []),
    ...(str(s.acceleration) && s.acceleration !== 'none' ? [[t('fields.acceleration'), `${t(`acceleration.${String(s.acceleration)}`)} · ${percentText(str(s.acceleration_percent))}`] as [string, string]] : []),
    ...(str(s.valuation_method) ? [[t('fields.valuationMethod'), t(`valuationMethod.${String(s.valuation_method)}`)] as [string, string]] : []),
    ...(str(s.valuation_share_price) ? [[t('fields.grantSharePrice'), priceText(String(s.valuation_share_price))] as [string, string]] : []),
    ...(str(s.volatility_percent) ? [[t('fields.volatilityPercent'), percentText(String(s.volatility_percent))] as [string, string]] : []),
    ...(str(s.risk_free_rate_percent) ? [[t('fields.riskFreeRatePercent'), percentText(String(s.risk_free_rate_percent))] as [string, string]] : []),
    ...(str(s.expected_term_years) ? [[t('fields.expectedTermYears'), String(s.expected_term_years)] as [string, string]] : []),
    ...(str(s.dividend_yield_percent) ? [[t('fields.dividendYieldPercent'), percentText(String(s.dividend_yield_percent))] as [string, string]] : []),
    ...(str(s.fair_value_per_unit) ? [[t('fields.fairValuePerUnit'), priceText(String(s.fair_value_per_unit))] as [string, string]] : []),
    ...(str(s.expense_attribution) ? [[t('fields.attribution'), t(`attribution.${String(s.expense_attribution)}`)] as [string, string]] : []),
    ...(str(s.memo) ? [[t('fields.memo'), String(s.memo)] as [string, string]] : []),
  ]
  const election = detail.election83b
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{String(s.security_number)}</span>
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{t(`status.${status}`)}</Badge>
          {election && <Badge variant={election.state === 'filed' ? 'success' : election.state === 'open' ? 'warning' : 'outline'}>{t(`election83b.${election.state}`)}</Badge>}
        </span>
      }
      description={`${t(`kind.${kind}`)} · ${detail.holderName}`}
    >
      <div className="space-y-5 p-1">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {detail.state ? (
            <>
              <Stat label={t('drawer.outstanding')} value={shares(detail.state.outstanding)} />
              <Stat label={t('drawer.vested')} value={shares(detail.state.vestedAvailable)} />
              <Stat label={t('drawer.unvested')} value={shares(detail.state.unvested)} />
              <Stat label={t('drawer.asOf')} value={detail.asOf} />
            </>
          ) : detail.convertible ? (
            <>
              <Stat label={t('fields.principal')} value={amount(detail.convertible.principal)} />
              <Stat label={t('drawer.accruedInterest')} value={amount(detail.convertible.accruedInterest)} />
              <Stat label={t('drawer.convertingAmount')} value={amount(detail.convertible.convertingAmount)} />
              <Stat label={t('drawer.asOf')} value={detail.asOf} />
            </>
          ) : null}
          {detail.interest && <Stat label={t('drawer.interestPosted')} value={amount(detail.interest.posted)} />}
          {detail.earlyExercise && <Stat label={t('drawer.exercisable')} value={shares(detail.earlyExercise.exercisable)} />}
          {detail.restricted && (
            <>
              <Stat label={t('drawer.restrictedShares')} value={shares(detail.restricted.restrictedShares)} />
              <Stat label={t('drawer.releasedShares')} value={shares(detail.restricted.releasedShares)} />
              <Stat label={t('drawer.depositHeld')} value={functional(detail.restricted.depositHeld)} />
            </>
          )}
          {election && (
            <Stat
              label={t('drawer.election83b')}
              value={election.state === 'filed' ? t('election83b.filedOn', { date: election.filedOn ?? '' }) : election.state === 'open' ? t('election83b.due', { date: election.deadline, days: election.daysLeft ?? 0 }) : t('election83b.missedOn', { date: election.deadline })}
            />
          )}
          {detail.compensation && (
            <>
              <Stat label={t('drawer.grantValue')} value={functional(detail.compensation.total)} />
              <Stat label={t('drawer.recognized')} value={functional(detail.compensation.recognized)} />
              <Stat label={t('drawer.posted')} value={functional(detail.compensation.posted)} />
            </>
          )}
        </section>
        <PendingActions pending={context.pending} filter={(request) => request.subjectId === String(s.id)} />
        <DrawerTabStrip
          ariaLabel={t('drawer.tabs')}
          activeKey={panel}
          onSelect={setPanel}
          tabs={[
            { key: 'overview' as const, label: t('drawer.overview') },
            { key: 'vesting' as const, label: t('drawer.vesting'), count: detail.vesting.length, disabled: detail.vesting.length === 0 },
            { key: 'history' as const, label: t('drawer.history'), count: detail.events.length },
            ...(detail.mfn ? [{ key: 'mfn' as const, label: t('drawer.mfn'), count: detail.mfn.candidates.length }] : []),
            { key: 'actions' as const, label: t('drawer.actions'), disabled: actions.length === 0 },
          ]}
        />
        {panel === 'overview' && (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              {terms.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {detail.restricted && (
              <p className="text-sm">
                {t('drawer.restrictedFrom', { basis: t(`repurchaseBasis.${detail.restricted.repurchaseBasis ?? 'none'}`) })}{' '}
                <Link className={`font-mono ${LINK}`} href={withParams('/equity', context.params, { view: 'securities', security: detail.restricted.sourceSecurityId })}>{detail.restricted.sourceSecurityNumber}</Link>
              </p>
            )}
            {detail.source && !detail.restricted && (
              <p className="text-sm">
                {t('drawer.source')}{' '}
                <Link className={`font-mono ${LINK}`} href={withParams('/equity', context.params, { view: 'securities', security: detail.source.id })}>{detail.source.securityNumber}</Link>
              </p>
            )}
            {detail.resulting.length > 0 && (
              <p className="text-sm">
                {t('drawer.resulting')}{' '}
                {detail.resulting.map((row, index) => (
                  <span key={row.id}>
                    {index > 0 && ', '}
                    <Link className={`font-mono ${LINK}`} href={withParams('/equity', context.params, { view: 'securities', security: row.id })}>{row.securityNumber}</Link> ({row.holderName})
                  </span>
                ))}
              </p>
            )}
            {str(s.journal_entry_id) && (
              <p className="text-sm">
                {t('drawer.issuanceEntry')}{' '}
                <Link className={LINK} href={`/journal?entry=${String(s.journal_entry_id)}`}>{t('drawer.viewEntry')}</Link>
              </p>
            )}
          </div>
        )}
        {panel === 'vesting' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('drawer.vestDate')}</TableHead>
                <TableHead className="text-right">{t('drawer.vestQuantity')}</TableHead>
                <TableHead className="text-right">{t('drawer.vestCumulative')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.vesting.map((row) => (
                <TableRow key={row.date} className={row.date <= detail.asOf ? '' : 'text-slate-500'}>
                  <TableCell className="font-mono">{row.date}</TableCell>
                  <TableCell className="text-right tabular-nums">{shares(row.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{shares(row.cumulative)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {panel === 'history' && (
          detail.events.length === 0 ? <p className="text-sm text-slate-500 dark:text-slate-400">{t('drawer.noEvents')}</p> : (
            <div className="space-y-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('drawer.eventDate')}</TableHead>
                    <TableHead>{t('drawer.eventKind')}</TableHead>
                    <TableHead className="text-right">{t('drawer.eventQuantity')}</TableHead>
                    <TableHead className="text-right">{t('drawer.eventAmount')}</TableHead>
                    <TableHead>{t('drawer.eventEntry')}</TableHead>
                    <TableHead>{t('drawer.eventReason')}</TableHead>
                    {context.canManage && live && <TableHead><span className="sr-only">{t('capTable.columns.actions')}</span></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.events.map((event) => (
                    <TableRow key={String(event.id)} className={str(event.reversed_by_event_id) ? 'text-slate-500 line-through decoration-slate-400' : ''}>
                      <TableCell className="font-mono">{String(event.effective_on)}</TableCell>
                      <TableCell>
                        {t(`eventKind.${String(event.kind)}`)}
                        {str(event.reversed_by_event_id) && <Badge variant="outline" className="ml-2 no-underline">{t('drawer.reversed')}</Badge>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{str(event.quantity) ? shares(String(event.quantity)) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{amount(event.amount)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <span className="flex flex-col">
                          {str(event.interest_accrual_entry_id) && <Link className={LINK} href={`/journal?entry=${String(event.interest_accrual_entry_id)}`}>{t('drawer.accrualEntry')}</Link>}
                          {str(event.journal_entry_id) && <Link className={LINK} href={`/journal?entry=${String(event.journal_entry_id)}`}>{str(event.journal_entry_number) ?? t('drawer.viewEntry')}</Link>}
                          {str(event.reversal_entry_id) && <Link className={LINK} href={`/journal?entry=${String(event.reversal_entry_id)}`}>{str(event.reversal_entry_number) ?? t('drawer.viewEntry')}</Link>}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">{str(event.reason) ?? ''}</TableCell>
                      {context.canManage && live && (
                        <TableCell className="text-right">
                          {event.reversible === true && (
                            <Button size="sm" variant="ghost" onClick={() => setReversing({ id: String(event.id), kind: String(event.kind), effectiveOn: String(event.effective_on) })}>
                              {t('drawer.reverse')}
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {reversing && (
                <ReversalForm securityId={String(s.id)} target={reversing} asOf={context.asOf} onDone={() => setReversing(null)} />
              )}
            </div>
          )
        )}
        {panel === 'mfn' && detail.mfn && (
          <MfnPanel securityId={String(s.id)} mfn={detail.mfn} asOf={context.asOf} canRecord={context.canManage && live} currency={currency} params={context.params} />
        )}
        {panel === 'actions' && actions.length > 0 && (
          <ActionForm
            securityId={String(s.id)}
            convertible={convertible}
            restricted={detail.restricted !== null}
            repurchaseBasis={detail.restricted?.repurchaseBasis ?? null}
            earlyExercise={detail.earlyExercise !== null}
            actions={actions}
            asOf={context.asOf}
            holders={holders}
            rounds={rounds}
            commonClasses={commonClasses}
            considerationAccounts={considerationAccounts}
            carrying={detail.convertible?.convertingAmount ?? null}
          />
        )}
      </div>
    </UrlDrawer>
  )
}

/** The reversal of one recorded event: its entry reverses on the date and its units or balance return. */
function ReversalForm({ securityId, target, asOf, onDone }: { securityId: string; target: { id: string; kind: string; effectiveOn: string }; asOf: string; onDone: () => void }) {
  const t = useTranslations('equity')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ effectiveOn: asOf < target.effectiveOn ? target.effectiveOn : asOf, reason: '' })
  async function submit() {
    setBusy(true)
    try {
      const result = await postJson<RecordEventResult>(`/api/equity/securities/${securityId}/events`, {
        kind: 'reverse', reversesEventId: target.id, effectiveOn: form.effectiveOn, reason: form.reason, idempotencyKey: `${target.id}:reverse:${crypto.randomUUID()}`,
      }, t('events.failed'))
      toast.success(isPendingApproval(result) ? t('approval.submitted') : t('events.reversed', { kind: t(`eventKind.${target.kind}`) }))
      onDone()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('events.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h3 className="text-sm font-semibold">{t('reversal.title', { kind: t(`eventKind.${target.kind}`), date: target.effectiveOn })}</h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('reversal.help')}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => setForm({ ...form, effectiveOn: value })} /></Field>
      </div>
      <Field label={t('fields.reason')}><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>{t('actions.cancel')}</Button>
        <Button variant="destructive" onClick={submit} disabled={busy || !form.effectiveOn || form.reason.trim().length < 5}>{t('drawer.reverse')}</Button>
      </div>
    </section>
  )
}

/** An MFN SAFE: later instruments whose better terms its holder may adopt, and the elections recorded. */
function MfnPanel({ securityId, mfn, asOf, canRecord, currency, params }: {
  securityId: string
  mfn: NonNullable<SecurityDrawerData['detail']['mfn']>
  asOf: string
  canRecord: boolean
  currency: string
  params: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('equity')
  const router = useRouter()
  const { money } = useMoney()
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ effectiveOn: asOf, reason: '' })
  const cap = (value: string | null) => (value ? money(value, { currency }) : t('mfn.none'))
  const discount = (value: string | null) => (value ? percentText(value) : t('mfn.none'))
  async function elect() {
    if (!choice) return
    setBusy(true)
    try {
      const result = await postJson(`/api/equity/securities/${securityId}/mfn-elections`, {
        sourceSecurityId: choice, effectiveOn: form.effectiveOn, reason: form.reason, idempotencyKey: `${securityId}:mfn:${crypto.randomUUID()}`,
      }, t('mfn.failed'))
      toast.success(isPendingApproval(result) ? t('approval.submitted') : t('mfn.saved'))
      setChoice(null)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('mfn.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('mfn.description')}</p>
      {mfn.candidates.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('mfn.noCandidates', { date: asOf })}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('securities.columns.number')}</TableHead>
              <TableHead>{t('fields.issueDate')}</TableHead>
              <TableHead className="text-right">{t('fields.valuationCap')}</TableHead>
              <TableHead className="text-right">{t('fields.discountPercent')}</TableHead>
              <TableHead>{t('fields.safeType')}</TableHead>
              <TableHead>{t('mfn.changes')}</TableHead>
              {canRecord && <TableHead><span className="sr-only">{t('capTable.columns.actions')}</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {mfn.candidates.map((row) => (
              <TableRow key={row.sourceSecurityId} aria-selected={choice === row.sourceSecurityId}>
                <TableCell><Link className={`font-mono ${LINK}`} href={withParams('/equity', params, { view: 'securities', security: row.sourceSecurityId })}>{row.securityNumber}</Link></TableCell>
                <TableCell className="font-mono">{row.issueDate}</TableCell>
                <TableCell className="text-right tabular-nums">{cap(row.valuationCap)}</TableCell>
                <TableCell className="text-right tabular-nums">{discount(row.discountPercent)}</TableCell>
                <TableCell>{t(`safeType.${row.safeType}`)}</TableCell>
                <TableCell className="text-xs">
                  {row.improves.map((term) => <Badge key={term} variant="success" className="mr-1">{t(`mfn.better.${term}`)}</Badge>)}
                  {row.concedes.map((term) => <Badge key={term} variant="warning" className="mr-1">{t(`mfn.worse.${term}`)}</Badge>)}
                </TableCell>
                {canRecord && (
                  <TableCell className="text-right">
                    <Button size="sm" variant={choice === row.sourceSecurityId ? 'default' : 'ghost'} onClick={() => setChoice(row.sourceSecurityId)}>{t('mfn.adopt')}</Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {choice && canRecord && (
        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="text-sm">{t('mfn.adoptHelp', { number: mfn.candidates.find((row) => row.sourceSecurityId === choice)?.securityNumber ?? '' })}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('mfn.electedOn')}><DateField value={form.effectiveOn} onChange={(value) => setForm({ ...form, effectiveOn: value })} /></Field>
          </div>
          <Field label={t('fields.reason')}><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setChoice(null)}>{t('actions.cancel')}</Button>
            <Button onClick={elect} disabled={busy || !form.effectiveOn || form.reason.trim().length < 5}>{t('mfn.record')}</Button>
          </div>
        </section>
      )}
      {mfn.elections.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('mfn.elections')}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('mfn.electedOn')}</TableHead>
                <TableHead>{t('mfn.source')}</TableHead>
                <TableHead className="text-right">{t('fields.valuationCap')}</TableHead>
                <TableHead className="text-right">{t('fields.discountPercent')}</TableHead>
                <TableHead>{t('fields.safeType')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mfn.elections.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">{row.effectiveOn}</TableCell>
                  <TableCell><Link className={`font-mono ${LINK}`} href={withParams('/equity', params, { view: 'securities', security: row.sourceSecurityId })}>{row.sourceSecurityNumber}</Link></TableCell>
                  <TableCell className="text-right tabular-nums">{cap(row.valuationCap)}</TableCell>
                  <TableCell className="text-right tabular-nums">{discount(row.discountPercent)}</TableCell>
                  <TableCell>{t(`safeType.${row.safeType}`)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  )
}

function ActionForm({ securityId, convertible, restricted, repurchaseBasis, earlyExercise, actions, asOf, holders, rounds, commonClasses, considerationAccounts, carrying }: {
  securityId: string
  /** SAFEs and notes convert in a round; preferred shares convert into a common class. */
  convertible: boolean
  /** Shares bought by early exercise: unvested shares repurchase on the grant's terms. */
  restricted: boolean
  repurchaseBasis: string | null
  earlyExercise: boolean
  actions: ActionKind[]
  asOf: string
  holders: { value: string; label: string }[]
  rounds: { value: string; label: string }[]
  commonClasses: { value: string; label: string }[]
  considerationAccounts: { value: string; label: string }[]
  /** A SAFE's or note's carrying amount on the as-of date, the default repayment. */
  carrying: string | null
}) {
  const t = useTranslations('equity')
  const router = useRouter()
  const [action, setAction] = useState<ActionKind>(actions[0]!)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    effectiveOn: asOf, quantity: '', amount: '', considerationAccountId: '', transfereePartyId: '', roundId: '', targetShareClassId: '', reason: '', fairMarketValuePerShare: '',
  })
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  const settlingConvertible = convertible && (action === 'repay' || action === 'cancel' || action === 'convert')
  const needsQuantity = !(action === 'void' || action === 'election_83b' || settlingConvertible)
  const restrictedRepurchase = action === 'repurchase' && restricted
  const needsReason = NEEDS_REASON.includes(action)
  async function submit() {
    setBusy(true)
    const body: Record<string, unknown> = { kind: action, effectiveOn: form.effectiveOn, idempotencyKey: `${securityId}:${action}:${crypto.randomUUID()}` }
    if (needsQuantity) body.quantity = form.quantity
    if (needsReason || form.reason.trim()) body.reason = form.reason
    if ((action === 'exercise' || action === 'repurchase' || action === 'repay') && form.considerationAccountId) body.considerationAccountId = form.considerationAccountId
    if (action === 'repurchase' && form.amount.trim()) body.amount = form.amount
    if (action === 'repurchase' && form.fairMarketValuePerShare.trim()) body.fairMarketValuePerShare = form.fairMarketValuePerShare
    if (action === 'repay') body.amount = form.amount || carrying
    if (action === 'transfer') body.transfereePartyId = form.transfereePartyId
    if (action === 'convert') {
      if (convertible) body.roundId = form.roundId
      else if (form.targetShareClassId) body.targetShareClassId = form.targetShareClassId
    }
    try {
      const result = await postJson<RecordEventResult>(`/api/equity/securities/${securityId}/events`, body, t('events.failed'))
      toast.success(isPendingApproval(result) ? t('approval.submitted') : t('events.saved', { kind: t(`eventKind.${action}`) }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('events.failed'))
    } finally {
      setBusy(false)
    }
  }
  const ready = form.effectiveOn
    && (!needsQuantity || /^\d+$/.test(form.quantity))
    && (!needsReason || form.reason.trim().length >= 5)
    && (action !== 'transfer' || form.transfereePartyId)
    && (action !== 'repurchase' || restricted || form.amount)
    && (!restrictedRepurchase || repurchaseBasis !== 'lower_of_cost_or_fmv' || form.fairMarketValuePerShare)
    && (action !== 'repay' || ((form.amount || carrying) && form.considerationAccountId))
    && (action !== 'convert' || !convertible || form.roundId)
  const help = action === 'exercise' && earlyExercise ? 'exerciseEarly'
    : restrictedRepurchase ? 'repurchaseRestricted'
      : action === 'cancel' && convertible ? 'cancelConvertible'
        : action
  return (
    <div className="space-y-4">
      <SegmentTabs value={action} onChange={setAction} label={t('drawer.actions')} tabs={actions.map((key) => ({ key, label: t(`eventKind.${key}`) }))} />
      <p className="text-sm text-slate-500 dark:text-slate-400">{t(`events.help.${help}`)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={action === 'election_83b' ? t('fields.filedOn') : t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => set('effectiveOn')(value)} /></Field>
        {needsQuantity && (
          <Field label={action === 'convert' ? t('fields.sharesToConvert') : t('fields.quantity')}>
            <Input inputMode="numeric" value={form.quantity} onChange={(e) => set('quantity')(e.target.value)} />
          </Field>
        )}
        {action === 'repurchase' && !restricted && (
          <Field label={t('fields.amountPaid')}><Input inputMode="decimal" value={form.amount} onChange={(e) => set('amount')(e.target.value)} /></Field>
        )}
        {restrictedRepurchase && (
          <Field label={t('fields.fairMarketValuePerShare')} hint={t(`repurchaseBasis.${repurchaseBasis ?? 'none'}`)}>
            <Input inputMode="decimal" value={form.fairMarketValuePerShare} onChange={(e) => set('fairMarketValuePerShare')(e.target.value)} />
          </Field>
        )}
        {action === 'repay' && (
          <Field label={t('fields.amountRepaid')} hint={carrying ? t('events.carryingHint', { amount: carrying }) : undefined}>
            <Input inputMode="decimal" value={form.amount} placeholder={carrying ?? ''} onChange={(e) => set('amount')(e.target.value)} />
          </Field>
        )}
        {(action === 'exercise' || action === 'repurchase' || action === 'repay') && (
          <Field label={t('fields.considerationAccount')}>
            <SearchSelect value={form.considerationAccountId} options={considerationAccounts} onChange={(value) => set('considerationAccountId')(value ?? '')} ariaLabel={t('fields.considerationAccount')} clearable />
          </Field>
        )}
        {action === 'transfer' && (
          <Field label={t('fields.transferee')}>
            <SearchSelect value={form.transfereePartyId} options={holders} onChange={(value) => set('transfereePartyId')(value ?? '')} ariaLabel={t('fields.transferee')} />
          </Field>
        )}
        {action === 'convert' && convertible && (
          <Field label={t('fields.round')}>
            <SearchSelect value={form.roundId} options={rounds} onChange={(value) => set('roundId')(value ?? '')} ariaLabel={t('fields.round')} />
          </Field>
        )}
        {action === 'convert' && !convertible && (
          <Field label={t('fields.targetClass')} hint={t('events.targetClassHint')}>
            <SearchSelect value={form.targetShareClassId} options={commonClasses} onChange={(value) => set('targetShareClassId')(value ?? '')} ariaLabel={t('fields.targetClass')} clearable />
          </Field>
        )}
      </div>
      {action !== 'election_83b' && <Field label={t('fields.reason')}><Textarea rows={3} value={form.reason} onChange={(e) => set('reason')(e.target.value)} /></Field>}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={busy || !ready} variant={action === 'void' || action === 'cancel' ? 'destructive' : 'default'}>{t(`eventKind.${action}`)}</Button>
      </div>
    </div>
  )
}
