import 'server-only'
import type { SetupEntityValidationHook } from './types'

// The shared command fences the supplied actor's employment scope in its
// write transaction. Validation has no browser-session dependency.
export const validateServiceCredit: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const { validateServiceCreditConfiguration } = await import('@openbooks/engine/payroll/entitlements')
  const { PayrollError } = await import('@openbooks/engine/payroll/entitlements')
  let values = { ...body }
  if (rowId) {
    const row = (await executor.execute<Record<string, unknown>>(sql`select * from payroll_service_credits where org_id=${orgId} and id=${rowId}`)).rows[0]
    if (!row) return 'Service credit no longer exists; reopen its employment'
    values = { ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])), ...values }
  }
  const employment = (await executor.execute<{ employer_subsidiary_id: string }>(sql`select employer_subsidiary_id from worker_employments where org_id=${orgId} and id=${String(values.employmentId ?? '')}`)).rows[0]
  if (!employment) return 'Select an employment in this organization'
  try { await validateServiceCreditConfiguration(executor, orgId, values, rowId); return null }
  catch (error) { if (error instanceof PayrollError) return error.message; throw error }
}


export const validateEntitlementPlan: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const { validateEntitlementPlanConfiguration } = await import('@openbooks/engine/payroll/entitlements')
  const { PayrollError } = await import('@openbooks/engine/payroll/entitlements')
  let values = { ...body }
  if (rowId) {
    const row = (await executor.execute<Record<string, unknown>>(sql`select payout_component_id, deposit_component_id from entitlement_plans where org_id=${orgId} and id=${rowId}`)).rows[0]
    if (!row) return 'Entitlement plan no longer exists; reopen Benefits programs'
    values = {
      payoutComponentId: row.payout_component_id ?? null,
      depositComponentId: row.deposit_component_id ?? null,
      ...values,
    }
  }
  try { await validateEntitlementPlanConfiguration(executor, orgId, values); return null }
  catch (error) { if (error instanceof PayrollError) return error.message; throw error }
}

export const validateVacationTerm: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const { validateVacationTermConfiguration } = await import('@openbooks/engine/payroll/entitlements')
  const { PayrollError } = await import('@openbooks/engine/payroll/entitlements')
  let values = { ...body }
  if (rowId) {
    const row = (await executor.execute<Record<string, unknown>>(sql`select * from payroll_vacation_terms where org_id=${orgId} and id=${rowId}`)).rows[0]
    if (!row) return 'Vacation terms no longer exist; reopen the employment'
    values = { ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])), ...values }
  }
  const employment = (await executor.execute<{ employer_subsidiary_id: string }>(sql`select employer_subsidiary_id from worker_employments where org_id=${orgId} and id=${String(values.employmentId ?? '')}`)).rows[0]
  if (!employment) return 'Select an employment in this organization'
  try { await validateVacationTermConfiguration(executor, orgId, values, rowId); return null }
  catch (error) { if (error instanceof PayrollError) return error.message; throw error }
}


