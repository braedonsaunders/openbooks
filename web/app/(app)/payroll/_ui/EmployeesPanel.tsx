'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'

export interface ScheduleOption {
  id: string
  name: string
  frequency: string
}

/** A payroll program/EIN account the employee can be filed and remitted under. */
export interface FilingAccountOption {
  id: string
  accountNumber: string
  name: string
  country: 'CA' | 'US'
}

export interface ProfileRow {
  id: string
  employee_party_id: string
  employee_name: string
  pay_schedule_id: string
  schedule_name: string | null
  country: 'CA' | 'US'
  province: string
  pay_basis: 'hourly' | 'salary'
  federal_claim_code: number | null
  federal_claim_amount: string | null
  provincial_claim_code: number | null
  provincial_claim_amount: string | null
  additional_tax_per_period: string | null
  cpp_exempt: boolean
  ei_exempt: boolean
  tax_exempt: boolean
  filing_status: 'single' | 'married_joint' | 'head_household' | null
  multiple_jobs: boolean
  dependent_credits: string | null
  other_income_annual: string | null
  deductions_annual: string | null
  w4_pre_2020: boolean
  w4_allowances: number | null
  fica_exempt: boolean
  futa_exempt: boolean
  vacation_percent: string | null
  vacation_method: 'accrue' | 'pay_each_period'
  filing_account_id: string | null
  stub_delivery: 'email' | 'print' | 'both'
  /** Payroll override of the pay rail; null inherits the party preference. */
  payment_method: 'eft' | 'cheque' | null
  is_active: boolean
}

const STUB_DELIVERIES = ['email', 'print', 'both'] as const
const PAYMENT_METHODS = ['eft', 'cheque'] as const

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT', 'ZZ'] as const
const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
] as const
const FILING_STATUSES = ['single', 'married_joint', 'head_household'] as const

