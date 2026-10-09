import 'server-only'
import { sql } from 'drizzle-orm'
import { contractorWithholdingScheme } from '@openbooks/engine/country-tax-packs'
import { lockWithholdingDeposits, validateWithholdingRemittancePolicy } from '@openbooks/engine/contractor-withholding'
import { validateWithholdingEnrollment } from '@openbooks/engine/contractor-withholding'
import { coerceField } from './coerce'
import type { SetupEntityValidationHook } from './types'

/** Preserve deduction history while allowing an enrollment to end prospectively. */
export const validateWithholdingEnrollmentWrite: SetupEntityValidationHook = async ({ entity, executor, orgId, rowId, body }) => {
  if (rowId) await lockWithholdingDeposits(executor, orgId, rowId)
  const current = rowId ? (await executor.execute<Record<string, unknown>>(sql`
    select *, effective_from::text as effective_from, effective_to::text as effective_to from withholding_enrollments where org_id=${orgId} and id=${rowId} for update`)).rows[0] : null
  if (rowId && !current) return 'Withholding enrollment not found.'
  const value = (key: string, column: string) => body[key] === undefined ? current?.[column] : body[key]
  const subsidiaryId = String(value('subsidiaryId', 'subsidiary_id') ?? '')
  const schemeCode = String(value('schemeCode', 'scheme_code') ?? '')
  const liabilityAccountId = String(value('liabilityAccountId', 'liability_account_id') ?? '')
  const authorityPartyId = value('authorityPartyId', 'authority_party_id') as string | null
  const thresholdBasis = value('thresholdBasis', 'threshold_basis') as string | null
  const returnFrequency = value('returnFrequency', 'return_frequency') as string | null
  const payerScope = value('payerScope', 'payer_scope') as string | null
  const remittanceScheduleCode = value('remittanceScheduleCode', 'remittance_schedule_code') as string | null
  let normalizedPolicy: ReturnType<typeof validateWithholdingRemittancePolicy> | undefined
  const remittancePolicy = value('remittancePolicy', 'remittance_policy')
  const scheme = contractorWithholdingScheme(schemeCode)
  if (returnFrequency && !(scheme?.returnFrequencies ?? [scheme?.returnFrequency ?? 'monthly']).includes(returnFrequency as 'monthly' | 'quarterly' | 'annual')) return 'Choose a return period declared by this scheme.'
  if (scheme?.payerScope && payerScope !== scheme.payerScope) return 'This scheme requires an explicitly declared condominium payer.'
  if (!scheme?.payerScope && payerScope) return 'This scheme does not declare a restricted payer scope.'
  if (scheme?.remittanceSchedules?.length) {
    if (!remittanceScheduleCode || !scheme.remittanceSchedules.some(schedule => schedule.code === remittanceScheduleCode)) return 'Select a remittance schedule declared by this scheme.'
    const policyField = entity.fields.find(field => field.key === 'remittancePolicy')!
    const coercedPolicy = coerceField(policyField, remittancePolicy, true, body)
    if ('error' in coercedPolicy) return coercedPolicy.error
    normalizedPolicy = validateWithholdingRemittancePolicy(typeof coercedPolicy.value === 'string' ? JSON.parse(coercedPolicy.value) : coercedPolicy.value)
    const retainedEvent = (current?.remittance_policy as { nextDayEventOn?: string } | null)?.nextDayEventOn
    if (retainedEvent && normalizedPolicy.nextDayEventOn !== retainedEvent) return 'A recorded next-day deposit event is retained for subsequent schedule determination.'
  } else if (remittanceScheduleCode || remittancePolicy) return 'This scheme uses its ordinary return remittance workflow.'
  const effectiveFrom = String(value('effectiveFrom', 'effective_from') ?? '')
  const effectiveTo = value('effectiveTo', 'effective_to') as string | null
  const contractorReference = String(value('contractorReference', 'contractor_reference') ?? '').trim()
  if (!contractorReference) return 'Enter the contractor registration reference.'
  if (effectiveTo && effectiveTo < effectiveFrom) return 'The enrollment must end on or after its effective date.'
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withholding-enrollment:${orgId}:${subsidiaryId}:${schemeCode}`}, 0))`)
  if (current) {
    const history = (await executor.execute<{ last_payment: string | null; present: boolean }>(sql`
      select max(payment_date)::text as last_payment, (count(*) > 0 or exists(select 1 from withholding_returns where org_id=${orgId} and enrollment_id=${rowId})) as present from withholding_deductions
       where org_id=${orgId} and enrollment_id=${rowId}`)).rows[0]
    if (history?.present) {
      for (const [key, column] of [['subsidiaryId', 'subsidiary_id'], ['schemeCode', 'scheme_code'], ['liabilityAccountId', 'liability_account_id'], ['contractorReference', 'contractor_reference'], ['thresholdBasis', 'threshold_basis'], ['payerScope', 'payer_scope'], ['returnFrequency', 'return_frequency'], ['remittanceScheduleCode', 'remittance_schedule_code'], ['effectiveFrom', 'effective_from']] as const) {
        if (body[key] !== undefined && (body[key] ?? null) !== (current[column] ?? null)) return 'An enrollment with deductions retains its original policy. End it and create a new effective-dated enrollment.'
      }
      if (effectiveTo && history.last_payment && effectiveTo < history.last_payment) return 'The enrollment cannot end before its recorded deductions.'
    }
  }
  const overlap = (await executor.execute(sql`
    select id from withholding_enrollments where org_id=${orgId} and subsidiary_id=${subsidiaryId}
      and scheme_code=${schemeCode} and is_active and id <> ${rowId ?? '00000000-0000-0000-0000-000000000000'}::uuid
      and effective_from <= coalesce(${effectiveTo}::date, 'infinity'::date)
      and coalesce(effective_to, 'infinity'::date) >= ${effectiveFrom}::date`)).rows[0]
  if (value('isActive', 'is_active') !== false && overlap) return 'This legal entity already has an overlapping enrollment. End the earlier enrollment first.'
  await validateWithholdingEnrollment(executor, orgId, { subsidiaryId, schemeCode, liabilityAccountId, authorityPartyId: authorityPartyId || null, thresholdBasis: thresholdBasis || null, payerScope: payerScope || null, remittanceScheduleCode: remittanceScheduleCode || null })
}
