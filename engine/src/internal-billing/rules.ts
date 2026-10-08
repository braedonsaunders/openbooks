import { sql } from "drizzle-orm";
import { INTERNAL_BILLING_METHODS } from "@openbooks/schema";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { assertUnrestrictedScope } from "../organization/subsidiary-scope.ts";
import type { InternalBillingAccountFacts } from "../journal/posting-contracts.ts";
import {
  assertInternalBillingRuleAccounts,
  InternalBillingPolicyError,
  type InternalBillingMethod,
} from "../ledger/internal-billing-policy.ts";
import { INTERNAL_BILLING_DISABLED, InternalBillingError } from "./errors.ts";

/**
 * Internal billing rules: effective-dated accounting treatments. A rule is
 * identified by its code; each version fixes the method and both accounts
 * for a date window. A new version closes the window of the version in
 * effect before it, so exactly one version governs any date. Versions are
 * never deleted or rewritten (a storage trigger enforces it): a version
 * that was a mistake is deactivated, and a changed treatment is a new
 * version from a later date.
 */

export interface InternalBillingRuleRow {
  id: string;
  code: string;
  name: string;
  method: InternalBillingMethod;
  debitAccountId: string;
  creditAccountId: string;
  billableByDefault: boolean;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

const RULE_COLUMNS = sql`
  id, code, name, method,
  debit_account_id as "debitAccountId", credit_account_id as "creditAccountId",
  billable_by_default as "billableByDefault", description,
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
  is_active as "isActive"`;

export interface InternalBillingRuleInput {
  code: string;
  name: string;
  method: string;
  debitAccountId: string;
  creditAccountId: string;
  billableByDefault?: boolean;
  description?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface InternalBillingRulePatch {
  name?: string;
  description?: string | null;
  billableByDefault?: boolean;
  effectiveTo?: string | null;
  isActive?: boolean;
}

/** Every version, newest window first within each code. */
export async function listInternalBillingRules(
  orgId: string,
  runner: SqlExecutor = db,
): Promise<InternalBillingRuleRow[]> {
  return (await runner.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
    select ${RULE_COLUMNS}
      from internal_billing_rules
     where org_id = ${orgId}
     order by code, effective_from desc, created_at desc`)).rows;
}

/** The active version of `code` governing `date`, or null when none does. */
export async function internalBillingRuleInEffect(
  runner: SqlExecutor,
  orgId: string,
  code: string,
  date: string,
): Promise<InternalBillingRuleRow | null> {
  return (await runner.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
    select ${RULE_COLUMNS}
      from internal_billing_rules
     where org_id = ${orgId} and code = ${code} and is_active
       and effective_from <= ${date}::date
       and (effective_to is null or effective_to >= ${date}::date)
     limit 1`)).rows[0] ?? null;
}

/** Account facts for the policy; null when the account is not in this org. */
export async function loadInternalBillingAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<InternalBillingAccountFacts | null> {
  if (!isUuid(accountId)) return null;
  const row = (await runner.execute<{
    id: string; number: string | null; name: string; type: string; eliminate: boolean; is_active: boolean; is_summary: boolean;
  }>(sql`
    select id, number, name, type, eliminate, is_active, is_summary
      from accounts where org_id = ${orgId} and id = ${accountId}`)).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: [row.number, row.name].filter(Boolean).join(" "),
    type: row.type,
    eliminate: row.eliminate,
    isActive: row.is_active,
    isSummary: row.is_summary,
  };
}

function requireReason(reason: unknown): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 8 || value.length > 500) {
    throw new InternalBillingError("a reason between 8 and 500 characters is required");
  }
  return value;
}

function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    throw new InternalBillingError(`${label} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new InternalBillingError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InternalBillingError(`${label} must be at most ${max} characters`);
  return trimmed || null;
}

function isMethod(value: unknown): value is InternalBillingMethod {
  return typeof value === "string" && (INTERNAL_BILLING_METHODS as readonly string[]).includes(value);
}

async function requireFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "internalBilling"))) {
    throw new InternalBillingError(INTERNAL_BILLING_DISABLED, 404);
  }
}

/**
 * Committed documents (submitted, approved or posted) under a version whose
 * date would fall outside `window`. A window may only change where it does
 * not reinterpret them.
 */
async function committedDocumentsOutside(
  orgId: string,
  ruleId: string,
  window: { from: string; to: string | null },
): Promise<number> {
  const row = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents
     where org_id = ${orgId} and kind = 'internal_billing' and internal_billing_rule_id = ${ruleId}
       -- Live entries only: a voided document no longer depends on this version's window.
       and status in ('pending_approval', 'approved', 'posted')
       and (document_date < ${window.from}::date
            ${window.to ? sql`or document_date > ${window.to}::date` : sql``})`)).rows[0];
  return row?.n ?? 0;
}

