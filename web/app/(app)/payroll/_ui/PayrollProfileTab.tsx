'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  ProfileEditor,
  type FilingAccountOption,
  type LabourJurisdictionOption,
  type PackProfileDeclaration,
  type ProfileRow,
  type ScheduleOption,
  type StoredCertificateRow,
} from './EmployeesPanel'
import { PackCertificateForms } from './PackCertificateForms'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * The employee drawer's Payroll tab — the ONE place a payroll profile is
 * edited, living on the native employee entity (no second payroll roster).
 * Loads the profile (or a blank default) + schedules and renders the shared
 * editor inline.
 *
 * The drawer splits the tab into sub-tabs (General / Tax and withholding /
 * Pay banks / Bank accounts) but mounts this panel ONCE: the editor stays
 * mounted (hidden) across sub-tab switches so unsaved edits survive, and the
 * `section` prop decides which half the single editor instance shows.
 */
export type PayrollSubTab = 'general' | 'tax' | 'banks' | 'accounts'

export function PayrollProfileTab({
  partyId,
  partyName,
  readOnly = false,
  section = 'general',
}: {
  partyId: string
  partyName: string
  /** Drawer read mode: values only, like the Overview tab. */
  readOnly?: boolean
  /** Which sub-tab the drawer shows; the editor half follows it. */
  section?: PayrollSubTab
}) {
  const t = useTranslations('payroll.profiles')
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    profile: ProfileRow | null
    schedules: ScheduleOption[]
    filingAccounts: FilingAccountOption[]
    labourJurisdictions: Record<string, LabourJurisdictionOption[]>
    countries: string[]
    packProfiles: Record<string, PackProfileDeclaration>
    storedCertificates: StoredCertificateRow[]
    derivedColumns: Record<string, string>
    defaultCountry: ProfileRow['country']
  }>({
    status: 'loading', profile: null, schedules: [], filingAccounts: [],
    labourJurisdictions: {}, countries: [], packProfiles: {}, storedCertificates: [],
    derivedColumns: {},
    defaultCountry: '',
  })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/payroll/profiles?employee=${partyId}`)
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json().
        if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to load the payroll profile'))
        const j = await res.json()
        if (!cancelled) {
          // The country the API derived, accepted only when it names a pack
          // the API itself declares — never a closed union in this file.
          const countries: string[] = Array.isArray(j.countries) ? j.countries.map(String) : []
          const defaultCountry: string = countries.includes(String(j.defaultCountry ?? ''))
            ? String(j.defaultCountry)
            : ''
          setState({
            status: 'ready',
            profile: j.profile,
            schedules: j.schedules ?? [],
            filingAccounts: j.filingAccounts ?? [],
            // The packs' declared labour jurisdictions, per country pack.
            labourJurisdictions: j.labourJurisdictions ?? {},
            countries,
            packProfiles: j.packProfiles ?? {},
            storedCertificates: Array.isArray(j.storedCertificates) ? j.storedCertificates : [],
            derivedColumns: j.derivedProfileColumns ?? {},
            // The API derives this from the employee's own legal entity (or
            // the root subsidiary, or the org's sole installed pack) —
            // '' when nothing answers, and then the operator chooses.
            defaultCountry,
          })
        }
      } catch (e) {
        if (!cancelled) {
          toast.error((e as Error).message)
          setState((s) => ({ ...s, status: 'error' }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [partyId, version])

  if (state.status === 'loading') {
    return <p className="py-6 text-center text-sm text-slate-400">{t('loading')}</p>
  }
  if (state.status === 'error') {
    return <p className="py-6 text-center text-sm text-slate-400">{t('loadFailed')}</p>
  }
  if (state.schedules.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        {t('noSchedules')}{' '}
        <Link className="font-medium text-teal-700 underline dark:text-teal-300" href={'/admin/setup/payroll?tab=schedules' as never}>
          {t('openSchedules')}
        </Link>
      </p>
    )
  }

  const profile: ProfileRow = state.profile ?? {
    id: '',
    employee_party_id: partyId,
    employee_name: partyName,
    pay_schedule_id: state.schedules[0]?.id ?? '',
    schedule_name: null,
    // Derived from the employee's subsidiary by the API — never a hardcoded
    // country, and no default jurisdiction inside it: 'CA'/'ON' as literals
    // here meant a new profile silently became an Ontario employee.
    country: state.defaultCountry,
    province: '',
    // Null, not a key: a new employment is governed by its work region's labour
    // jurisdiction unless somebody says otherwise.
    labour_jurisdiction: null,
    pay_basis: 'hourly',
    // Claim-code 1s are the pre-existing blank shape (withheld at the basic
    // personal amount, exactly as a profile saved with empty codes); changing
    // them would alter T4127 money for untouched new profiles, which is a
    // CA-pack decision, not a country-agnosticism fix. Undeclared columns are
    // nulled on save, so these are inert for any other pack.
    federal_claim_code: 1,
    federal_claim_amount: null,
    provincial_claim_code: 1,
    provincial_claim_amount: null,
    additional_tax_per_period: null,
    prescribed_zone_deduction: null,
    authorized_annual_deductions: null,
    authorized_federal_credits: null,
    authorized_provincial_credits: null,
    cpp_exempt: false,
    ei_exempt: false,
    tax_exempt: false,
    filing_status: null,
    multiple_jobs: false,
    dependent_credits: null,
    other_income_annual: null,
    deductions_annual: null,
    w4_pre_2020: false,
    w4_allowances: null,
    fica_exempt: false,
    futa_exempt: false,
    // Pack-declared employee facts (0191): a new employment answers nothing
    // until somebody does — the generic extra-column state binds whatever
    // the selected pack declares, so no per-country fields here.
    pl_rok_urodzenia: null,
    es_ano_nacimiento: null,
    es_grupo_cotizacion: null,
    es_situacion_laboral: null,
    jp_hyojun_hoshu: null,
    jp_kaigo_dainigou: null,
    br_dependentes: null,
    br_pensao_mensal: null,
    vacation_percent: null,
    vacation_method: 'accrue',
    filing_account_id: null,
    stub_delivery: 'email',
    payment_method: null,
    // A new employment answers nothing until somebody does.
    paid_on_commission: null,
    is_active: true,
  }

  // ONE editor instance for both halves: the section prop switches what it
  // shows without unmounting, so typed-but-unsaved values survive General ↔
  // Tax switches. Both halves stay mounted (hidden) for the same reason, as
  // do the row-backed certificate drafts below.
  const editorSection = section === 'tax' ? 'tax' : 'general'
  return (
    <>
      <div hidden={section === 'banks' || section === 'accounts'}>
        <ProfileEditor
          inline
          readOnly={readOnly}
          section={editorSection}
          profile={profile}
          schedules={state.schedules}
          filingAccounts={state.filingAccounts}
          labourJurisdictions={state.labourJurisdictions}
          countries={state.countries}
          packProfiles={state.packProfiles}
          storedCertificates={state.storedCertificates}
          derivedColumns={state.derivedColumns}
          onClose={() => {}}
          onSaved={() => setVersion((v) => v + 1)}
        />
      </div>
      {/* Row-backed certificate answers for the profile's pack (the NL opgaaf
        and SV facts, the DE ELStAM, the FR PAS option): rendered from the
        pack declarations, never a per-country form in this file. */}
      <div hidden={section !== 'tax'}>
        <PackCertificateForms partyId={partyId} country={profile.country} readOnly={readOnly} />
      </div>
    </>
  )
}
