import { lockManufacturingPolicyAuthority } from "./authority.ts";
import { sql } from "drizzle-orm";
import { cmpMoney, parseMoney, type Money } from "../money/brands.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { ManufacturingError } from "./errors.ts";
import { auditChange, compareDecimal, decimalValue, refused } from "./master-support.ts";

export interface ManufacturingPolicies {
  shortagePolicy: "warn" | "refuse";
  completionTolerancePct: string;
  abnormalScrapApprovalThreshold: Money | null;
}

export interface ManufacturingPoliciesInput {
  shortagePolicy: "warn" | "refuse";
  completionTolerancePct: string;
  abnormalScrapApprovalThreshold: string | null;
}

export const DEFAULT_MANUFACTURING_POLICIES: ManufacturingPolicies = {
  shortagePolicy: "warn",
  completionTolerancePct: "1",
  abnormalScrapApprovalThreshold: null,
};

function readSettings(value: unknown): ManufacturingPolicies {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) {
    throw new ManufacturingError("Stored manufacturing policies must be an object.", {
      code: "invalid_stored_policy", remedy: "Replace manufacturing policies with the fields in Manufacturing setup.",
    });
  }
  const stored = value as Record<string, unknown> | null | undefined;
  const shortagePolicy = stored && Object.hasOwn(stored, "shortagePolicy")
    ? stored.shortagePolicy : DEFAULT_MANUFACTURING_POLICIES.shortagePolicy;
  const tolerance = stored && Object.hasOwn(stored, "completionTolerancePct")
    ? stored.completionTolerancePct : DEFAULT_MANUFACTURING_POLICIES.completionTolerancePct;
  const threshold = stored && Object.hasOwn(stored, "abnormalScrapApprovalThreshold")
    ? stored.abnormalScrapApprovalThreshold : DEFAULT_MANUFACTURING_POLICIES.abnormalScrapApprovalThreshold;
  if (shortagePolicy !== "warn" && shortagePolicy !== "refuse") {
    throw new ManufacturingError("Stored manufacturing shortage policy is invalid.", { code: "invalid_stored_policy", remedy: "Set shortage policy to warn or refuse in manufacturing setup." });
  }
  const completionTolerancePct = decimalValue(tolerance, "completionTolerancePct", "Set a percentage from 0 through 100.");
  if (compareDecimal(completionTolerancePct, "100") > 0) {
    throw new ManufacturingError("Stored completion tolerance must be from 0 through 100.", { code: "invalid_stored_policy", field: "completionTolerancePct", remedy: "Set a percentage from 0 through 100 in manufacturing setup." });
  }
  let abnormalScrapApprovalThreshold: Money | null = null;
  if (threshold !== null) {
    const amount = decimalValue(threshold, "abnormalScrapApprovalThreshold", "Enter a non-negative amount or clear the threshold.");
    try { abnormalScrapApprovalThreshold = parseMoney(amount); }
    catch {
      throw new ManufacturingError("Stored manufacturing approval threshold is not a monetary amount.", {
        code: "invalid_stored_policy", field: "abnormalScrapApprovalThreshold",
        remedy: "Set a non-negative amount with no more than four decimal places, or clear the threshold in manufacturing setup.",
      });
    }
  }
  return { shortagePolicy, completionTolerancePct, abnormalScrapApprovalThreshold };
}

export async function getManufacturingPolicies(tx: SqlExecutor, orgId: string): Promise<ManufacturingPolicies> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const result = await tx.execute<{ manufacturing: unknown }>(sql`select settings->'manufacturing' as manufacturing from orgs where id=${orgId}`);
  if (!result.rows[0]) throw new ManufacturingError("The organization could not be found.", { status: 404, code: "not_found" });
  return readSettings(result.rows[0].manufacturing);
}

export async function updateManufacturingPolicies(
  tx: SqlExecutor, orgId: string, actorId: string, input: ManufacturingPoliciesInput,
): Promise<ManufacturingPolicies> {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  await lockManufacturingPolicyAuthority(tx,orgId,actorId);
  if (!input || (input.shortagePolicy !== "warn" && input.shortagePolicy !== "refuse")) {
    refused("Choose whether material shortages warn or refuse.", "invalid_shortage_policy", "shortagePolicy", "Choose warn or refuse.");
  }
  const completionTolerancePct = decimalValue(input.completionTolerancePct, "completionTolerancePct", "Enter a percentage from 0 through 100.");
  if (compareDecimal(completionTolerancePct, "100") > 0) {
    refused("Completion tolerance must be from 0 through 100.", "invalid_tolerance", "completionTolerancePct", "Enter a percentage from 0 through 100.");
  }
  let abnormalScrapApprovalThreshold: Money | null = null;
  if (input.abnormalScrapApprovalThreshold !== null) {
    const amount = decimalValue(input.abnormalScrapApprovalThreshold, "abnormalScrapApprovalThreshold", "Enter a non-negative exact amount or clear the threshold.");
    try { abnormalScrapApprovalThreshold = parseMoney(amount); }
    catch { refused("The approval threshold must be an exact monetary amount.", "invalid_scrap_threshold", "abnormalScrapApprovalThreshold", "Enter a non-negative amount with no more than four decimal places, or clear the threshold."); }
    if (cmpMoney(abnormalScrapApprovalThreshold, "0.0000") < 0) {
      refused("The approval threshold cannot be negative.", "invalid_scrap_threshold", "abnormalScrapApprovalThreshold", "Enter a non-negative amount or clear the threshold.");
    }
  }
  const locked = await tx.execute(sql`select id from orgs where id=${orgId} for update`);
  if (!locked.rows.length) throw new ManufacturingError("The organization could not be found.", { status: 404, code: "not_found" });
  const before = await getManufacturingPolicies(tx, orgId);
  const after = { shortagePolicy: input.shortagePolicy, completionTolerancePct, abnormalScrapApprovalThreshold };
  const result = await tx.execute<{ id: string }>(sql`
    update orgs
       set settings=jsonb_set(coalesce(settings, '{}'::jsonb), '{manufacturing}', ${JSON.stringify(after)}::jsonb, true),
           updated_at=now(), updated_by=${actorId}
     where id=${orgId}
    returning id`);
  if (result.rows.length !== 1) throw new ManufacturingError("Manufacturing policies were not saved.", { status: 404, code: "not_found", remedy: "Reload setup and try again." });
  await auditChange(tx, { orgId, actorId, table: "orgs", rowId: orgId, action: "update", before: { manufacturing: before }, after: { manufacturing: after } });
  return after;
}