export const validateContributionWrite: SetupEntityValidationHook = async ({ entity, body, orgId, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const { foldWholeNumber } = await import('./whole-number')
  const { getAuthz } = await import('../authz')
  const { requireHrmBenefitsManageOnEmployment } = await import('@openbooks/engine/hrm/benefits')
  const { BenefitsError, validateBenefitContributionConfiguration } = await import('@openbooks/engine/hrm/benefits')
  let values = { ...body }
  if (rowId) {
    const existing = (await executor.execute<Record<string, unknown>>(sql`select * from ${sql.raw(entity.table)} where org_id=${orgId} and id=${rowId}`)).rows[0]
    if (!existing) return 'Contribution configuration no longer exists; reopen its owning record'
    const camel = Object.fromEntries(Object.entries(existing).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]))
    values = { ...camel, ...values, id: rowId }
  }
  for (const field of entity.fields) {
    if (field.kind === 'integer' && values[field.key] !== undefined) {
      const folded = foldWholeNumber(values[field.key])
      values[field.key] = folded === undefined ? null : folded
    }
  }
  try {
    if (entity.key === 'benefit-enrollment-configuration' || entity.key === 'benefit-enrollment-terms') {
      const enrollmentId = entity.key === 'benefit-enrollment-configuration' ? rowId : String(values.enrollmentId ?? '')
      if (!enrollmentId) return 'Select the employee enrollment before editing its contribution terms'
      const enrollment = (await executor.execute<{ employment_id: string; plan_id: string; status: string; submission_snapshot: unknown }>(sql`select employment_id,plan_id,status,submission_snapshot from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId} for update`)).rows[0]
      if (!enrollment) return 'Employee enrollment no longer exists; reopen an enrollment in this organization'
      const authz = await getAuthz()
      if (!authz || authz.user.orgId !== orgId) return 'The current session cannot manage this organization; reopen Benefits'
      await requireHrmBenefitsManageOnEmployment(executor, orgId, authz.user.id, enrollment.employment_id)
      if (enrollment.status !== 'elected' || enrollment.submission_snapshot != null) return 'Submitted and active enrollment elections are immutable; open the active enrollment and choose Edit to create a dated replacement'
      if (entity.key === 'benefit-enrollment-configuration') {
        if (values.classKey != null && values.classKey !== '') {
          const selected = (await executor.execute(sql`select id from hrm_benefit_contribution_classes where org_id=${orgId} and plan_id=${enrollment.plan_id} and class_key=${String(values.classKey)}`)).rows[0]
          if (!selected) return 'Choose an eligibility class from this enrollment plan'
        }
        return null
      }
    }
    await validateBenefitContributionConfiguration(executor, orgId, entity.key as Parameters<typeof validateBenefitContributionConfiguration>[2], values)
    return null
  } catch (error) { if (error instanceof BenefitsError) return error.message; throw error }
}

export const validateServiceTier: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const { validateEntitlementServiceTierConfiguration, PayrollError } = await import('@openbooks/engine/payroll/entitlements')
  try { await validateEntitlementServiceTierConfiguration(executor, orgId, body, rowId); return null }
  catch (error) { if (error instanceof PayrollError) return error.message; throw error }
}

/**
 * One active department expense mapping per component, department and date.
 * An overlapping active window refuses with the remedy (close the existing
 * window first) rather than storing two accounts for one posting. The
 * range-exclusion constraint is the backstop for writers around this hook.
 */
export const validateDepartmentExpenseWrite: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const current = rowId
    ? (await executor.execute<{
      pay_component_id: string | null; department_id: string | null;
      effective_from: string | null; effective_to: string | null;
    }>(
      sql`select pay_component_id, department_id, effective_from::text, effective_to::text
            from pay_component_department_expenses where id = ${rowId} and org_id = ${orgId}`,
    )).rows[0]
    : null
  if (rowId && !current) return 'Department expense mapping no longer exists; reopen pay-component setup'
  const componentId = body.payComponentId === undefined || body.payComponentId === null
    ? current?.pay_component_id : String(body.payComponentId)
  const departmentId = body.departmentId === undefined || body.departmentId === null
    ? current?.department_id : String(body.departmentId)
  const from = body.effectiveFrom === undefined || body.effectiveFrom === null
    ? current?.effective_from : String(body.effectiveFrom)
  const through = body.effectiveTo === undefined
    ? current?.effective_to ?? null
    : body.effectiveTo === null ? null : String(body.effectiveTo)
  if (!componentId || !departmentId || !from) return null
  const clashes = (await executor.execute<{ id: string }>(sql`
    select id from pay_component_department_expenses
     where org_id = ${orgId} and is_active
       and pay_component_id = ${componentId}::uuid and department_id = ${departmentId}::uuid
       and daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]')
         && daterange(${from}::date, coalesce(${through}::date, 'infinity'::date), '[]')
       and (${rowId ?? null}::uuid is null or id <> ${rowId ?? null}::uuid)
  `)).rows
  if (clashes.length > 0) {
    return 'This component and department already have an active expense mapping overlapping those dates — close the existing window first (set its effective-to), then add the new one.'
  }
  return null
}
