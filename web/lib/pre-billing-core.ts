import "server-only";
import { projectContractCapacityUsed } from "@openbooks/engine/projects/billing-pricing";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { add, cmp, mul, mulPercent, normalizeMoney, sum } from "@openbooks/engine/money/money";
import { canonicalDecimal } from "./exact-decimal";
import { acquireFeatureGateLock, isFeatureEnabled } from "./features";
import { lockAndCheckOrgFeature } from "@openbooks/engine/organization/org-feature-lock";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import type { FinancialProfile, InvoicingProfile } from "@openbooks/schema";
import { effectivePreBillingPolicy, type PreBillingPolicyVersion } from "./pre-billing-policy";
import type { PrebillStage } from "./pre-billing-stages";

export type PreBillingSourceType = "time_entry" | "document_line";
export type PrebillStatus =
  "draft" | "review" | "approved" | "customer_review" | "converted" | "void";

export class PreBillingError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "PreBillingError";
  }
}

export async function assertPreBillingEnabled(orgId: string): Promise<void> {
  const [projects, preBilling] = await Promise.all([
    isFeatureEnabled(orgId, "projects"),
    isFeatureEnabled(orgId, "preBilling"),
  ]);
  if (!projects || !preBilling)
    throw new PreBillingError(
      "Pre-billing is turned off — enable it on Company Settings → Features",
      404,
    );
}

export async function assertPreBillingEnabledTx(tx: Executor, orgId: string): Promise<void> {
  await acquireFeatureGateLock(orgId, tx);
  const projects = await lockAndCheckOrgFeature(tx, orgId, "projects");
  const preBilling = await lockAndCheckOrgFeature(tx, orgId, "preBilling");
  if (!projects || !preBilling)
    throw new PreBillingError(
      "Pre-billing is turned off — enable it on Company Settings → Features",
      404,
    );
}

export const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

export function persistMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new PreBillingError(`${label} must be an exact decimal`);
  let amount: string;
  try {
    amount = normalizeMoney(exact);
  } catch {
    throw new PreBillingError(`${label} must be an exact decimal`);
  }
  // Proposed amounts land in numeric(19,4) columns: fifteen whole digits. A
  // pasted wider figure normalized fine and died only in the update with a
  // storage error — fail closed here with a named error.
  if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new PreBillingError(`${label} is out of range — at most 15 whole digits fit the ledger`);
  }
  return amount;
}

export interface CreatePrebillInput {
  projectId: string;
  periodStart?: string | null;
  periodEnd: string;
  notes?: string | null;
}

export interface UpdatePrebillLineInput {
  proposedBillAmount: string;
  adjustmentReason?: string | null;
  adjustmentEvidence?: string[];
}

export type PrebillListRow = {
  id: string;
  worksheetNumber: string;
  projectId: string;
  projectName: string;
  customerName: string | null;
  periodStart: string | null;
  periodEnd: string;
  status: PrebillStatus;
  originalBillAmount: string;
  proposedBillAmount: string;
  costAmount: string;
  adjustmentAmount: string;
  billingRequestId: string | null;
  invoiceDocumentId: string | null;
  invoiceNumber: string | null;
  createdAt: string;
  /** Where the worksheet sits on the pre-billing board; see prebillStage. */
  stage: PrebillStage;
  projectTypeName: string | null;
  lineCount: number;
  heldLineCount: number;
  disputedLineCount: number;
  /** The project type requires customer acceptance before invoicing. */
  customerReviewRequired: boolean;
  customerReviewSentAt: string | null;
  customerDecision: "accepted" | "disputed" | null;
  customerDecidedAt: string | null;
  customerSignerName: string | null;
  customerDecisionNote: string | null;
  customerPoNumber: string | null;
  customerViewedAt: string | null;
  invoiceStatus: string | null;
  invoiceTotal: string | null;
  invoiceOpenBalance: string | null;
  deliveredAt: string | null;
};

