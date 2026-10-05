import 'server-only'
import { sql } from 'drizzle-orm'
import { validateIdentifierUnit } from '@openbooks/engine/src/inventory/item-identifiers.ts'
import { validateCustomerItemRef } from '@openbooks/engine/src/sales/customer-item-refs.ts'
import { validateMarketplaceFacilitatorWrite as validateMarketplaceFacilitator } from '@openbooks/engine/tax'
import type { SetupEntity, SetupEntityValidationHook } from '../types'
import { BENEFIT_CONTRIBUTION_ENTITIES } from '../hrm-benefit-contributions'
import { PAYROLL_SERVICE_CREDITS_ENTITY } from '../payroll-service-credits'
import { PAYROLL_VACATION_TERMS_ENTITY } from '../payroll-vacation-terms'
import { validateContributionWrite, validateDepartmentExpenseWrite, validateEntitlementPlan, validateServiceCredit, validateServiceTier, validateVacationTerm } from '../workforce-validation'

type CurrentIdentifier = { item_id: string; unit: string | null }
type CurrentCustomerItemRef = { customer_id: string; item_id: string }

const validateIdentifierWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<CurrentIdentifier>(sql`
        select item_id, unit from item_identifiers where id = ${rowId} and org_id = ${orgId}`)).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const itemId = String(body.itemId ?? current?.item_id ?? '')
  const unit = body.unit === undefined
    ? current?.unit ?? null
    : body.unit == null || body.unit === '' ? null : String(body.unit)
  if (itemId) await validateIdentifierUnit(executor, orgId, itemId, unit)
}

const validateCustomerItemRefWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<CurrentCustomerItemRef>(sql`
        select customer_id, item_id from customer_item_refs where id = ${rowId} and org_id = ${orgId}`)).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const customerId = String(body.customerId ?? current?.customer_id ?? '')
  const itemId = String(body.itemId ?? current?.item_id ?? '')
  if (customerId && itemId) await validateCustomerItemRef(executor, orgId, customerId, itemId)
}

// The facilitator invariant (suitable clearing account, no tax-control
// double-use) lives in the engine beside the posting boundary; the hook only
// adapts its refusal to the Setup write contract (an error string).
const validateMarketplaceFacilitatorWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  try {
    await validateMarketplaceFacilitator(executor, orgId, body as Record<string, unknown>, rowId ?? null)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'That marketplace facilitator could not be saved'
  }
}

const SETUP_ENTITY_VALIDATION_HOOKS: Record<string, SetupEntityValidationHook> = {
  ...Object.fromEntries(BENEFIT_CONTRIBUTION_ENTITIES.map((entity) => [entity.key, validateContributionWrite])),
  [PAYROLL_SERVICE_CREDITS_ENTITY.key]: validateServiceCredit,
  [PAYROLL_VACATION_TERMS_ENTITY.key]: validateVacationTerm,
  'entitlement-service-tiers': validateServiceTier,
  'entitlement-plans': validateEntitlementPlan,
  'item-identifiers': validateIdentifierWrite,
  'customer-item-refs': validateCustomerItemRefWrite,
  'marketplace-facilitators': validateMarketplaceFacilitatorWrite,
  'pay-component-department-expenses': validateDepartmentExpenseWrite,
}

/** Attach entity-owned validation to the shared setup write pipeline. */
export function setupEntityWithValidationHook(entity: SetupEntity): SetupEntity {
  if (entity.validateWrite) return entity
  const validateWrite = SETUP_ENTITY_VALIDATION_HOOKS[entity.key]
  return validateWrite ? { ...entity, validateWrite } : entity
}
