'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

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
  /** The publication or statute the form and its fields come from — pack data,
   *  shown under the form heading exactly as declared, never translated here. */
  citation: string
  /** Which storage the pack declared: column fields persist on the profile,
   *  row-backed fields file through the certificates API. Read, never assumed:
   *  the renderer binds each field by its own storage, so a pack moves a
   *  certificate between storages with no edit here. */
  storage: 'profile_columns' | 'certificate_rows'
  scope: { level: string; region?: string; subRegion?: string }
  fields: readonly DeclaredProfileField[]
}

/**
 * One current (unsuperseded) row-backed filing on the employee, as served
 * with the profile for prefill. Superseded rows stay on file for prior-period
 * re-runs but never prefill — the editor files a new row, it does not edit
 * history.
 */
export interface StoredCertificateRow {
  certificateKey: string
  answers: Record<string, string>
  effectiveFrom: string | null
}

/**
 * What the profile editor renders for one country pack, as served by
 * GET /api/payroll/profiles from the pack registry. Subdivisions are the
 * pack's `regions` coverage; the withholding section is its column-mapped
 * certificate declarations plus its profile exemption flags.
 */
export interface PackProfileDeclaration {
  /** The pack's own display name, served by GET /api/payroll/profiles. */
  countryName: string
  subdivisionLabel: string
  subdivisions: string[]
  /** Display name per subdivision code, served by GET /api/payroll/profiles. */
  subdivisionNames: Record<string, string>
  supportedSubdivisions: string[]
  unsupportedReason: string
  unsupportedReasons: Record<string, string>
  certificates: DeclaredProfileCertificate[]
  exemptionFlags: { column: string; label: string; help: string }[]
  /**
   * The pack's employee identifier, served by GET /api/payroll/profiles.
   * The sealed field renders the pack's own label, example and keyboard —
   * never a hardcoded "SIN / SSN" with a numeric keypad.
   */
  identifier: {
    label: string
    formatHelp: string
    example: string
    required: boolean
    neededFor: string | null
    numericEntry: boolean
  }
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
  /** Pack-declared employee facts (0191), served by GET /api/payroll/profiles. */
  pl_rok_urodzenia: number | null
  es_ano_nacimiento: number | null
  es_grupo_cotizacion: number | null
  es_situacion_laboral: string | null
  jp_hyojun_hoshu: number | null
  jp_kaigo_dainigou: string | null
  br_dependentes: number | null
  br_pensao_mensal: string | null
  vacation_percent: string | null
  vacation_method: 'accrue' | 'pay_each_period'
  filing_account_id: string | null
  stub_delivery: 'email' | 'print' | 'both'
  /** Payroll override of the pay rail; null inherits the party preference. */
  payment_method: 'eft' | 'cheque' | null
  /**
   * Standing commission-pay status for statutory-holiday rules that read it.
   * Three-state: null is UNANSWERED and the engine fails closed on it — never
   * defaulted, never inferred (migration 0181).
   */
  paid_on_commission: boolean | null
  is_active: boolean
};

const STUB_DELIVERIES = ['email', 'print', 'both'] as const
const PAYMENT_METHODS = ['eft', 'cheque'] as const

