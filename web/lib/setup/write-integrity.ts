import "server-only";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import type { SetupEntity } from "./registry";
import { setupEntityWithValidationHook } from "./entities/customer-item-refs";
import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../features";
import { INTEGRITY_CONTINUES } from "./write-shared";
import { validateOperationsIntegrity } from "./write-integrity-operations";
import { validateTaxIntegrity } from "./write-integrity-tax";
import { validatePayrollIntegrity } from "./write-integrity-payroll";
import { validateFinanceIntegrity } from "./write-integrity-finance";
import { validatePeopleIntegrity } from "./write-integrity-people";
import { validateReviewIntegrity } from "./write-integrity-reviews";
import { validateTalentIntegrity } from "./write-integrity-talent";
import { validatePosIntegrity } from "./write-integrity-pos";
import { validateEquityIntegrity } from "./write-integrity-equity";

/** Entity integrity rule groups, evaluated in this order until one decides. */
const SETUP_INTEGRITY_RULES = [
  validateOperationsIntegrity,
  validateTaxIntegrity,
  validatePayrollIntegrity,
  validateFinanceIntegrity,
  validatePeopleIntegrity,
  validateReviewIntegrity,
  validateTalentIntegrity,
  validatePosIntegrity,
  validateEquityIntegrity,
] as const;

/** Domain checks that cannot be expressed by the generic field coercer. */
export async function validateEntityIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId?: string,
  executor: SqlExecutor = db,
): Promise<string | null> {
  for (const field of entity.fields.filter(
    (field) => field.featureKey && Object.hasOwn(body, field.key),
  )) {
    if (!(await isFeatureEnabled(orgId, field.featureKey!, executor)))
      return field.featureKey === "consignment"
        ? "Turn on Consignment in Company Settings → Features before changing external stock ownership."
        : "Turn on E-invoicing in Company Settings → Features before changing e-invoice VAT configuration.";
  }
  // `pay-schedules` is exempt from the generic feature fence: its dedicated
  // rule below (`payScheduleSubsidiaryProblem`) is the complete subsidiary
  // check for that entity — a valid subsidiary id is always accepted, an
  // absent one refused only in a multi-entity org. Firing the fence first
  // would refuse the onboarding wizard's single-entity default, which names
  // the org's sole subsidiary while the fence is closed.
  const submittedSubsidiaryScope =
    entity.key !== "tax-registrations" &&
    entity.key !== "pay-schedules" &&
    entity.fields
      .filter((field) => field.ref === "subsidiaries" && !field.legalEmployer && !field.legalEntity)
      .some((field) => Boolean(body[field.key]));
  if (submittedSubsidiaryScope && !(await subsidiaryFeatureEnabled(orgId, executor))) {
    return "Subsidiaries are not enabled for this organization";
  }
  // A legal employer identifies whose payroll obligation this is; it is
  // not an optional multi-subsidiary management capability. Keep the same
  // tenant and actor scope checks with either feature state.
  for (const field of entity.fields.filter((field) => field.legalEmployer || field.legalEntity)) {
    const scopeLabel = field.legalEmployer ? "legal employer" : "legal entity";
    const employer = body[field.key];
    if (employer == null || employer === "") continue;
    if (!isUuid(employer)) return `Choose a valid ${scopeLabel} from this organization`;
    const selected = await executor.execute(
      sql`select id from subsidiaries
      where org_id=${orgId} and id=${String(employer)} and is_active and not is_elimination`,
      "objects",
    );
    if (selected.length !== 1) return `Choose an active ${scopeLabel} from this organization`;
  }
  for (const rule of SETUP_INTEGRITY_RULES) {
    const verdict = await rule(entity, body, orgId, rowId, executor);
    if (verdict !== INTEGRITY_CONTINUES) return verdict;
  }
  const validatedEntity = setupEntityWithValidationHook(entity);
  return (
    (await validatedEntity.validateWrite?.({
      entity: validatedEntity,
      body,
      orgId,
      rowId,
      executor,
    })) ?? null
  );
}
