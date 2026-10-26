import "server-only";
import {
  validateRepresentingPartiesWrite,
  validateTransferPricingWrite,
} from "../intercompany-validation";
import { validateWithholdingEnrollmentWrite } from "../contractor-withholding-validation";
import { validateScheduleBoardWrite, validateScheduleCodeWrite } from "../scheduling-validation";
import { sql } from "drizzle-orm";
import { validateIdentifierUnit } from "@openbooks/engine/inventory/item-identifiers";
import { validateCustomerItemRef } from "@openbooks/engine/sales/customer-item-refs";
import { validateMarketplaceFacilitatorWrite as validateMarketplaceFacilitator } from "@openbooks/engine/tax";
import { validateTemplateWrite as validateAmortizationTemplate } from "@openbooks/engine/amortization";
import { paymentTermsDueRuleRefusal } from "@openbooks/engine/ledger/payment-terms-due-date";
import type { SetupEntity, SetupEntityValidationHook } from "../types";
import { validateStoredValueProgramWrite } from "../stored-value-validation";
import { validateEInvoiceSetupWrite } from "../einvoicing-validation";
import { BENEFIT_CONTRIBUTION_ENTITIES } from "../hrm-benefit-contributions";
import { PAYROLL_SERVICE_CREDITS_ENTITY } from "../payroll-service-credits";
import { PAYROLL_VACATION_TERMS_ENTITY } from "../payroll-vacation-terms";
import { validatePromotionWrite, validateRestockingFeeWrite } from "../sales-validation";
import {
  validateAgingBucketPolicyWrite,
  validateBusinessCalendarWrite,
} from "../calendar-validation";
import {
  validateAccountLocalizationWrite,
  validateSegmentDependencyWrite,
} from "../chart-validation";
import {
  validateContributionWrite,
  validateDepartmentExpenseWrite,
  validateEntitlementPlan,
  validateServiceCredit,
  validateServiceTier,
  validateVacationTerm,
} from "../workforce-validation";
import { validatePeriodEndPolicyWrite } from "../period-end-journal-validation";
import { validateLeavePayrollEntitlementMapping } from "../workforce-validation";

type CurrentIdentifier = { item_id: string; unit: string | null };
type CurrentCustomerItemRef = { customer_id: string; item_id: string };

const validateIdentifierWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  const current = rowId
    ? (
        await executor.execute<CurrentIdentifier>(
          sql`
        select item_id, unit from item_identifiers where id = ${rowId} and org_id = ${orgId}`,
          "objects",
        )
      )[0]
    : null;
  if (rowId && !current) return "not found";
  const itemId = String(body.itemId ?? current?.item_id ?? "");
  const unit =
    body.unit === undefined
      ? (current?.unit ?? null)
      : body.unit == null || body.unit === ""
        ? null
        : String(body.unit);
  if (itemId) await validateIdentifierUnit(executor, orgId, itemId, unit);
};

const validateCustomerItemRefWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  const current = rowId
    ? (
        await executor.execute<CurrentCustomerItemRef>(
          sql`
        select customer_id, item_id from customer_item_refs where id = ${rowId} and org_id = ${orgId}`,
          "objects",
        )
      )[0]
    : null;
  if (rowId && !current) return "not found";
  const customerId = String(body.customerId ?? current?.customer_id ?? "");
  const itemId = String(body.itemId ?? current?.item_id ?? "");
  if (customerId && itemId) await validateCustomerItemRef(executor, orgId, customerId, itemId);
};

// The facilitator invariant (suitable clearing account, no tax-control
// double-use) lives in the engine beside the posting boundary; the hook only
// adapts its refusal to the Setup write contract (an error string).
const validateMarketplaceFacilitatorWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  try {
    await validateMarketplaceFacilitator(
      executor,
      orgId,
      body as Record<string, unknown>,
      rowId ?? null,
    );
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "That marketplace facilitator could not be saved";
  }
};

