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
import { Field, LINK, STATUS_VARIANT, SegmentTabs, Stat, percentText, postJson, priceText, useShares, withParams } from './shared'
import { DateField } from '@/components/date-field'

type ActionKind = 'exercise' | 'settle' | 'forfeit' | 'expire' | 'cancel' | 'transfer' | 'convert' | 'repurchase' | 'void'

const MANAGE_ACTIONS: Record<string, ActionKind[]> = {
  option: ['exercise', 'forfeit', 'expire', 'cancel'],
  rsu: ['settle', 'forfeit', 'cancel'],
  warrant: ['exercise', 'expire', 'cancel', 'transfer'],
  share: ['transfer', 'convert'],
  safe: ['convert'],
  note: ['convert'],
}
const APPROVE_ACTIONS: Record<string, ActionKind[]> = {
  option: ['void'], rsu: ['void'], warrant: ['void'], share: ['repurchase', 'void'], safe: ['void'], note: ['void'],
}
const NEEDS_REASON: ActionKind[] = ['forfeit', 'expire', 'cancel', 'repurchase', 'void']

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/**
 * One security: its terms, its state on the as-of date, its vesting
 * schedule, its history with the journal entries it posted, and the events
 * it admits for the reader's duties. Overview, vesting, history and actions
 * are sibling tabs; one body shows at a time.
 */