export function ProfileEditor(props: {
  profile: ProfileRow
  schedules: ScheduleOption[]
  /** Empty for single-account employers: the country pack's default is used. */
  filingAccounts?: FilingAccountOption[]
  onClose: () => void
  onSaved: () => void
  /** Render as a plain section (inside another drawer/tab) instead of a Drawer. */
  inline?: boolean
}) {
  const t = useTranslations('payroll.profiles')
  const p = props.profile
  const [busy, setBusy] = useState(false)
  const [payScheduleId, setPayScheduleId] = useState(p.pay_schedule_id)
  const [country, setCountry] = useState<'CA' | 'US'>(p.country === 'US' ? 'US' : 'CA')
  const [province, setProvince] = useState(p.province)
  const [payBasis, setPayBasis] = useState<'hourly' | 'salary'>(p.pay_basis)
  const [federalClaimCode, setFederalClaimCode] = useState(p.federal_claim_code == null ? '' : String(p.federal_claim_code))
  const [federalClaimAmount, setFederalClaimAmount] = useState(p.federal_claim_amount ?? '')
  const [provincialClaimCode, setProvincialClaimCode] = useState(p.provincial_claim_code == null ? '' : String(p.provincial_claim_code))
  const [provincialClaimAmount, setProvincialClaimAmount] = useState(p.provincial_claim_amount ?? '')
  const [additionalTax, setAdditionalTax] = useState(p.additional_tax_per_period ?? '')
  const [cppExempt, setCppExempt] = useState(p.cpp_exempt)
  const [eiExempt, setEiExempt] = useState(p.ei_exempt)
  const [taxExempt, setTaxExempt] = useState(p.tax_exempt)
  const [filingStatus, setFilingStatus] = useState<ProfileRow['filing_status']>(p.filing_status)
  const [multipleJobs, setMultipleJobs] = useState(p.multiple_jobs)
  const [dependentCredits, setDependentCredits] = useState(p.dependent_credits ?? '')
  const [otherIncomeAnnual, setOtherIncomeAnnual] = useState(p.other_income_annual ?? '')
  const [deductionsAnnual, setDeductionsAnnual] = useState(p.deductions_annual ?? '')
  const [w4Pre2020, setW4Pre2020] = useState(p.w4_pre_2020)
  const [w4Allowances, setW4Allowances] = useState(p.w4_allowances == null ? '' : String(p.w4_allowances))
  const [ficaExempt, setFicaExempt] = useState(p.fica_exempt)
  const [futaExempt, setFutaExempt] = useState(p.futa_exempt)
  const [vacationPercent, setVacationPercent] = useState(p.vacation_percent ?? '')
  const [vacationMethod, setVacationMethod] = useState<'accrue' | 'pay_each_period'>(p.vacation_method)
  const [isActive, setIsActive] = useState(p.is_active)
  const [sin, setSin] = useState('')
  const [filingAccountId, setFilingAccountId] = useState(p.filing_account_id ?? '')
  const [stubDelivery, setStubDelivery] = useState<ProfileRow['stub_delivery']>(p.stub_delivery ?? 'email')
  const [paymentMethod, setPaymentMethod] = useState<string>(p.payment_method ?? '')
  // Accounts file under one country pack, so only the employee's own apply.
  const filingAccounts = (props.filingAccounts ?? []).filter((account) => account.country === country)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeePartyId: p.employee_party_id,
          ...(sin.trim() ? { sin: sin.trim() } : {}),
          payScheduleId,
          country,
          province,
          payBasis,
          federalClaimCode: federalClaimCode === '' ? null : Number(federalClaimCode),
          federalClaimAmount: federalClaimAmount || null,
          provincialClaimCode: provincialClaimCode === '' ? null : Number(provincialClaimCode),
          provincialClaimAmount: provincialClaimAmount || null,
          additionalTaxPerPeriod: additionalTax || null,
          cppExempt,
          eiExempt,
          taxExempt,
          filingStatus: country === 'US' ? (filingStatus ?? 'single') : null,
          multipleJobs,
          dependentCredits: dependentCredits || null,
          otherIncomeAnnual: otherIncomeAnnual || null,
          deductionsAnnual: deductionsAnnual || null,
          w4Pre2020,
          w4Allowances: w4Allowances === '' ? null : Number(w4Allowances),
          ficaExempt,
          futaExempt,
          vacationPercent: vacationPercent || null,
          vacationMethod,
          filingAccountId: filingAccountId || null,
          stubDelivery,
          paymentMethod: paymentMethod || null,
          isActive,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('saved'))
      props.onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const claimCodes = ['', ...Array.from({ length: 11 }, (_, i) => String(i))]

  const footer = (
    <div className="flex justify-end gap-2">
      {!props.inline && (
        <Button variant="ghost" onClick={props.onClose} disabled={busy}>
          {t('cancel')}
        </Button>
      )}
      <Button onClick={save} disabled={busy || !payScheduleId}>
        {t('save')}
      </Button>
    </div>
  )
  const body = (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-sin">{t('fields.sin')}</Label>
            <Input
              id="pp-sin"
              value={sin}
              onChange={(e) => setSin(e.target.value)}
              placeholder={(p as { sin_last3?: string | null }).sin_last3
                ? `••• ••• ${(p as { sin_last3?: string | null }).sin_last3}`
                : t('fields.sinPlaceholder')}
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="pp-schedule">{t('fields.schedule')}</Label>
            <Select id="pp-schedule" value={payScheduleId} onChange={(e) => setPayScheduleId(e.target.value)}>
              <option value="">—</option>
              {props.schedules.map((schedule) => (
                <option key={schedule.id} value={schedule.id}>
                  {schedule.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-country">{t('fields.country')}</Label>
            <Select
              id="pp-country"
              value={country}
              onChange={(e) => {
                const next = e.target.value === 'US' ? 'US' : 'CA'
                setCountry(next)
                setProvince(next === 'US' ? 'TX' : 'ON')
                // Filing accounts belong to one country pack.
                setFilingAccountId('')
              }}
            >
              <option value="CA">{t('country.CA')}</option>
              <option value="US">{t('country.US')}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-province">
              {country === 'US' ? t('fields.state') : t('fields.province')}
            </Label>
            <Select id="pp-province" value={province} onChange={(e) => setProvince(e.target.value)}>
              {(country === 'US' ? US_STATES : PROVINCES).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-basis">{t('fields.payBasis')}</Label>
            <Select id="pp-basis" value={payBasis} onChange={(e) => setPayBasis(e.target.value as 'hourly' | 'salary')}>
              <option value="hourly">{t('basis.hourly')}</option>
              <option value="salary">{t('basis.salary')}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-additional">{t('fields.additionalTax')}</Label>
            <Input
              id="pp-additional"
              inputMode="decimal"
              value={additionalTax}
              onChange={(e) => setAdditionalTax(e.target.value)}
              placeholder="0.00"
            />
          </div>
          {/* Only offered once the employer keeps more than the default
              account; a single-account employer needs no choice. */}
          {filingAccounts.length > 0 && (
            <div>
              <Label htmlFor="pp-filing-account">{t('fields.filingAccount')}</Label>
              <Select
                id="pp-filing-account"
                value={filingAccountId}
                onChange={(e) => setFilingAccountId(e.target.value)}
              >
                <option value="">{t('filingAccountDefault')}</option>
                {filingAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountNumber} · {account.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="pp-stub-delivery">{t('fields.stubDelivery')}</Label>
            <Select
              id="pp-stub-delivery"
              value={stubDelivery}
              onChange={(e) => setStubDelivery(e.target.value as ProfileRow['stub_delivery'])}
            >
              {STUB_DELIVERIES.map((option) => (
                <option key={option} value={option}>
                  {t(`stubDelivery.${option}`)}
                </option>
              ))}
            </Select>
          </div>
          {/* The rail. Blank inherits the party's standing preference, which
              itself falls back to "EFT if there are approved bank details,
              otherwise cheque" — so this is only set to override that. */}
          <div>
            <Label htmlFor="pp-payment-method">{t('fields.paymentMethod')}</Label>
            <Select
              id="pp-payment-method"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
            >
              <option value="">{t('paymentMethod.inherit')}</option>
              {PAYMENT_METHODS.map((option) => (
                <option key={option} value={option}>
                  {t(`paymentMethod.${option}`)}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t('paymentMethod.help')}
            </p>
          </div>
        </div>

        {country === 'US' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pp-filing-status">{t('fields.filingStatus')}</Label>
              <Select
                id="pp-filing-status"
                value={filingStatus ?? 'single'}
                onChange={(e) => setFilingStatus(e.target.value as ProfileRow['filing_status'])}
              >
                {FILING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`filingStatus.${status}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="pp-dependent-credits">{t('fields.dependentCredits')}</Label>
              <Input
                id="pp-dependent-credits"
                inputMode="decimal"
                value={dependentCredits}
                onChange={(e) => setDependentCredits(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label htmlFor="pp-other-income">{t('fields.otherIncomeAnnual')}</Label>
              <Input
                id="pp-other-income"
                inputMode="decimal"
                value={otherIncomeAnnual}
                onChange={(e) => setOtherIncomeAnnual(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label htmlFor="pp-deductions">{t('fields.deductionsAnnual')}</Label>
              <Input
                id="pp-deductions"
                inputMode="decimal"
                value={deductionsAnnual}
                onChange={(e) => setDeductionsAnnual(e.target.value)}
                placeholder="0.00"
              />
            </div>
            {w4Pre2020 ? (
              <div>
                <Label htmlFor="pp-allowances">{t('fields.w4Allowances')}</Label>
                <Input
                  id="pp-allowances"
                  inputMode="numeric"
                  value={w4Allowances}
                  onChange={(e) => setW4Allowances(e.target.value)}
                  placeholder="0"
                />
              </div>
            ) : null}
          </div>
        ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-fed-code">{t('fields.federalClaimCode')}</Label>
            <Select id="pp-fed-code" value={federalClaimCode} onChange={(e) => setFederalClaimCode(e.target.value)}>
              {claimCodes.map((code) => (
                <option key={code} value={code}>
                  {code === '' ? '—' : code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-fed-amount">{t('fields.federalClaimAmount')}</Label>
            <Input
              id="pp-fed-amount"
              inputMode="decimal"
              value={federalClaimAmount}
              onChange={(e) => setFederalClaimAmount(e.target.value)}
              placeholder={t('fields.claimAmountHint')}
            />
          </div>
          <div>
            <Label htmlFor="pp-prov-code">{t('fields.provincialClaimCode')}</Label>
            <Select id="pp-prov-code" value={provincialClaimCode} onChange={(e) => setProvincialClaimCode(e.target.value)}>
              {claimCodes.map((code) => (
                <option key={code} value={code}>
                  {code === '' ? '—' : code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pp-prov-amount">{t('fields.provincialClaimAmount')}</Label>
            <Input
              id="pp-prov-amount"
              inputMode="decimal"
              value={provincialClaimAmount}
              onChange={(e) => setProvincialClaimAmount(e.target.value)}
              placeholder={t('fields.claimAmountHint')}
            />
          </div>
        </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-vac-pct">{t('fields.vacationPercent')}</Label>
            <Input
              id="pp-vac-pct"
              inputMode="decimal"
              value={vacationPercent}
              onChange={(e) => setVacationPercent(e.target.value)}
              placeholder="4.00"
            />
          </div>
          <div>
            <Label htmlFor="pp-vac-method">{t('fields.vacationMethod')}</Label>
            <Select
              id="pp-vac-method"
              value={vacationMethod}
              onChange={(e) => setVacationMethod(e.target.value as 'accrue' | 'pay_each_period')}
            >
              <option value="accrue">{t('vacation.accrue')}</option>
              <option value="pay_each_period">{t('vacation.pay_each_period')}</option>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          {(
            country === 'US'
              ? ([
                  ['pp-multiple-jobs', t('fields.multipleJobs'), multipleJobs, setMultipleJobs],
                  ['pp-w4-pre-2020', t('fields.w4Pre2020'), w4Pre2020, setW4Pre2020],
                  ['pp-fica-exempt', t('fields.ficaExempt'), ficaExempt, setFicaExempt],
                  ['pp-futa-exempt', t('fields.futaExempt'), futaExempt, setFutaExempt],
                  ['pp-tax-exempt', t('fields.fitExempt'), taxExempt, setTaxExempt],
                  ['pp-active', t('fields.isActive'), isActive, setIsActive],
                ] as const)
              : ([
                  ['pp-cpp-exempt', t('fields.cppExempt'), cppExempt, setCppExempt],
                  ['pp-ei-exempt', t('fields.eiExempt'), eiExempt, setEiExempt],
                  ['pp-tax-exempt', t('fields.taxExempt'), taxExempt, setTaxExempt],
                  ['pp-active', t('fields.isActive'), isActive, setIsActive],
                ] as const)
          ).map(([id, label, checked, set]) => (
            <label key={id} htmlFor={id} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e) => set(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-700"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
  )
  if (props.inline) {
    return (
      <div className="space-y-4">
        {body}
        {footer}
      </div>
    )
  }
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={p.employee_name}
      description={t('editorDescription')}
      footer={footer}
    >
      {body}
    </Drawer>
  )
}