export type PrebillLineRow = {
  id: string;
  lineNumber: number;
  sourceType: PreBillingSourceType;
  timeEntryId: string | null;
  documentLineId: string | null;
  sourceDocumentId: string | null;
  sourceDate: string;
  description: string | null;
  quantity: string;
  unit: string | null;
  costAmount: string;
  originalBillAmount: string;
  proposedBillAmount: string;
  adjustmentAmount: string;
  adjustmentReason: string | null;
  adjustmentEvidence: string[];
  disposition: "bill" | "hold";
  holdId: string | null;
  holdReason: string | null;
  pricingSnapshot: Record<string, unknown>;
  customerDisputeNote: string | null;
  /** Opaque optimistic-concurrency token: the line's canonical revision when read. */
  updatedAt: string;
};

export interface PreBillingProjectOption {
  id: string;
  name: string;
  customerName: string | null;
  projectTypeName: string;
  lineBuilder: string;
}

export interface PrebillDetail extends PrebillListRow {
  notes: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  convertedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  lines: PrebillLineRow[];
  events: Array<{
    id: string;
    eventType: string;
    actorName: string | null;
    occurredAt: string;
    details: unknown;
  }>;
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<Tx, "execute">;
/**
 * The caller's subsidiary visibility (authz.allowedSubsidiaryIds): null is
 * unrestricted, a set (even empty) fails closed. Every entry point applies it
 * to the worksheet's PROJECT, so a worksheet on a hidden project is missing —
 * in lists, analytics, by id, and for every write.
 */
export type SubsidiaryScope = ReadonlySet<string> | null;

/** One locked prebills header plus the joined project context conversion needs. */
export interface PrebillHeaderRow extends Record<string, unknown> {
  status: string;
  customer_id: string | null;
  currency: string | null;
  subsidiary_id: string | null;
  project_id: string;
  period_end: string;
  proposed_bill_amount: string;
  worksheet_number: string;
  customer_po_number: string | null;
  billing_method: string | null;
  notes: string | null;
  custom: Record<string, unknown> | null;
  invoice_document_id: string | null;
  customer_decision: string | null;
}

/** One convertible prebill_lines row plus its hold flag. */
export type PrebillSourceLineRow = {
  id: string;
  org_id: string;
  prebill_id: string;
  line_number: number;
  source_type: string;
  time_entry_id: string | null;
  document_line_id: string | null;
  document_id: string | null;
  project_id: string;
  source_date: string;
  item_id: string | null;
  income_account_id: string | null;
  description: string | null;
  quantity: string;
  unit: string | null;
  amount: string;
  bill_amount: string;
  proposed_bill_amount: string;
  original_bill_amount: string;
  cost_amount: string;
  adjustment_amount: string;
  cost_multiplier: string | null;
  markup_percent: string | null;
  tax_code_id: string | null;
  time_type_id: string | null;
  employee_party_id: string | null;
  department_id: string | null;
  disposition: string;
  is_billable: boolean | null;
  billed_by_line_id: string | null;
  actively_held: boolean;
};

type ProjectPolicyContext = {
  projectId: string;
  projectTypeId: string;
  projectTypeKey: string;
  projectTypeName: string;
  billingMethod: string | null;
  contractValue: string;
  markupPercent: string;
  fallbackProfile: FinancialProfile;
  invoicingProfile: InvoicingProfile;
  versions: PreBillingPolicyVersion[];
};

export type RawPreBillingSource = {
  source_type: PreBillingSourceType;
  source_id: string;
  time_entry_id: string | null;
  document_line_id: string | null;
  source_document_id: string | null;
  source_date: string;
  description: string | null;
  quantity: string;
  unit: string | null;
  item_id: string | null;
  income_account_id: string | null;
  tax_code_id: string | null;
  employee_party_id: string | null;
  time_type_id: string | null;
  department_id: string | null;
  costing_basis: string | null;
  document_kind: string | null;
  document_status: string | null;
  direct_cost_amount: string;
  native_bill_amount: string;
};

export type OverheadRateRow = {
  department_id: string | null;
  rate_kind: "per_hour" | "percent";
  rate: string;
  effective_from: string;
  effective_to: string | null;
};

export async function loadProjectPolicy(
  executor: Executor,
  orgId: string,
  projectId: string,
  lock = false,
  scope: SubsidiaryScope = null,
): Promise<ProjectPolicyContext> {
  const project = await executor.execute<{
    id: string;
    project_type_id: string | null;
    contract_value: string;
    markup_percent: string;
    key: string | null;
    name: string | null;
    billing_method: string | null;
    invoicing_profile: InvoicingProfile | null;
  }>(
    sql`
    select project.id, project.project_type_id, coalesce(project.contract_value, 0)::text as contract_value,
           coalesce((project.custom->>'markupPercent')::numeric, 0)::text as markup_percent,
           type.key, type.name, type.billing_method, type.invoicing_profile
      from projects project
      left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
     where project.org_id = ${orgId} and project.id = ${projectId}
       and project.status not in ('closed', 'cancelled')
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     ${lock ? sql`for update of project` : sql``}
  `,
    "objects",
  );
  const row = project[0];
  if (!row) throw new PreBillingError("Project not found or is no longer active", 404);
  if (!row.project_type_id || !row.invoicing_profile) {
    throw new PreBillingError("Assign an active project type before creating a prebill");
  }
  // The financial policy is the effective-dated version history — the ONLY
  // place a profile lives. The newest published version is the fallback for a
  // source dated before the first window; no published version fails closed.
  const versions = await executor.execute<PreBillingPolicyVersion>(
    sql`
    select id, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
           financial_profile as "financialProfile"
      from project_financial_profile_versions
     where org_id = ${orgId} and project_type_id = ${row.project_type_id}
     order by effective_from desc
  `,
    "objects",
  );
  const latest = versions[0];
  if (!latest)
    throw new PreBillingError(
      "Publish a financial profile for the project type before creating a prebill",
    );
  return {
    projectId: row.id,
    projectTypeId: row.project_type_id,
    projectTypeKey: row.key ?? "project",
    projectTypeName: row.name ?? "Project",
    billingMethod: row.billing_method,
    contractValue: normalizeMoney(row.contract_value),
    markupPercent: normalizeMoney(row.markup_percent),
    fallbackProfile: latest.financialProfile,
    invoicingProfile: row.invoicing_profile,
    versions,
  };
}

export async function remainingContractCapacity(
  executor: Executor,
  orgId: string,
  policy: ProjectPolicyContext,
  asOf: string,
  excludePrebillId?: string,
): Promise<string | null> {
  const profile = effectivePreBillingPolicy(
    policy.versions,
    policy.fallbackProfile,
    asOf,
  ).financialProfile;
  if (profile.totalPrice.method !== "not_to_exceed") return null;
  // A ceiling that was never entered is unknown, not zero: billing-request
  // invoicing and Financials both read it that way (no ceiling ⇒ no cap),
  // so prebilling must agree instead of refusing every worksheet.
  if (cmp(policy.contractValue, "0") <= 0) return null;
  const used = await projectContractCapacityUsed(
    executor,
    orgId,
    policy.projectId,
    profile.invoicedToDate,
    { excludePrebillId },
  );
  const remaining = add(policy.contractValue, `-${used}`);
  return cmp(remaining, "0") > 0 ? remaining : "0.0000";
}

/**
 * Whether the CURRENT policy prices this project under an NTE ceiling as of
 * a date — independent of the worksheet's creation-time snapshot. A project
 * type switch after approval would otherwise silently drop a ceiling the
 * sibling billing path still enforces. Soft read: a missing type or
 * unpublished policy is simply not NTE here (the snapshot branch keeps its
 * own strict accounting), so this check can never strand a worksheet that
 * the snapshot branch would have let through.
 */
export async function currentPolicyIsNte(
  executor: Executor,
  orgId: string,
  projectId: string,
  asOf: string,
): Promise<boolean> {
  const row = await executor.execute<{ project_type_id: string | null }>(
    sql`
    select project_type_id from projects where id = ${projectId} and org_id = ${orgId}
  `,
    "objects",
  );
  const typeId = row[0]?.project_type_id;
  if (!typeId) return false;
  const versions = await executor.execute<PreBillingPolicyVersion>(
    sql`
    select id, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
           financial_profile as "financialProfile"
      from project_financial_profile_versions
     where org_id = ${orgId} and project_type_id = ${typeId}
     order by effective_from desc
  `,
    "objects",
  );
  const latest = versions[0];
  if (!latest) return false;
  return (
    effectivePreBillingPolicy(versions, latest.financialProfile, asOf).financialProfile.totalPrice
      .method === "not_to_exceed"
  );
}

export function rateEngineOverhead(
  source: RawPreBillingSource,
  profile: FinancialProfile,
  rates: OverheadRateRow[],
): string {
  if (source.source_type !== "time_entry" || profile.overhead.method !== "rate_engine")
    return "0.0000";
  const basis = profile.overhead.rateEngine?.hoursBasis ?? "total_hours";
  if (basis === "actual_hours" && source.costing_basis !== "actual") return "0.0000";
  const effective = rates.filter(
    (rate) =>
      rate.effective_from <= source.source_date &&
      (rate.effective_to == null || rate.effective_to >= source.source_date) &&
      (rate.department_id == null || rate.department_id === source.department_id),
  );
  // Department specificity is per rate KIND, mirroring the posting rule
  // (`overheadRateAppliesToTimeEntry`): a department row steps aside only the
  // org-wide rows of its own kind, so rows of one scope still stack.
  const hasSpecificOfKind = (rateKind: OverheadRateRow["rate_kind"]) =>
    source.department_id != null &&
    effective.some(
      (rate) => rate.rate_kind === rateKind && rate.department_id === source.department_id,
    );
  return sum(
    effective
      .filter((rate) => rate.department_id != null || !hasSpecificOfKind(rate.rate_kind))
      .map((rate) =>
        rate.rate_kind === "percent"
          ? mulPercent(source.direct_cost_amount, rate.rate)
          : mul(source.quantity, rate.rate),
      ),
  );
}

export function requireDate(value: string, label: string): string {
  if (!isIsoCalendarDate(value)) {
    throw new PreBillingError(`${label} must be a valid date`);
  }
  return value;
}

export function evidenceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

export async function appendEvent(
  tx: Tx,
  orgId: string,
  prebillId: string,
  actorId: string,
  eventType: string,
  details: Record<string, unknown> = {},
) {
  await tx.execute(sql`
    insert into prebill_events (org_id, prebill_id, event_type, actor_id, details)
    values (${orgId}, ${prebillId}, ${eventType}, ${actorId}, ${JSON.stringify(details)}::jsonb)
  `);
}

export async function audit(
  tx: Tx,
  orgId: string,
  tableName: string,
  rowId: string,
  actorId: string,
  changes: Record<string, unknown>,
) {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${tableName}, ${rowId}, 'update', ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

export async function refreshTotals(tx: Tx, orgId: string, prebillId: string, actorId: string) {
  await tx.execute(sql`
    update prebills worksheet
       set original_bill_amount = totals.original_bill,
           proposed_bill_amount = totals.proposed_bill,
           cost_amount = totals.cost,
           adjustment_amount = totals.proposed_bill - totals.original_bill,
           updated_at = now(),
           updated_by = ${actorId}
      from (
        select coalesce(sum(original_bill_amount) filter (where disposition = 'bill'), 0) as original_bill,
               coalesce(sum(proposed_bill_amount) filter (where disposition = 'bill'), 0) as proposed_bill,
               coalesce(sum(cost_amount) filter (where disposition = 'bill'), 0) as cost
          from prebill_lines
         where org_id = ${orgId} and prebill_id = ${prebillId}
      ) totals
     where worksheet.org_id = ${orgId} and worksheet.id = ${prebillId}
  `);
}