async function audit(
  orgId: string,
  actorId: string,
  ruleId: string,
  action: "insert" | "update",
  before: InternalBillingRuleRow | null,
  after: InternalBillingRuleRow,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'internal_billing_rules', ${ruleId}, ${action},
            ${JSON.stringify({ before, after, reason })}::jsonb, ${actorId})`);
}

function storageRefusal(error: unknown): InternalBillingError | null {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "23P01") {
    return new InternalBillingError(
      "another active version of this rule already covers those dates; close its window or deactivate it first",
      409,
    );
  }
  if (code === "23505") {
    return new InternalBillingError("this rule changed while you were saving; reload and try again", 409);
  }
  return null;
}

/**
 * Add a version of a rule. When a version of the same code is in effect on
 * or after the new start date, its window closes the day before; a version
 * that starts on or after the new date is refused (deactivate it first), as
 * is closing a window under documents already committed beyond it.
 */
export async function createInternalBillingRuleVersion(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  rule: InternalBillingRuleInput;
  reason: string;
}): Promise<InternalBillingRuleRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  const input = args.rule;
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (code.length < 1 || code.length > 40) throw new InternalBillingError("code must be 1 to 40 characters");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 120) throw new InternalBillingError("name must be 1 to 120 characters");
  if (!isMethod(input.method)) {
    throw new InternalBillingError("method must be revenue_credit, cost_transfer or intercompany_sale");
  }
  const method = input.method;
  const effectiveFrom = requireDate(input.effectiveFrom, "effective from");
  const effectiveTo = input.effectiveTo == null || input.effectiveTo === "" ? null : requireDate(input.effectiveTo, "effective to");
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new InternalBillingError("effective to must be on or after effective from");
  }
  const description = optionalText(input.description, "description", 500);
  const billableByDefault = input.billableByDefault === true;
  if (billableByDefault && method === "revenue_credit") {
    throw new InternalBillingError("a department credit is never billable to a customer; clear Billable by default");
  }
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireFeature(args.orgId);
      if (method === "intercompany_sale" && !(await lockAndCheckOrgFeature(db, args.orgId, "multiSubsidiary"))) {
        throw new InternalBillingError("an intercompany sale needs Multi-subsidiary; turn it on in Company Settings → Features");
      }
      const debit = await loadInternalBillingAccount(db, args.orgId, input.debitAccountId);
      const credit = await loadInternalBillingAccount(db, args.orgId, input.creditAccountId);
      if (!debit || !credit) throw new InternalBillingError("choose the receiving and providing accounts from the Chart of accounts");
      try {
        assertInternalBillingRuleAccounts(method, debit, credit);
      } catch (error) {
        if (error instanceof InternalBillingPolicyError) throw new InternalBillingError(error.message);
        throw error;
      }
      // Serialize versioning of one code.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:internal-billing-rule:${args.orgId}:${code}`}, 0))`);
      const versions = (await db.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
        select ${RULE_COLUMNS} from internal_billing_rules
         where org_id = ${args.orgId} and code = ${code} and is_active
         order by effective_from
         for update`)).rows;
      const later = versions.find((version) => version.effectiveFrom >= effectiveFrom);
      if (later) {
        throw new InternalBillingError(
          `version ${later.effectiveFrom} of ${code} starts on or after ${effectiveFrom}; choose a later start date or deactivate that version first`,
        );
      }
      const prior = versions.find((version) => version.effectiveTo == null || version.effectiveTo >= effectiveFrom);
      if (prior) {
        const closeTo = (await db.execute<{ d: string }>(sql`select (${effectiveFrom}::date - 1)::text as d`)).rows[0]!.d;
        const blocked = await committedDocumentsOutside(args.orgId, prior.id, { from: prior.effectiveFrom, to: closeTo });
        if (blocked > 0) {
          throw new InternalBillingError(
            `${blocked} committed document(s) dated on or after ${effectiveFrom} use the current version of ${code}; start the new version after them`,
          );
        }
        const closed = (await db.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
          update internal_billing_rules
             set effective_to = ${closeTo}::date, updated_at = now(), updated_by = ${args.actorId}
           where org_id = ${args.orgId} and id = ${prior.id}
           returning ${RULE_COLUMNS}`)).rows[0];
        if (!closed) throw new InternalBillingError("this rule changed while you were saving; reload and try again", 409);
        await audit(args.orgId, args.actorId, prior.id, "update", prior, closed, reason);
      }
      const created = (await db.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
        insert into internal_billing_rules (org_id, code, name, method, debit_account_id, credit_account_id,
                                            billable_by_default, description, effective_from, effective_to,
                                            created_by, updated_by)
        values (${args.orgId}, ${code}, ${name}, ${method}, ${debit.id}, ${credit.id},
                ${billableByDefault}, ${description}, ${effectiveFrom}::date, ${effectiveTo}::date,
                ${args.actorId}, ${args.actorId})
        returning ${RULE_COLUMNS}`)).rows[0];
      if (!created) throw new Error("internal billing rule insert returned no row");
      await audit(args.orgId, args.actorId, created.id, "insert", null, created, reason);
      return created;
    });
  } catch (error) {
    throw storageRefusal(error) ?? error;
  }
}

