'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'

export interface ScheduleOption {
  id: string
  name: string
  frequency: string
}

/**
 * A labour jurisdiction the employee's country pack declares — the options for
 * the optional employment-standards override. Supplied by the API from the
 * pack declarations (`employmentJurisdictionsOf`), never listed here: this file
 * must not become a second place jurisdictions are enumerated.
 */
export interface LabourJurisdictionOption {
  key: string
  name: string
}

/** A payroll program/EIN account the employee can be filed and remitted under. */
export interface FilingAccountOption {
  id: string
  accountNumber: string
  name: string
  /** The country pack the account files under — an open string, like the profile's. */
  country: string
}

/**
 * One withholding field a country pack declares, as served by
 * GET /api/payroll/profiles. Structural mirror of the engine's
 * PayrollCertificateField — the API contract, not an engine import, so the
 * editor renders whatever the installed packs declare.
 */
export interface DeclaredProfileField {
  key: string
  label: string
  kind: 'choice' | 'count' | 'amount' | 'flag' | 'code'
  choices?: readonly { value: string; label: string; help?: string }[]
  decimals?: number
  min?: string
  max?: string
  default?: string
  required?: boolean
  help: string
  storage?: { kind: 'row' } | { kind: 'column'; column: string }
}

/** One withholding certificate a pack declares, as served with the profiles. */
export interface DeclaredProfileCertificate {
  key: string
  form: string
  label: string
  scope: { level: string; region?: string; subRegion?: string }
  fields: readonly DeclaredProfileField[]
}

/**
 * What the profile editor renders for one country pack, as served by
 * GET /api/payroll/profiles from the pack registry. Subdivisions are the
 * pack's `regions` coverage; the withholding section is its column-mapped
 * certificate declarations plus its profile exemption flags.
 */
export interface PackProfileDeclaration {
  subdivisionLabel: string
  subdivisions: string[]
  supportedSubdivisions: string[]
  unsupportedReason: string
  unsupportedReasons: Record<string, string>
  certificates: DeclaredProfileCertificate[]
  exemptionFlags: { column: string; label: string; help: string }[]
}

export type ProfileRow = {
  id: string
  employee_party_id: string
  employee_name: string
  pay_schedule_id: string
  schedule_name: string | null
  /** '' only on a blank NEW profile whose default could not be derived from
   *  the employee's subsidiary — the operator must choose; the API refuses
   *  a save with no country rather than assuming one. An open string: the
   *  countries on offer come from the served pack declarations, never a union
   *  in this file. */
  country: string
  province: string
  /** The labour jurisdiction whose employment standards govern the employment;
   *  null = derive it from the work region (the answer for almost everyone). */
  labour_jurisdiction: string | null
  pay_basis: 'hourly' | 'salary'
  federal_claim_code: number | null
  federal_claim_amount: string | null
  provincial_claim_code: number | null
  provincial_claim_amount: string | null
  additional_tax_per_period: string | null
  prescribed_zone_deduction: string | null
  authorized_annual_deductions: string | null
  authorized_federal_credits: string | null
  authorized_provincial_credits: string | null
  cpp_exempt: boolean
  ei_exempt: boolean
  tax_exempt: boolean
  /** An open string: the allowed answers come from the pack's declared
   *  certificate choices, never a union in this file. */
  filing_status: string | null
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
};

const STUB_DELIVERIES = ['email', 'print', 'both'] as const
const PAYMENT_METHODS = ['eft', 'cheque'] as const