export function SecurityDrawer({ context, detail, closeHref, holders, rounds, commonClasses, considerationAccounts }: SecurityDrawerData) {
  const t = useTranslations('equity')
  const shares = useShares()
  const { money } = useMoney()
  const s = detail.security
  const kind = String(s.kind)
  const status = detail.state?.status ?? detail.convertible?.status ?? 'outstanding'
  const live = status !== 'void' && status !== 'converted'
  const actions = live
    ? [...(context.canManage ? MANAGE_ACTIONS[kind] ?? [] : []), ...(context.canApprove ? APPROVE_ACTIONS[kind] ?? [] : [])]
      .filter((action) => !(action === 'convert' && kind === 'share' && detail.shareClass?.kind !== 'preferred'))
    : []
  const [panel, setPanel] = useState<'overview' | 'vesting' | 'history' | 'actions'>('overview')
  const currency = String(s.currency)
  const amount = (value: unknown) => (str(value) ? money(String(value), { currency }) : '—')
  const terms: [string, string][] = [
    [t('fields.holder'), detail.holderName],
    [t('fields.kind'), t(`kind.${kind}`)],
    [t('fields.issueDate'), String(s.issue_date)],
    ...(detail.shareClass ? [[t('fields.shareClass'), `${detail.shareClass.code} · ${detail.shareClass.name}`] as [string, string]] : []),
    ...(detail.plan ? [[t('fields.plan'), `${detail.plan.code} · ${detail.plan.name}`] as [string, string]] : []),
    ...(detail.round ? [[t('fields.round'), detail.round.name] as [string, string]] : []),
    ...(str(s.quantity) ? [[t('fields.quantityIssued'), shares(String(s.quantity))] as [string, string]] : []),
    ...(detail.exercisePrice ? [[t('fields.exercisePrice'), priceText(detail.exercisePrice)] as [string, string]] : []),
    ...(kind === 'share' && str(s.price_per_share) ? [[t('fields.pricePerShare'), priceText(String(s.price_per_share))] as [string, string]] : []),
    ...(str(s.consideration_amount) ? [[kind === 'safe' || kind === 'note' ? t('fields.principal') : t('fields.consideration'), amount(s.consideration_amount)] as [string, string]] : []),
    ...(str(s.option_type) ? [[t('fields.optionType'), t(`optionType.${String(s.option_type)}`)] as [string, string]] : []),
    ...(str(s.expiration_date) ? [[t('fields.expirationDate'), String(s.expiration_date)] as [string, string]] : []),
    ...(str(s.safe_type) ? [[t('fields.safeType'), t(`safeType.${String(s.safe_type)}`)] as [string, string]] : []),
    ...(str(s.valuation_cap) ? [[t('fields.valuationCap'), amount(s.valuation_cap)] as [string, string]] : []),
    ...(str(s.discount_percent) ? [[t('fields.discountPercent'), percentText(String(s.discount_percent))] as [string, string]] : []),
    ...(str(s.interest_rate_percent) ? [[t('fields.interestRatePercent'), `${percentText(String(s.interest_rate_percent))} · ${t(`interestBasis.${String(s.interest_basis)}`)}`] as [string, string]] : []),
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
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{String(s.security_number)}</span>
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{t(`status.${status}`)}</Badge>
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
          {detail.compensation && (
            <>
              <Stat label={t('drawer.grantValue')} value={amount(detail.compensation.total)} />
              <Stat label={t('drawer.recognized')} value={amount(detail.compensation.recognized)} />
              <Stat label={t('drawer.posted')} value={amount(detail.compensation.posted)} />
            </>
          )}
        </section>
        <DrawerTabStrip
          ariaLabel={t('drawer.tabs')}
          activeKey={panel}
          onSelect={setPanel}
          tabs={[
            { key: 'overview' as const, label: t('drawer.overview') },
            { key: 'vesting' as const, label: t('drawer.vesting'), count: detail.vesting.length, disabled: detail.vesting.length === 0 },
            { key: 'history' as const, label: t('drawer.history'), count: detail.events.length },
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
            {detail.source && (
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('drawer.eventDate')}</TableHead>
                  <TableHead>{t('drawer.eventKind')}</TableHead>
                  <TableHead className="text-right">{t('drawer.eventQuantity')}</TableHead>
                  <TableHead className="text-right">{t('drawer.eventAmount')}</TableHead>
                  <TableHead>{t('drawer.eventEntry')}</TableHead>
                  <TableHead>{t('drawer.eventReason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.events.map((event) => (
                  <TableRow key={String(event.id)}>
                    <TableCell className="font-mono">{String(event.effective_on)}</TableCell>
                    <TableCell>{t(`eventKind.${String(event.kind)}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{str(event.quantity) ? shares(String(event.quantity)) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{amount(event.amount)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {str(event.journal_entry_id) && <Link className={LINK} href={`/journal?entry=${String(event.journal_entry_id)}`}>{str(event.journal_entry_number) ?? t('drawer.viewEntry')}</Link>}
                      {str(event.reversal_entry_id) && <Link className={LINK} href={`/journal?entry=${String(event.reversal_entry_id)}`}>{str(event.reversal_entry_number) ?? t('drawer.viewEntry')}</Link>}
                    </TableCell>
                    <TableCell className="text-sm">{str(event.reason) ?? ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        )}
        {panel === 'actions' && actions.length > 0 && (
          <ActionForm
            securityId={String(s.id)}
            convertible={kind === 'safe' || kind === 'note'}
            actions={actions}
            asOf={context.asOf}
            holders={holders}
            rounds={rounds}
            commonClasses={commonClasses}
            considerationAccounts={considerationAccounts}
          />
        )}
      </div>
    </UrlDrawer>
  )
}

function ActionForm({ securityId, convertible, actions, asOf, holders, rounds, commonClasses, considerationAccounts }: {
  securityId: string
  /** SAFEs and notes convert in a round; preferred shares convert into a common class. */
  convertible: boolean
  actions: ActionKind[]
  asOf: string
  holders: { value: string; label: string }[]
  rounds: { value: string; label: string }[]
  commonClasses: { value: string; label: string }[]
  considerationAccounts: { value: string; label: string }[]
}) {
  const t = useTranslations('equity')
  const router = useRouter()
  const [action, setAction] = useState<ActionKind>(actions[0]!)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ effectiveOn: asOf, quantity: '', amount: '', considerationAccountId: '', transfereePartyId: '', roundId: '', targetShareClassId: '', reason: '' })
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  const needsQuantity = !(action === 'void' || (action === 'convert' && convertible))
  async function submit() {
    setBusy(true)
    const approval = action === 'repurchase' || action === 'void'
    const body: Record<string, unknown> = { kind: action, effectiveOn: form.effectiveOn, idempotencyKey: `${securityId}:${action}:${crypto.randomUUID()}` }
    if (needsQuantity) body.quantity = form.quantity
    if (NEEDS_REASON.includes(action) || form.reason.trim()) body.reason = form.reason
    if ((action === 'exercise' || action === 'repurchase') && form.considerationAccountId) body.considerationAccountId = form.considerationAccountId
    if (action === 'repurchase') body.amount = form.amount
    if (action === 'transfer') body.transfereePartyId = form.transfereePartyId
    if (action === 'convert') {
      if (convertible) body.roundId = form.roundId
      else body.targetShareClassId = form.targetShareClassId
    }
    try {
      await postJson<RecordEventResult>(`/api/equity/securities/${securityId}/${approval ? 'approvals' : 'events'}`, body, t('events.failed'))
      toast.success(t('events.saved', { kind: t(`eventKind.${action}`) }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('events.failed'))
    } finally {
      setBusy(false)
    }
  }
  const ready = form.effectiveOn
    && (!needsQuantity || /^\d+$/.test(form.quantity))
    && (!NEEDS_REASON.includes(action) || form.reason.trim().length >= 5)
    && (action !== 'transfer' || form.transfereePartyId)
    && (action !== 'repurchase' || form.amount)
    && (action !== 'convert' || (convertible ? form.roundId : form.targetShareClassId))
  return (
    <div className="space-y-4">
      <SegmentTabs value={action} onChange={setAction} label={t('drawer.actions')} tabs={actions.map((key) => ({ key, label: t(`eventKind.${key}`) }))} />
      <p className="text-sm text-slate-500 dark:text-slate-400">{t(`events.help.${action}`)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => set('effectiveOn')(value)} /></Field>
        {needsQuantity && (
          <Field label={action === 'convert' ? t('fields.sharesToConvert') : t('fields.quantity')}>
            <Input inputMode="numeric" value={form.quantity} onChange={(e) => set('quantity')(e.target.value)} />
          </Field>
        )}
        {action === 'repurchase' && (
          <Field label={t('fields.amountPaid')}><Input inputMode="decimal" value={form.amount} onChange={(e) => set('amount')(e.target.value)} /></Field>
        )}
        {(action === 'exercise' || action === 'repurchase') && (
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
          <Field label={t('fields.targetClass')}>
            <SearchSelect value={form.targetShareClassId} options={commonClasses} onChange={(value) => set('targetShareClassId')(value ?? '')} ariaLabel={t('fields.targetClass')} />
          </Field>
        )}
      </div>
      <Field label={t('fields.reason')}><Textarea rows={3} value={form.reason} onChange={(e) => set('reason')(e.target.value)} /></Field>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={busy || !ready} variant={action === 'void' ? 'destructive' : 'default'}>{t(`eventKind.${action}`)}</Button>
      </div>
    </div>
  )
}