/** snake_case profile column → camelCase locale namespace (`filing_status` → `filingStatus`). */
function columnLocaleBase(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * snake_case profile column → the camelCase profile-POST body key
 * (`es_grupo_cotizacion` → `esGrupoCotizacion`): the same transform as the
 * locale namespace above, because the API names its body keys
 * camelCase(column) exactly like the locale keys.
 */
function columnBodyKey(column: string): string {
  return columnLocaleBase(column)
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
  /** The employee's current row-backed filings, for prefilling row-backed
   *  fields. Served with the profile; absent on the list variant, which does
   *  not edit. */
  storedCertificates?: StoredCertificateRow[]
  /** Pack-derived prefill hints by profile column (0191: the PL birth year
   *  off the PESEL), served with the profile. Shown where the row is blank
   *  and saved on submit — the visible half of derive-and-prefill. */
  derivedColumns?: Record<string, string>
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
  // Three-state: '' is UNANSWERED (null on the row), the only state that
  // refuses the affected calculation rather than answering it.
  const [paidOnCommission, setPaidOnCommission] = useState<string>(
    p.paid_on_commission == null ? '' : String(p.paid_on_commission),
  )
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
  // The certificate's declared scope is the authority: a country-level form
  // files for every employee of the pack, a region- or sub-region-level form
  // only for an employee of its own region. Never inferred from the key.
  const applicableCertificates = (pack?.certificates ?? []).filter(
    (certificate) => !certificate.scope.region || certificate.scope.region === province,
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
  // Pack-declared columns with no bespoke binding above (every 0191 fact and
  // any future pack's): answers held as text, keyed by column. The profile
  // row seeds them, the pack-derived hints (PESEL birth year) fill blanks,
  // and an operator edit wins over both — so the next pack's fact renders
  // and saves with no edit to this file.
  const [extraColumns, setExtraColumns] = useState<Record<string, string>>({})
  const rowCellText = (column: string): string => {
    const raw: unknown = (p as unknown as Record<string, unknown>)[column]
    if (raw === null || raw === undefined) return ''
    if (typeof raw === 'boolean') return raw ? 'true' : 'false'
    return String(raw)
  }
  const extraValue = (column: string): string =>
    extraColumns[column] ?? props.derivedColumns?.[column] ?? rowCellText(column)
  const setExtraValue = (column: string) => (value: string) =>
    setExtraColumns((prev) => ({ ...prev, [column]: value }))
  // Answers on row-backed certificates, keyed by certificate then field —
  // prefilled from the employee's current filings. Column-backed answers live
  // in the column state above; the two never share a field, so neither path
  // can clobber the other.
  const [rowAnswers, setRowAnswers] = useState<Record<string, Record<string, string>>>(() => {
    const initial: Record<string, Record<string, string>> = {}
    for (const stored of props.storedCertificates ?? []) {
      initial[stored.certificateKey] = { ...stored.answers }
    }
    return initial
  })
  const setRowAnswer = (certificateKey: string, fieldKey: string, value: string) =>
    setRowAnswers((prev) => ({
      ...prev,
      [certificateKey]: { ...(prev[certificateKey] ?? {}), [fieldKey]: value },
    }))

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
  // Country names: the locale wins where a key exists for the code (CA/US),
  // otherwise the PACK'S OWN NAME served with the declarations — never the
  // bare code. A surface handed only codes has nothing to show but codes,
  // which is how this picker rendered "GB"/"DE"/"FR".
  const countryLabel = (code: string): string => {
    if (hasKey(`country.${code}`)) return t(`country.${code}` as never)
    return props.packProfiles?.[code]?.countryName ?? code
  }
  const fieldLabel = (column: string | null, fallback: string): string =>
    column ? textOf(`fields.${columnLocaleBase(column)}`, fallback) : fallback
  const choiceLabel = (column: string, value: string, fallback: string): string =>
    textOf(`${columnLocaleBase(column)}.${value}`, fallback)

  // Declared above `save`: both the save path and the render path below
  // read it, and a const arrow used before its declaration trips the
  // hooks-immutability gate.
  const columnOf = (field: DeclaredProfileField): string | null =>
    field.storage?.kind === 'column' ? field.storage.column : null

  async function save() {
    setBusy(true)
    try {
      // Declared columns with no bespoke binding above save generically:
      // counts as numbers, flags as "true"/"false" text, everything else
      // as text — blank is null (unknown), and the API validates each one
      // against the pack's own declaration. Columns of a pack that is not
      // selected are never sent: carrying one pack's facts on another's
      // profile is refused on save.
      const extraFactSave: Record<string, string | number | null> = {}
      for (const certificate of applicableCertificates) {
        for (const field of certificate.fields) {
          const column = columnOf(field)
          if (!column || columnText[column] || columnFlag[column]) continue
          const raw = extraColumns[column]
            ?? props.derivedColumns?.[column]
            ?? rowCellText(column)
          if (raw === '') {
            extraFactSave[columnBodyKey(column)] = null
          } else if (field.kind === 'count') {
            extraFactSave[columnBodyKey(column)] = Number(raw)
          } else {
            extraFactSave[columnBodyKey(column)] = raw
          }
        }
      }
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
          // Always sent: the state round-trips the stored answer, so an
          // untouched control keeps whatever the row holds (including null).
          paidOnCommission: paidOnCommission === '' ? null : paidOnCommission === 'true',
          isActive,
          ...extraFactSave,
        }),
      })
      // The status is checked before the body is parsed: a non-JSON error body
      // must surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to save the payroll profile'))
      // Row-backed certificates file through the certificates API — one POST
      // per certificate the operator answered, each superseding the previous
      // filing rather than overwriting it. Certificates with nothing entered
      // file nothing: an empty filing would read as "on file" downstream.
      for (const certificate of applicableCertificates) {
        if (certificate.storage !== 'certificate_rows') continue
        const answers: Record<string, string> = {}
        for (const field of certificate.fields) {
          const value = (rowAnswers[certificate.key]?.[field.key] ?? '').trim()
          if (value !== '') answers[field.key] = value
        }
        if (Object.keys(answers).length === 0) continue
        const certRes = await fetch('/api/payroll/certificates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employeePartyId: p.employee_party_id,
            country,
            certificateKey: certificate.key,
            answers,
          }),
        })
        // The status is checked before the body is parsed (see above).
        if (!certRes.ok) throw new Error(await readApiErrorMessage(certRes, 'failed to save the certificate'))
      }
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

  /**
   * One non-flag certificate field, whichever storage it uses. The input
   * reads the pack's kind, choices, bands and defaults — the storage only
   * decides which state it binds to. Column fields keep the binding maps
   * above (the architecture test pins that every column the packs declare is
   * bound, so an unbound column fails the build rather than dropping an
   * answer silently); row-backed fields bind the row answers filed through
   * the certificates API.
   */
  const renderFieldInput = (
    certificate: DeclaredProfileCertificate,
    field: DeclaredProfileField,
    column: string | null,
    value: string,
    set: (value: string) => void,
  ) => {
    const id = `pp-${certificate.key}-${field.key}`
    // Display strings: the locale wins where a key exists for the data
    // concept (keyed by column, never by country); a row-backed field has no
    // column, so the pack's declared English reads as written — legible on
    // day one, localizable later without touching this file.
    const label = fieldLabel(column, field.label)
    const optionLabel = (choice: { value: string; label: string }): string =>
      column ? choiceLabel(column, choice.value, choice.label) : choice.label
    if (field.kind === 'choice') {
      // The pack's declared default is the statutory no-answer position
      // ("no W-4 on file is withheld as single"), read — never a literal here.
      const current = value || field.default || ''
      const showEmpty = !field.required || current === ''
      return (
        <div key={field.key}>
          <Label htmlFor={id} help={field.help}>{label}{field.required ? ' *' : ''}</Label>
          <Select id={id} value={current} onChange={(e) => set(e.target.value)}>
            {showEmpty && <option value="">—</option>}
            {(field.choices ?? []).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {optionLabel(choice)}
              </option>
            ))}
          </Select>
        </div>
      )
    }
    if (field.kind === 'count') {
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
            <Label htmlFor={id} help={field.help}>{label}{field.required ? ' *' : ''}</Label>
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
          <Label htmlFor={id} help={field.help}>{label}{field.required ? ' *' : ''}</Label>
          <Input id={id} inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} placeholder="0" />
        </div>
      )
    }
    return (
      <div key={field.key}>
        <Label htmlFor={id} help={field.help}>{label}{field.required ? ' *' : ''}</Label>
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

  const renderBodyField = (certificate: DeclaredProfileCertificate, field: DeclaredProfileField) => {
    const column = columnOf(field)
    if (field.kind === 'flag' || !column) return null
    // Bespoke bindings first (the CA/US columns); anything the packs declare
    // beyond them binds the generic extra-column state — the next pack's
    // fact renders with no edit here.
    const binding = columnText[column] ?? [extraValue(column), setExtraValue(column)] as const
    const [value, set] = binding
    return renderFieldInput(certificate, field, column, value, set)
  }

  /**
   * One non-flag field on a row-backed certificate, bound to the row answers
   * filed through the certificates API. Column-backed fields return null here
   * — they render on the column path above, unchanged.
   */
  const renderRowField = (certificate: DeclaredProfileCertificate, field: DeclaredProfileField) => {
    if (field.kind === 'flag' || columnOf(field)) return null
    const value = rowAnswers[certificate.key]?.[field.key] ?? ''
    return renderFieldInput(
      certificate, field, null, value,
      (next) => setRowAnswer(certificate.key, field.key, next),
    )
  }

  // Every checkbox in declaration order: the applicable certificates' flag
  // fields, then the pack's exemption flags, then the generic active toggle.
  // Column-backed flags bind the profile columns; row-backed flags bind the
  // row answers filed through the certificates API.
  const flagEntries: { id: string; label: string; help: string; checked: boolean; set: (value: boolean) => void }[] = []
  for (const certificate of applicableCertificates) {
    for (const field of certificate.fields) {
      if (field.kind !== 'flag') continue
      const column = columnOf(field)
      if (column) {
        const binding = columnFlag[column]
        if (binding) {
          flagEntries.push({
            id: `pp-${certificate.key}-${field.key}`,
            label: fieldLabel(column, field.label),
            help: field.help,
            checked: binding[0],
            set: binding[1],
          })
          continue
        }
        // Generic text-backed flag (the JP kaigo status and any future
        // pack's): answers are "true"/"false" strings, and untouched is
        // unanswered — never defaulted into either position.
        flagEntries.push({
          id: `pp-${certificate.key}-${field.key}`,
          label: fieldLabel(column, field.label),
          help: field.help,
          checked: extraValue(column) === 'true',
          set: (value: boolean) => setExtraValue(column)(value ? 'true' : 'false'),
        })
        continue
      }
      flagEntries.push({
        id: `pp-${certificate.key}-${field.key}`,
        label: field.label,
        help: field.help,
        checked: rowAnswers[certificate.key]?.[field.key] === 'true',
        set: (value: boolean) => setRowAnswer(certificate.key, field.key, value ? 'true' : 'false'),
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
            <Label htmlFor="pp-sin">{pack?.identifier.label ?? t('fields.sin')}</Label>
            <Input
              id="pp-sin"
              value={sin}
              onChange={(e) => setSin(e.target.value)}
              placeholder={(p as { sin_last3?: string | null }).sin_last3
                ? `••• ••• ${(p as { sin_last3?: string | null }).sin_last3}`
                : (pack?.identifier.example ?? t('fields.sinPlaceholder'))}
              inputMode={pack?.identifier.numericEntry === false ? 'text' : 'numeric'}
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
                    {pack.subdivisionNames[code] ?? code}
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
          {/* Standing commission-pay status. Unanswered until a person answers
              it: statutory-holiday rules that read it refuse the calculation
              rather than guess, so this control defaults to nothing. Labels
              resolve through the locale where keys exist, exactly like the
              pack-driven fields above. */}
          <div>
            <Label
              htmlFor="pp-paid-on-commission"
              help={textOf('paidOnCommission.help', 'Whether the employee is paid in whole or in part on commission. Some statutory-holiday rules pay a different amount — or refuse until this is answered. Leave unanswered until confirmed.')}
            >
              {textOf('fields.paidOnCommission', 'Paid on commission')}
            </Label>
            <Select
              id="pp-paid-on-commission"
              value={paidOnCommission}
              onChange={(e) => setPaidOnCommission(e.target.value)}
            >
              <option value="">{textOf('paidOnCommission.unanswered', 'Not answered')}</option>
              <option value="false">{textOf('paidOnCommission.no', 'No')}</option>
              <option value="true">{textOf('paidOnCommission.yes', 'Yes, in whole or in part')}</option>
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
            {certificate.citation && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {certificate.citation}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {certificate.fields.map((field) => (
                renderBodyField(certificate, field) ?? renderRowField(certificate, field)
              ))}
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