// Amortization template policy (method, term, percentage table, account
// types) is validated by the engine that plans from it; the hook reads the
// stored row so a partial edit is judged as the whole version it produces.
const validateAmortizationTemplateWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  const current = rowId
    ? ((
        await executor.execute<Record<string, unknown>>(
          sql`
        select method, term_source, period_count, percentages, period_offset, deferral_account_id, destination_account_id
          from expense_amortization_templates where id = ${rowId} and org_id = ${orgId}`,
          "objects",
        )
      )[0] ?? null)
    : null;
  if (rowId && !current) return "not found";
  return validateAmortizationTemplate(executor, orgId, body as Record<string, unknown>, current);
};

// A partial edit is judged as the whole due-date rule it produces, by the
// same rule the engine applies when it derives a due date from these terms.
const validatePaymentTermsWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  const current = rowId
    ? ((
        await executor.execute<{ net_days: number; due_day_of_month: number | null }>(
          sql`
        select net_days, due_day_of_month from payment_terms where id = ${rowId} and org_id = ${orgId}`,
          "objects",
        )
      )[0] ?? null)
    : null;
  if (rowId && !current) return "not found";
  const supplied = (key: string, stored: number | null | undefined): unknown => {
    const value = body[key];
    if (value === undefined) return stored ?? null;
    if (value === null || value === "") return null;
    return typeof value === "string" && /^\s*-?\d+\s*$/.test(value) ? Number(value) : value;
  };
  return paymentTermsDueRuleRefusal({
    netDays: supplied("netDays", current ? Number(current.net_days) : null),
    dueDayOfMonth: supplied(
      "dueDayOfMonth",
      current?.due_day_of_month == null ? null : Number(current.due_day_of_month),
    ),
  });
};

const SETUP_ENTITY_VALIDATION_HOOKS: Record<string, SetupEntityValidationHook> = {
  "payment-terms": validatePaymentTermsWrite,
  "intercompany-representing-parties": validateRepresentingPartiesWrite,
  "intercompany-transfer-pricing": validateTransferPricingWrite,
  "expense-amortization-templates": validateAmortizationTemplateWrite,
  "einvoice-settings": validateEInvoiceSetupWrite,
  "einvoice-recipients": validateEInvoiceSetupWrite,
  "tax-codes": validateEInvoiceSetupWrite,
  "withholding-enrollments": validateWithholdingEnrollmentWrite,
  "schedule-boards": validateScheduleBoardWrite,
  "schedule-codes": validateScheduleCodeWrite,
  ...Object.fromEntries(
    BENEFIT_CONTRIBUTION_ENTITIES.map((entity) => [entity.key, validateContributionWrite]),
  ),
  [PAYROLL_SERVICE_CREDITS_ENTITY.key]: validateServiceCredit,
  [PAYROLL_VACATION_TERMS_ENTITY.key]: validateVacationTerm,
  "entitlement-service-tiers": validateServiceTier,
  "entitlement-plans": validateEntitlementPlan,
  "leave-payroll-entitlement-mappings": validateLeavePayrollEntitlementMapping,
  "item-identifiers": validateIdentifierWrite,
  "customer-item-refs": validateCustomerItemRefWrite,
  "marketplace-facilitators": validateMarketplaceFacilitatorWrite,
  promotions: validatePromotionWrite,
  "restocking-fee-policies": validateRestockingFeeWrite,
  "pay-component-department-expenses": validateDepartmentExpenseWrite,
  "stored-value-programs": validateStoredValueProgramWrite,
  "business-calendars": validateBusinessCalendarWrite,
  "aging-bucket-policies": validateAgingBucketPolicyWrite,
  "period-end-journal-policies": validatePeriodEndPolicyWrite,
  "account-localizations": validateAccountLocalizationWrite,
  "segment-value-dependencies": validateSegmentDependencyWrite,
};

/** Attach entity-owned validation to the shared setup write pipeline. */
export function setupEntityWithValidationHook(entity: SetupEntity): SetupEntity {
  if (entity.validateWrite) return entity;
  const validateWrite = SETUP_ENTITY_VALIDATION_HOOKS[entity.key];
  return validateWrite ? { ...entity, validateWrite } : entity;
}
