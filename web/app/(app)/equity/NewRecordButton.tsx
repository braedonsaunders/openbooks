'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, SearchSelect, Textarea } from '@openbooks/ui'
import type { NewRecordData } from './view'
import { Field, SegmentTabs, postJson, withParams } from './shared'
import { DateField } from '../../../components/date-field'

type Section = 'security' | 'class' | 'plan' | 'round'
type Kind = 'share' | 'option' | 'rsu' | 'warrant' | 'safe' | 'note'

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/**
 * The page's one New action: issue a security, or record a share class, a
 * plan or a round. Each form posts to its native command, which validates
 * against the legal entity's history and posts any cash to the ledger.
 */
export function NewRecordButton({ data }: { data: NewRecordData | null }) {
  const t = useTranslations('equity')
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<Section>('security')
  if (!data) return null
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('new.open')}</Button>
      {open && (
        <Drawer open size="xl" onClose={() => setOpen(false)} title={t('new.title')} description={t('new.description')}>
          <div className="space-y-4 p-4">
            <SegmentTabs
              value={section}
              onChange={setSection}
              label={t('new.title')}
              tabs={[
                { key: 'security', label: t('new.sections.security') },
                { key: 'class', label: t('new.sections.class') },
                { key: 'plan', label: t('new.sections.plan') },
                { key: 'round', label: t('new.sections.round') },
              ]}
            />
            {section === 'security' && <IssueSecurityForm data={data} onDone={() => setOpen(false)} />}
            {section === 'class' && <ShareClassForm data={data} onDone={() => setOpen(false)} />}
            {section === 'plan' && <PlanForm data={data} onDone={() => setOpen(false)} />}
            {section === 'round' && <RoundForm data={data} onDone={() => setOpen(false)} />}
          </div>
        </Drawer>
      )}
    </>
  )
}

function useSubmit(onDone: () => void) {
  const t = useTranslations('equity')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function submit<T>(url: string, body: unknown, saved: string, next?: (result: T) => string | null) {
    setBusy(true)
    try {
      const result = await postJson<T>(url, body, t('new.failed'))
      toast.success(saved)
      onDone()
      const href = next?.(result)
      if (href) router.push(href)
      else router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('new.failed'))
    } finally {
      setBusy(false)
    }
  }
  return { busy, submit }
}

function Actions({ busy, ready, onCancel, onSubmit, label }: { busy: boolean; ready: boolean; onCancel: () => void; onSubmit: () => void; label: string }) {
  const t = useTranslations('equity')
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onCancel}>{t('actions.cancel')}</Button>
      <Button onClick={onSubmit} disabled={busy || !ready}>{label}</Button>
    </div>
  )
}

function IssueSecurityForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations('equity')
  const { busy, submit } = useSubmit(onDone)
  const [kind, setKind] = useState<Kind>('share')
  const [vesting, setVesting] = useState<'none' | 'time'>('none')
  const [form, setForm] = useState({
    holderPartyId: '', issueDate: data.context.asOf, shareClassId: '', planId: '', roundId: '', quantity: '', pricePerShare: '',
    considerationAmount: '', considerationAccountId: '', securityNumber: '', expirationDate: '', optionType: 'iso', safeType: 'post_money',
    valuationCap: '', discountPercent: '', interestRatePercent: '', interestBasis: 'simple', maturityDate: '',
    vestingStart: data.context.asOf, vestingMonths: '48', cliffMonths: '12', vestingFrequency: 'monthly', acceleration: 'none', accelerationPercent: '100',
    sharePrice: '', volatilityPercent: '', riskFreeRatePercent: '', expectedTermYears: '', dividendYieldPercent: '0', attribution: 'straight_line', memo: '',
  })
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  const shareBased = kind === 'share' || kind === 'option' || kind === 'rsu' || kind === 'warrant'
  const convertible = kind === 'safe' || kind === 'note'
  const award = kind === 'option' || kind === 'rsu'
  const vests = kind === 'share' || award
  const plans = data.plans.filter((plan) => !form.shareClassId || plan.shareClassId === form.shareClassId)
  const rounds = data.rounds.filter((round) => !form.shareClassId || round.shareClassId === form.shareClassId)
  const ready = Boolean(form.holderPartyId && form.issueDate
    && (!shareBased || (form.shareClassId && /^\d+$/.test(form.quantity)))
    && (kind !== 'option' && kind !== 'warrant' || form.pricePerShare)
    && (!convertible || (form.considerationAmount && form.considerationAccountId))
    && (!award || (form.sharePrice && (kind === 'rsu' || (form.volatilityPercent && form.riskFreeRatePercent && form.expectedTermYears))))
    && (kind !== 'note' || form.interestRatePercent))
  function issue() {
    const body: Record<string, unknown> = {
      subsidiaryId: data.context.subsidiaryId, kind, holderPartyId: form.holderPartyId, issueDate: form.issueDate,
      securityNumber: blank(form.securityNumber), memo: blank(form.memo), idempotencyKey: crypto.randomUUID(),
    }
    if (shareBased) Object.assign(body, { shareClassId: form.shareClassId, quantity: form.quantity })
    if (award && form.planId) body.planId = form.planId
    if ((kind === 'share' || kind === 'warrant') && form.roundId) body.roundId = form.roundId
    if (kind !== 'rsu' && !convertible && blank(form.pricePerShare)) body.pricePerShare = blank(form.pricePerShare)
    if (!award && blank(form.considerationAmount)) body.considerationAmount = blank(form.considerationAmount)
    if (!award && blank(form.considerationAccountId)) body.considerationAccountId = blank(form.considerationAccountId)
    if (kind === 'option') Object.assign(body, { optionType: form.optionType })
    if ((kind === 'option' || kind === 'warrant') && blank(form.expirationDate)) body.expirationDate = blank(form.expirationDate)
    if (kind === 'safe') body.safeType = form.safeType
    if (convertible) Object.assign(body, { valuationCap: blank(form.valuationCap), discountPercent: blank(form.discountPercent) })
    if (kind === 'note') Object.assign(body, { interestRatePercent: blank(form.interestRatePercent), interestBasis: form.interestBasis, maturityDate: blank(form.maturityDate) })
    if (vests && vesting === 'time') {
      Object.assign(body, {
        vestingStart: form.vestingStart, vestingMonths: Number.parseInt(form.vestingMonths, 10), cliffMonths: Number.parseInt(form.cliffMonths || '0', 10),
        vestingFrequency: form.vestingFrequency, acceleration: form.acceleration,
        accelerationPercent: form.acceleration === 'none' ? null : blank(form.accelerationPercent),
      })
    }
    if (award) {
      body.valuation = {
        sharePrice: form.sharePrice, attribution: form.attribution,
        ...(kind === 'option' ? { volatilityPercent: form.volatilityPercent, riskFreeRatePercent: form.riskFreeRatePercent, expectedTermYears: form.expectedTermYears, dividendYieldPercent: form.dividendYieldPercent || '0' } : {}),
      }
    }
    void submit<{ id: string; securityNumber: string }>('/api/equity/securities', body, t('new.securitySaved'), (result) =>
      withParams('/equity', data.context.params, { view: 'securities', security: result.id }))
  }
  return (
    <div className="space-y-4">
      <Field label={t('fields.kind')}>
        <SearchSelect
          value={kind}
          options={(['share', 'option', 'rsu', 'warrant', 'safe', 'note'] as const).map((value) => ({ value, label: t(`kind.${value}`) }))}
          onChange={(value) => setKind((value as Kind | null) ?? 'share')}
          ariaLabel={t('fields.kind')}
        />
      </Field>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t(`new.kindHelp.${kind}`)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('fields.holder')}>
          <SearchSelect value={form.holderPartyId} options={data.holders} onChange={(value) => set('holderPartyId')(value ?? '')} ariaLabel={t('fields.holder')} />
        </Field>
        <Field label={t('fields.issueDate')}><DateField value={form.issueDate} onChange={(value) => set('issueDate')(value)} /></Field>
        {shareBased && (
          <>
            <Field label={t('fields.shareClass')}>
              <SearchSelect value={form.shareClassId} options={data.classes} onChange={(value) => set('shareClassId')(value ?? '')} ariaLabel={t('fields.shareClass')} />
            </Field>
            <Field label={t('fields.quantity')}><Input inputMode="numeric" value={form.quantity} onChange={(e) => set('quantity')(e.target.value)} /></Field>
          </>
        )}
        {award && (
          <Field label={t('fields.plan')}>
            <SearchSelect value={form.planId} options={plans} onChange={(value) => set('planId')(value ?? '')} ariaLabel={t('fields.plan')} clearable />
          </Field>
        )}
        {(kind === 'share' || kind === 'warrant') && (
          <Field label={t('fields.round')}>
            <SearchSelect value={form.roundId} options={rounds} onChange={(value) => set('roundId')(value ?? '')} ariaLabel={t('fields.round')} clearable />
          </Field>
        )}
        {(kind === 'share' || kind === 'option' || kind === 'warrant') && (
          <Field label={kind === 'share' ? t('fields.pricePerShare') : t('fields.exercisePrice')}>
            <Input inputMode="decimal" value={form.pricePerShare} onChange={(e) => set('pricePerShare')(e.target.value)} />
          </Field>
        )}
        {!award && (
          <>
            <Field label={convertible ? t('fields.principal') : t('fields.consideration')} hint={kind === 'share' ? t('new.considerationHint') : undefined}>
              <Input inputMode="decimal" value={form.considerationAmount} onChange={(e) => set('considerationAmount')(e.target.value)} />
            </Field>
            <Field label={t('fields.considerationAccount')}>
              <SearchSelect value={form.considerationAccountId} options={data.considerationAccounts} onChange={(value) => set('considerationAccountId')(value ?? '')} ariaLabel={t('fields.considerationAccount')} clearable />
            </Field>
          </>
        )}
        {kind === 'option' && (
          <Field label={t('fields.optionType')}>
            <SearchSelect value={form.optionType} options={[{ value: 'iso', label: t('optionType.iso') }, { value: 'nso', label: t('optionType.nso') }]} onChange={(value) => set('optionType')(value ?? 'iso')} ariaLabel={t('fields.optionType')} />
          </Field>
        )}
        {(kind === 'option' || kind === 'warrant') && (
          <Field label={t('fields.expirationDate')}><DateField value={form.expirationDate} onChange={(value) => set('expirationDate')(value)} /></Field>
        )}
        {kind === 'safe' && (
          <Field label={t('fields.safeType')}>
            <SearchSelect value={form.safeType} options={[{ value: 'post_money', label: t('safeType.post_money') }, { value: 'pre_money', label: t('safeType.pre_money') }]} onChange={(value) => set('safeType')(value ?? 'post_money')} ariaLabel={t('fields.safeType')} />
          </Field>
        )}
        {convertible && (
          <>
            <Field label={t('fields.valuationCap')}><Input inputMode="decimal" value={form.valuationCap} onChange={(e) => set('valuationCap')(e.target.value)} /></Field>
            <Field label={t('fields.discountPercent')}><Input inputMode="decimal" value={form.discountPercent} onChange={(e) => set('discountPercent')(e.target.value)} /></Field>
          </>
        )}
        {kind === 'note' && (
          <>
            <Field label={t('fields.interestRatePercent')}><Input inputMode="decimal" value={form.interestRatePercent} onChange={(e) => set('interestRatePercent')(e.target.value)} /></Field>
            <Field label={t('fields.interestBasis')}>
              <SearchSelect value={form.interestBasis} options={[{ value: 'simple', label: t('interestBasis.simple') }, { value: 'compound_annual', label: t('interestBasis.compound_annual') }]} onChange={(value) => set('interestBasis')(value ?? 'simple')} ariaLabel={t('fields.interestBasis')} />
            </Field>
            <Field label={t('fields.maturityDate')}><DateField value={form.maturityDate} onChange={(value) => set('maturityDate')(value)} /></Field>
          </>
        )}
        <Field label={t('fields.securityNumber')} hint={t('new.numberHint')}><Input value={form.securityNumber} onChange={(e) => set('securityNumber')(e.target.value)} /></Field>
      </div>
      {vests && (
        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <SegmentTabs value={vesting} onChange={setVesting} label={t('new.vesting')} tabs={[{ key: 'none', label: t('new.vestingNone') }, { key: 'time', label: t('new.vestingTime') }]} />
          {vesting === 'time' && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label={t('fields.vestingStart')}><DateField value={form.vestingStart} onChange={(value) => set('vestingStart')(value)} /></Field>
              <Field label={t('fields.vestingMonths')}><Input inputMode="numeric" value={form.vestingMonths} onChange={(e) => set('vestingMonths')(e.target.value)} /></Field>
              <Field label={t('fields.cliffMonths')}><Input inputMode="numeric" value={form.cliffMonths} onChange={(e) => set('cliffMonths')(e.target.value)} /></Field>
              <Field label={t('fields.vestingFrequency')}>
                <SearchSelect value={form.vestingFrequency} options={(['monthly', 'quarterly', 'annual'] as const).map((value) => ({ value, label: t(`frequency.${value}`) }))} onChange={(value) => set('vestingFrequency')(value ?? 'monthly')} ariaLabel={t('fields.vestingFrequency')} />
              </Field>
              <Field label={t('fields.acceleration')}>
                <SearchSelect value={form.acceleration} options={(['none', 'single', 'double'] as const).map((value) => ({ value, label: t(`acceleration.${value}`) }))} onChange={(value) => set('acceleration')(value ?? 'none')} ariaLabel={t('fields.acceleration')} />
              </Field>
              {form.acceleration !== 'none' && (
                <Field label={t('fields.accelerationPercent')}><Input inputMode="decimal" value={form.accelerationPercent} onChange={(e) => set('accelerationPercent')(e.target.value)} /></Field>
              )}
            </div>
          )}
        </section>
      )}
      {award && (
        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold">{t('new.valuation')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{kind === 'option' ? t('new.valuationOption') : t('new.valuationRsu')}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label={t('fields.grantSharePrice')}><Input inputMode="decimal" value={form.sharePrice} onChange={(e) => set('sharePrice')(e.target.value)} /></Field>
            {kind === 'option' && (
              <>
                <Field label={t('fields.volatilityPercent')}><Input inputMode="decimal" value={form.volatilityPercent} onChange={(e) => set('volatilityPercent')(e.target.value)} /></Field>
                <Field label={t('fields.riskFreeRatePercent')}><Input inputMode="decimal" value={form.riskFreeRatePercent} onChange={(e) => set('riskFreeRatePercent')(e.target.value)} /></Field>
                <Field label={t('fields.expectedTermYears')}><Input inputMode="decimal" value={form.expectedTermYears} onChange={(e) => set('expectedTermYears')(e.target.value)} /></Field>
                <Field label={t('fields.dividendYieldPercent')}><Input inputMode="decimal" value={form.dividendYieldPercent} onChange={(e) => set('dividendYieldPercent')(e.target.value)} /></Field>
              </>
            )}
            <Field label={t('fields.attribution')}>
              <SearchSelect value={form.attribution} options={[{ value: 'straight_line', label: t('attribution.straight_line') }, { value: 'graded', label: t('attribution.graded') }]} onChange={(value) => set('attribution')(value ?? 'straight_line')} ariaLabel={t('fields.attribution')} />
            </Field>
          </div>
        </section>
      )}
      <Field label={t('fields.memo')}><Textarea rows={2} value={form.memo} onChange={(e) => set('memo')(e.target.value)} /></Field>
      <Actions busy={busy} ready={ready} onCancel={onDone} onSubmit={issue} label={t('new.issue')} />
    </div>
  )
}

function ShareClassForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations('equity')
  const { busy, submit } = useSubmit(onDone)
  const [form, setForm] = useState({
    code: '', name: '', kind: 'common', effectiveOn: data.context.asOf, authorizedShares: '', parValue: '0.0001', originalIssuePrice: '',
    conversionPrice: '', liquidationMultiple: '1', participation: 'none', participationCapMultiple: '', seniority: '0', antiDilution: 'none',
  })
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  const preferred = form.kind === 'preferred'
  const ready = Boolean(form.code && form.name && form.effectiveOn && /^\d+$/.test(form.authorizedShares) && form.parValue && (!preferred || form.originalIssuePrice))
  function create() {
    void submit('/api/equity/classes', {
      subsidiaryId: data.context.subsidiaryId, code: form.code, name: form.name, kind: form.kind, effectiveOn: form.effectiveOn,
      authorizedShares: form.authorizedShares, parValue: form.parValue,
      ...(preferred ? {
        originalIssuePrice: form.originalIssuePrice, conversionPrice: blank(form.conversionPrice), liquidationMultiple: blank(form.liquidationMultiple),
        participation: form.participation, participationCapMultiple: form.participation === 'capped' ? blank(form.participationCapMultiple) : null,
        seniority: Number.parseInt(form.seniority || '0', 10), antiDilution: form.antiDilution,
      } : {}),
    }, t('new.classSaved'))
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('fields.code')}><Input value={form.code} onChange={(e) => set('code')(e.target.value)} placeholder="CS" /></Field>
        <Field label={t('fields.name')}><Input value={form.name} onChange={(e) => set('name')(e.target.value)} /></Field>
        <Field label={t('fields.classKind')}>
          <SearchSelect value={form.kind} options={[{ value: 'common', label: t('classKind.common') }, { value: 'preferred', label: t('classKind.preferred') }]} onChange={(value) => set('kind')(value ?? 'common')} ariaLabel={t('fields.classKind')} />
        </Field>
        <Field label={t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => set('effectiveOn')(value)} /></Field>
        <Field label={t('fields.authorizedShares')}><Input inputMode="numeric" value={form.authorizedShares} onChange={(e) => set('authorizedShares')(e.target.value)} /></Field>
        <Field label={t('fields.parValue')}><Input inputMode="decimal" value={form.parValue} onChange={(e) => set('parValue')(e.target.value)} /></Field>
        {preferred && (
          <>
            <Field label={t('fields.originalIssuePrice')}><Input inputMode="decimal" value={form.originalIssuePrice} onChange={(e) => set('originalIssuePrice')(e.target.value)} /></Field>
            <Field label={t('fields.conversionPrice')} hint={t('new.conversionPriceHint')}><Input inputMode="decimal" value={form.conversionPrice} onChange={(e) => set('conversionPrice')(e.target.value)} /></Field>
            <Field label={t('fields.liquidationMultiple')}><Input inputMode="decimal" value={form.liquidationMultiple} onChange={(e) => set('liquidationMultiple')(e.target.value)} /></Field>
            <Field label={t('fields.seniority')} hint={t('new.seniorityHint')}><Input inputMode="numeric" value={form.seniority} onChange={(e) => set('seniority')(e.target.value)} /></Field>
            <Field label={t('fields.participation')}>
              <SearchSelect value={form.participation} options={(['none', 'full', 'capped'] as const).map((value) => ({ value, label: t(`participation.${value}`) }))} onChange={(value) => set('participation')(value ?? 'none')} ariaLabel={t('fields.participation')} />
            </Field>
            {form.participation === 'capped' && (
              <Field label={t('fields.participationCapMultiple')}><Input inputMode="decimal" value={form.participationCapMultiple} onChange={(e) => set('participationCapMultiple')(e.target.value)} /></Field>
            )}
            <Field label={t('fields.antiDilution')}>
              <SearchSelect value={form.antiDilution} options={(['none', 'broad_based', 'narrow_based', 'full_ratchet'] as const).map((value) => ({ value, label: t(`antiDilution.${value}`) }))} onChange={(value) => set('antiDilution')(value ?? 'none')} ariaLabel={t('fields.antiDilution')} />
            </Field>
          </>
        )}
      </div>
      <Actions busy={busy} ready={ready} onCancel={onDone} onSubmit={create} label={t('new.createClass')} />
    </div>
  )
}

function PlanForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations('equity')
  const { busy, submit } = useSubmit(onDone)
  const [form, setForm] = useState({ code: '', name: '', shareClassId: '', effectiveOn: data.context.asOf, reservedShares: '', recycleForfeited: true, recycleExpired: true, recycleRepurchased: false })
  const ready = Boolean(form.code && form.name && form.shareClassId && form.effectiveOn && /^\d+$/.test(form.reservedShares))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('fields.code')}><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="EIP" /></Field>
        <Field label={t('fields.name')}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={t('fields.shareClass')}>
          <SearchSelect value={form.shareClassId} options={data.classes} onChange={(value) => setForm({ ...form, shareClassId: value ?? '' })} ariaLabel={t('fields.shareClass')} />
        </Field>
        <Field label={t('fields.effectiveOn')}><DateField value={form.effectiveOn} onChange={(value) => setForm({ ...form, effectiveOn: value })} /></Field>
        <Field label={t('fields.reservedShares')}><Input inputMode="numeric" value={form.reservedShares} onChange={(e) => setForm({ ...form, reservedShares: e.target.value })} /></Field>
      </div>
      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">{t('new.recycling')}</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.recycleForfeited} onChange={(e) => setForm({ ...form, recycleForfeited: e.target.checked })} />{t('plans.recycle.forfeited')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.recycleExpired} onChange={(e) => setForm({ ...form, recycleExpired: e.target.checked })} />{t('plans.recycle.expired')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.recycleRepurchased} onChange={(e) => setForm({ ...form, recycleRepurchased: e.target.checked })} />{t('plans.recycle.repurchased')}</label>
      </fieldset>
      <Actions busy={busy} ready={ready} onCancel={onDone} onSubmit={() => void submit('/api/equity/plans', { subsidiaryId: data.context.subsidiaryId, ...form }, t('new.planSaved'))} label={t('new.createPlan')} />
    </div>
  )
}