/**
 * Change what a version may change: its name, description, billable
 * default, the end of its window, and whether it is active. The method,
 * accounts and start date are its accounting facts and stay fixed.
 */
export async function updateInternalBillingRuleVersion(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  id: string;
  patch: InternalBillingRulePatch;
  reason: string;
}): Promise<InternalBillingRuleRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  if (!isUuid(args.id)) throw new InternalBillingError("rule not found", 404);
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireFeature(args.orgId);
      const before = (await db.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
        select ${RULE_COLUMNS} from internal_billing_rules
         where org_id = ${args.orgId} and id = ${args.id}
         for update`)).rows[0];
      if (!before) throw new InternalBillingError("rule not found", 404);
      const patch = args.patch;
      const name = patch.name === undefined ? before.name : (typeof patch.name === "string" ? patch.name.trim() : "");
      if (name.length < 1 || name.length > 120) throw new InternalBillingError("name must be 1 to 120 characters");
      const description = patch.description === undefined ? before.description : optionalText(patch.description, "description", 500);
      const billableByDefault = patch.billableByDefault === undefined ? before.billableByDefault : patch.billableByDefault === true;
      if (billableByDefault && before.method === "revenue_credit") {
        throw new InternalBillingError("a department credit is never billable to a customer; clear Billable by default");
      }
      const effectiveTo = patch.effectiveTo === undefined
        ? before.effectiveTo
        : patch.effectiveTo === null || patch.effectiveTo === "" ? null : requireDate(patch.effectiveTo, "effective to");
      if (effectiveTo && effectiveTo < before.effectiveFrom) {
        throw new InternalBillingError("effective to must be on or after effective from");
      }
      const isActive = patch.isActive === undefined ? before.isActive : patch.isActive === true;
      if (effectiveTo !== before.effectiveTo) {
        const blocked = await committedDocumentsOutside(args.orgId, before.id, { from: before.effectiveFrom, to: effectiveTo });
        if (blocked > 0) {
          throw new InternalBillingError(
            `${blocked} committed document(s) under this version are dated after ${effectiveTo}; choose a later end date`,
          );
        }
      }
      if (!isActive && before.isActive) {
        const committed = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from documents
           where org_id = ${args.orgId} and kind = 'internal_billing' and internal_billing_rule_id = ${before.id}
             -- Live entries only: a voided document no longer depends on this version.
             and status in ('pending_approval', 'approved', 'posted')`)).rows[0]?.n ?? 0;
        if (committed > 0) {
          throw new InternalBillingError(
            `${committed} committed document(s) use this version; close its window with an end date instead of deactivating it`,
          );
        }
      }
      const after = (await db.execute<InternalBillingRuleRow & Record<string, unknown>>(sql`
        update internal_billing_rules
           set name = ${name}, description = ${description}, billable_by_default = ${billableByDefault},
               effective_to = ${effectiveTo}::date, is_active = ${isActive},
               updated_at = now(), updated_by = ${args.actorId}
         where org_id = ${args.orgId} and id = ${before.id}
         returning ${RULE_COLUMNS}`)).rows[0];
      if (!after) throw new InternalBillingError("this rule changed while you were saving; reload and try again", 409);
      await audit(args.orgId, args.actorId, before.id, "update", before, after, reason);
      return after;
    });
  } catch (error) {
    throw storageRefusal(error) ?? error;
  }
}