/** snake_case profile column → camelCase locale namespace (`filing_status` → `filingStatus`). */
function columnLocaleBase(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

export function ProfileEditor(props: {
  profile: ProfileRow
  schedules: ScheduleOption[]
  /** Empty for single-account employers: the country pack's default is used. */
  filingAccounts?: FilingAccountOption[]
  /** country pack → the labour jurisdictions it declares, from the API. */
  labourJurisdictions?: Record<string, LabourJurisdictionOption[]>
  /** Every known pack, in registry order — the country picker offers exactly these. */
  countries?: string[]
  /** country pack → what the editor renders for it: subdivisions, withholding
   *  certificates, exemption flags. From the API, declared by the packs. */
  packProfiles?: Record<string, PackProfileDeclaration>
  onClose: () => void
  onSaved: () => void
  /** Render as a plain section (inside another drawer/tab) instead of a Drawer. */
  inline?: boolean
}) {
  const t = useTranslations('payroll.profiles')
  const p = props.profile
  const [busy, setBusy] = useState(false)
  const [payScheduleId, setPayScheduleId] = useState(p.pay_schedule_id)
  // No coercion: an unset country stays unset until the operator chooses.
  // Defaulting it to a pack here is exactly the silent-Canada fallthrough the
  // engine refuses (engine/src/payroll/packs.ts).
  const [country, setCountry] = useState<ProfileRow['country']>(p.country)
  const [province, setProvince] = useState(p.province)
  const [labourJurisdiction, setLabourJurisdiction] = useState(p.labour_jurisdiction ?? '')
  const [payBasis, setPayBasis] = useState<'hourly' | 'salary'>(p.pay_basis)
  const [federalClaimCode, setFederalClaimCode] = useState(p.federal_claim_code == null ? '' : String(p.federal_claim_code))
  const [federalClaimAmount, setFederalClaimAmount] = useState(p.federal_claim_amount ?? '')
  const [provincialClaimCode, setProvincialClaimCode] = useState(p.provincial_claim_code == null ? '' : String(p.provincial_claim_code))
  const [provincialClaimAmount, setProvincialClaimAmount] = useState(p.provincial_claim_amount ?? '')
  const [additionalTax, setAdditionalTax] = useState(p.additional_tax_per_period ?? '')
  const [prescribedZoneDeduction, setPrescribedZoneDeduction] = useState(p.prescribed_zone_deduction ?? '')
  const [authorizedAnnualDeductions, setAuthorizedAnnualDeductions] = useState(p.authorized_annual_deductions ?? '')
  const [authorizedFederalCredits, setAuthorizedFederalCredits] = useState(p.authorized_federal_credits ?? '')
  const [authorizedProvincialCredits, setAuthorizedProvincialCredits] = useState(p.authorized_provincial_credits ?? '')
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
  // Same rule for the labour jurisdictions: one pack's declarations, and none
  // at all until a country is chosen.
  const labourOptions = (country && props.labourJurisdictions?.[country]) || []

  // Everything below renders from the selected pack's declaration — the
  // subdivision list and label, the withholding certificates, the exemption
  // flags. No pack means no withholding section: the honest empty state, not
  // another country's shape.
  const pack = country ? props.packProfiles?.[country] : undefined
  const applicableCertificates = (pack?.certificates ?? []).filter(
    (certificate) =>
      certificate.scope.level === 'country'
      || (certificate.scope.level === 'region' && certificate.scope.region === province),
  )
  // Every profile column the selected pack answers through — certificate
  // fields plus exemption flags. Answers held in state for any other column
  // are nulled on save: carrying one pack's withholding facts on another
  // pack's profile would be refused on save for labour jurisdictions, and
  // withholding gets the same rule.
  const declaredColumns = new Set<string>()
  for (const certificate of pack?.certificates ?? []) {
    for (const field of certificate.fields) {
      if (field.storage?.kind === 'column') declaredColumns.add(field.storage.column)
    }
  }
  for (const flag of pack?.exemptionFlags ?? []) declaredColumns.add(flag.column)
  const kept = (column: string, value: string | null): string | null =>
    declaredColumns.has(column) ? value : null
  const keptCount = (column: string, raw: string): number | null =>
    raw === '' || !declaredColumns.has(column) ? null : Number(raw)

  // Column → state, so the generic field renderer below can bind whatever the
  // pack declares without naming a single form's fields.
  const columnText: Record<string, [string, (value: string) => void]> = {
    federal_claim_code: [federalClaimCode, setFederalClaimCode],
    federal_claim_amount: [federalClaimAmount, setFederalClaimAmount],
    provincial_claim_code: [provincialClaimCode, setProvincialClaimCode],
    provincial_claim_amount: [provincialClaimAmount, setProvincialClaimAmount],
    additional_tax_per_period: [additionalTax, setAdditionalTax],
    prescribed_zone_deduction: [prescribedZoneDeduction, setPrescribedZoneDeduction],
    authorized_annual_deductions: [authorizedAnnualDeductions, setAuthorizedAnnualDeductions],
    authorized_federal_credits: [authorizedFederalCredits, setAuthorizedFederalCredits],
    authorized_provincial_credits: [authorizedProvincialCredits, setAuthorizedProvincialCredits],
    filing_status: [filingStatus ?? '', (value) => setFilingStatus(value || null)],
    dependent_credits: [dependentCredits, setDependentCredits],
    other_income_annual: [otherIncomeAnnual, setOtherIncomeAnnual],
    deductions_annual: [deductionsAnnual, setDeductionsAnnual],
    w4_allowances: [w4Allowances, setW4Allowances],
  }
  const columnFlag: Record<string, [boolean, (value: boolean) => void]> = {
    multiple_jobs: [multipleJobs, setMultipleJobs],
    w4_pre_2020: [w4Pre2020, setW4Pre2020],
    fica_exempt: [ficaExempt, setFicaExempt],
    futa_exempt: [futaExempt, setFutaExempt],
    cpp_exempt: [cppExempt, setCppExempt],
    ei_exempt: [eiExempt, setEiExempt],
    tax_exempt: [taxExempt, setTaxExempt],
  }

  // Display strings: the locale wins where a key exists for the data concept
  // (keyed by column, never by country), otherwise the pack's declared
  // English reads as written. A new pack is therefore legible on day one and
  // localizable later without touching this file — the same arrangement the
  // pack-cards surface uses.
  const hasKey = (key: string): boolean => {
    try {
      return t.has(key as never)
    } catch {
      return false
    }
  }
  const textOf = (key: string, fallback: string): string =>
    hasKey(key) ? t(key as never) : fallback
  const countryLabel = (code: string): string => textOf(`country.${code}`, code)
  const fieldLabel = (column: string | null, fallback: string): string =>
    column ? textOf(`fields.${columnLocaleBase(column)}`, fallback) : fallback
  const choiceLabel = (column: string, value: string, fallback: string): string =>
    textOf(`${columnLocaleBase(column)}.${value}`, fallback)

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
          labourJurisdiction: labourJurisdiction || null,
          payBasis,
          federalClaimCode: keptCount('federal_claim_code', federalClaimCode),
          federalClaimAmount: kept('federal_claim_amount', federalClaimAmount || null),
          provincialClaimCode: keptCount('provincial_claim_code', provincialClaimCode),
          provincialClaimAmount: kept('provincial_claim_amount', provincialClaimAmount || null),
          additionalTaxPerPeriod: kept('additional_tax_per_period', additionalTax || null),
          prescribedZoneDeduction: kept('prescribed_zone_deduction', prescribedZoneDeduction || null),
          authorizedAnnualDeductions: kept('authorized_annual_deductions', authorizedAnnualDeductions || null),
          authorizedFederalCredits: kept('authorized_federal_credits', authorizedFederalCredits || null),
          authorizedProvincialCredits: kept('authorized_provincial_credits', authorizedProvincialCredits || null),
          cppExempt: declaredColumns.has('cpp_exempt') && cppExempt,
          eiExempt: declaredColumns.has('ei_exempt') && eiExempt,
          taxExempt: declaredColumns.has('tax_exempt') && taxExempt,
          filingStatus: kept('filing_status', filingStatus),
          multipleJobs: declaredColumns.has('multiple_jobs') && multipleJobs,
          dependentCredits: kept('dependent_credits', dependentCredits || null),
          otherIncomeAnnual: kept('other_income_annual', otherIncomeAnnual || null),
          deductionsAnnual: kept('deductions_annual', deductionsAnnual || null),
          w4Pre2020: declaredColumns.has('w4_pre_2020') && w4Pre2020,
          w4Allowances: keptCount('w4_allowances', w4Allowances),
          ficaExempt: declaredColumns.has('fica_exempt') && ficaExempt,
          futaExempt: declaredColumns.has('futa_exempt') && futaExempt,
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

  const columnOf = (field: DeclaredProfileField): string | null =>
    field.storage?.kind === 'column' ? field.storage.column : null

  /**
   * One non-flag certificate field, bound to its profile column by the
   * binding maps above. Flags render in the checkbox grid below; a field
   * whose column has no binding renders nothing — the architecture test
   * pins that every column the packs declare is bound, so an unbound
   * column fails the build rather than dropping an answer silently.
   */
  const renderBodyField = (certificate: DeclaredProfileCertificate, field: DeclaredProfileField) => {
    const id = `pp-${certificate.key}-${field.key}`
    const column = columnOf(field)
    if (field.kind === 'flag' || !column) return null
    if (field.kind === 'choice') {
      const binding = columnText[column]
      if (!binding) return null
      const [value, set] = binding
      // The pack's declared default is the statutory no-answer position
      // ("no W-4 on file is withheld as single"), read — never a literal here.
      const current = value || field.default || ''
      const showEmpty = !field.required || current === ''
      return (
        <div key={field.key}>
          <Label htmlFor={id} help={field.help}>{fieldLabel(column, field.label)}</Label>
          <Select id={id} value={current} onChange={(e) => set(e.target.value)}>
            {showEmpty && <option value="">—</option>}
            {(field.choices ?? []).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choiceLabel(column, choice.value, choice.label)}
              </option>
            ))}
          </Select>
        </div>
      )
    }
    if (field.kind === 'count') {
      const binding = columnText[column]
      if (!binding) return null
      const [value, set] = binding
      // A narrow band is a codeset the operator picks from (TD1 0–10); a
      // wide one is typed (W-4 allowances 0–99). The cutoff is presentation,
      // the band itself is declared.
      const min = field.min == null ? null : Number(field.min)
      const max = field.max == null ? null : Number(field.max)
      const codes = min !== null && max !== null && Number.isInteger(min) && Number.isInteger(max) && max - min <= 10
        ? Array.from({ length: max - min + 1 }, (_, i) => String(min + i))
        : null
      if (codes) {
        return (
          <div key={field.key}>
            <Label htmlFor={id} help={field.help}>{fieldLabel(column, field.label)}</Label>
            <Select id={id} value={value} onChange={(e) => set(e.target.value)}>
              <option value="">—</option>
              {codes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </div>
        )
      }
      return (
        <div key={field.key}>
          <Label htmlFor={id} help={field.help}>{fieldLabel(column, field.label)}</Label>
          <Input id={id} inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} placeholder="0" />
        </div>
      )
    }
    const binding = columnText[column]
    if (!binding) return null
    const [value, set] = binding
    return (
      <div key={field.key}>
        <Label htmlFor={id} help={field.help}>{fieldLabel(column, field.label)}</Label>
        <Input
          id={id}
          inputMode={field.kind === 'amount' ? 'decimal' : 'text'}
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder={field.kind === 'amount' ? '0.00' : undefined}
        />
      </div>
    )
  }

  // Every checkbox in declaration order: the applicable certificates' flag
  // fields, then the pack's exemption flags, then the generic active toggle.
  const flagEntries: { id: string; label: string; help: string; checked: boolean; set: (value: boolean) => void }[] = []
  for (const certificate of applicableCertificates) {
    for (const field of certificate.fields) {
      if (field.kind !== 'flag') continue
      const column = columnOf(field)
      const binding = column ? columnFlag[column] : undefined
      if (!column || !binding) continue
      flagEntries.push({
        id: `pp-${certificate.key}-${field.key}`,
        label: fieldLabel(column, field.label),
        help: field.help,
        checked: binding[0],
        set: binding[1],
      })
    }
  }
  for (const flag of pack?.exemptionFlags ?? []) {
    const binding = columnFlag[flag.column]
    if (!binding) continue
    flagEntries.push({
      id: `pp-exempt-${flag.column}`,
      label: fieldLabel(flag.column, flag.label),
      help: flag.help,
      checked: binding[0],
      set: binding[1],
    })
  }
  flagEntries.push({ id: 'pp-active', label: t('fields.isActive'), help: '', checked: isActive, set: setIsActive })

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
                setCountry(e.target.value)
                // The jurisdiction inside the country is the operator's
                // choice, never a defaulted capital-of-payroll literal.
                setProvince('')
                // Labour jurisdiction keys belong to ONE pack; carrying one
                // across a country change would be refused on save.
                setLabourJurisdiction('')
                // Filing accounts belong to one country pack.
                setFilingAccountId('')
              }}
            >
              {country === '' && <option value="" disabled>—</option>}
              {(props.countries ?? []).map((code) => (
                <option key={code} value={code}>
                  {countryLabel(code)}
                </option>
              ))}
            </Select>
          </div>
          {pack && (
          <div>
            <Label htmlFor="pp-province">
              {textOf(`fields.${pack.subdivisionLabel}`, pack.subdivisionLabel)}
            </Label>
            <Select id="pp-province" value={province} onChange={(e) => setProvince(e.target.value)}>
              {province === '' && <option value="" disabled>—</option>}
              {pack.subdivisions.map((code) => {
                const supported = pack.supportedSubdivisions.includes(code)
                const reason = (pack.unsupportedReasons[code] ?? pack.unsupportedReason)
                  .replace(/\{region\}/g, code)
                return (
                  <option key={code} value={code} disabled={!supported} title={supported ? undefined : reason}>
                    {code}
                  </option>
                )
              })}
            </Select>
          </div>
          )}
          {/* The employment-standards override. Blank — the case for almost
              every employment — derives the labour jurisdiction from the work
              region above; it is set only when a different labour jurisdiction
              regulates the employer of record, which has its own statutory
              holiday calendar and its own holiday-pay formula. Options are the
              country pack's declared labour jurisdictions; withholding is
              unaffected and still follows the region. */}
          {labourOptions.length > 0 && (
            <div>
              <Label htmlFor="pp-labour-jurisdiction" help={t('labourJurisdiction.help')}>
                {t('fields.labourJurisdiction')}
              </Label>
              <Select
                id="pp-labour-jurisdiction"
                value={labourJurisdiction}
                onChange={(e) => setLabourJurisdiction(e.target.value)}
              >
                <option value="">{t('labourJurisdiction.fromRegion')}</option>
                {labourOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.key} · {option.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="pp-basis">{t('fields.payBasis')}</Label>
            <Select id="pp-basis" value={payBasis} onChange={(e) => setPayBasis(e.target.value as 'hourly' | 'salary')}>
              <option value="hourly">{t('basis.hourly')}</option>
              <option value="salary">{t('basis.salary')}</option>
            </Select>
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
            <Label htmlFor="pp-payment-method" help={t('paymentMethod.help')}>{t('fields.paymentMethod')}</Label>
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
          </div>
        </div>

        {/* Withholding, from the selected pack's declared certificates: the
            country-level form, plus the subdivision's own form when one is
            declared for it. A new pack's forms render here with no edit to
            this file — including forms this build has never heard of. */}
        {applicableCertificates.map((certificate) => (
          <div key={certificate.key} className="space-y-3">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {certificate.form} · {certificate.label}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {certificate.fields.map((field) => renderBodyField(certificate, field))}
            </div>
          </div>
        ))}

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
          {flagEntries.map((entry) => (
            <label
              key={entry.id}
              htmlFor={entry.id}
              title={entry.help || undefined}
              className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
            >
              <input
                id={entry.id}
                type="checkbox"
                checked={entry.checked}
                onChange={(e) => entry.set(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-700"
              />
              {entry.label}
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