function RoundForm({ data, onDone }: { data: NewRecordData; onDone: () => void }) {
  const t = useTranslations('equity')
  const { busy, submit } = useSubmit(onDone)
  const [form, setForm] = useState({ name: '', shareClassId: '', closedOn: data.context.asOf, pricePerShare: '', preMoneyValuation: '' })
  const ready = Boolean(form.name && form.shareClassId && form.closedOn && form.pricePerShare && form.preMoneyValuation)
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('new.roundHelp')}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('fields.name')}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Series A" /></Field>
        <Field label={t('fields.shareClass')}>
          <SearchSelect value={form.shareClassId} options={data.classes} onChange={(value) => setForm({ ...form, shareClassId: value ?? '' })} ariaLabel={t('fields.shareClass')} />
        </Field>
        <Field label={t('fields.closedOn')}><DateField value={form.closedOn} onChange={(value) => setForm({ ...form, closedOn: value })} /></Field>
        <Field label={t('fields.pricePerShare')}><Input inputMode="decimal" value={form.pricePerShare} onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })} /></Field>
        <Field label={t('fields.preMoneyValuation')}><Input inputMode="decimal" value={form.preMoneyValuation} onChange={(e) => setForm({ ...form, preMoneyValuation: e.target.value })} /></Field>
      </div>
      <Actions busy={busy} ready={ready} onCancel={onDone} onSubmit={() => void submit('/api/equity/rounds', { subsidiaryId: data.context.subsidiaryId, ...form }, t('new.roundSaved'))} label={t('new.createRound')} />
    </div>
  )
}
