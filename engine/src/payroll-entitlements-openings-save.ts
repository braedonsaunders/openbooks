import { sql } from "drizzle-orm";
import { canonicalDecimal } from "./exact-decimal.ts";
import { db } from "./db.ts";
import { cmp, neg, normalizeMoney } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";
import { recordEntitlementMovements } from "./payroll-entitlements-stub.ts";
import {
  entitlementPlans,
  resolvePlanLimit,
  type Executor,
} from "./payroll-entitlements-db.ts";
import {
  assertMovementDate,
  entitlementOpeningBlocks,
  entitlementOpeningLocks,
} from "./payroll-entitlements-openings.ts";
import { type EntitlementPlan } from "./payroll-entitlements-types.ts";

export interface EntitlementOpeningWrite {
  employeePartyId: string;
  /** planId OR plan code → amount in the plan's unit; blank or zero clears it. */
  amounts: Record<string, unknown>;
}

export interface EntitlementOpeningSaveResult {
  created: number;
  updated: number;
  deleted: number;
  /** Nothing is written when this is non-empty. */
  errors: { employeePartyId: string; employeeName?: string; message: string }[];
  /** Written, but worth an operator's attention (a carry-in above its cap). */
  warnings: { employeePartyId: string; employeeName?: string; message: string }[];
}

/**
 * Carries every rejected row out of the aborted transaction.
 *
 * `PayrollError` now lives in its own import-free module (payroll-error.ts)
 * precisely so this `extends` is safe: it used to live in payroll-run.ts, which
 * imports THIS module, so the class expression evaluated before the base
 * existed — `ReferenceError: Cannot access 'PayrollError' before
 * initialization`, at import time, for every consumer.
 */
export class EntitlementOpeningSaveError extends PayrollError {
  constructor(readonly result: EntitlementOpeningSaveResult) {
    super(result.errors[0]?.message ?? "entitlement opening balances were rejected");
    this.name = "EntitlementOpeningSaveError";
  }
}

/**
 * Create or replace bank carry-ins, all-or-nothing, through the ledger.
 *
 * The same three controls the statutory carry-in has, for the same reasons:
 *
 *  1. ALL-OR-NOTHING. Half a workforce's vacation banks carried in and half at
 *     zero is harder to find than an outright failure.
 *  2. IMMUTABLE ONCE CONSUMED. A carry-in a committed run has already read is
 *     inside a cheque; correcting it is a void-and-restate exercise, so this
 *     refuses and names the run. Enforced in the database too — the
 *     `entitlement_ledger` append-only trigger carries the same predicate, so
 *     the control does not depend on every caller coming through here.
 *  3. ZERO IS A DELETE. "No carry-in" and "a carry-in of nothing" are one fact.
 *
 * Replacement is DELETE + INSERT rather than an UPDATE: the ledger refuses
 * UPDATE unconditionally and that is right — a movement's amount is never
 * rewritten in place. An opening no run has read is not history yet, which is
 * the one narrow case the trigger permits deleting.
 *
 * Sign is checked against the plan's DIRECTION rather than quietly normalized:
 * an `accrue` bank the employer owes runs positive, an `owe` balance the
 * employee is repaying runs negative, and a hidden negation here would turn a
 * $1,200 benefit debt into a $1,200 credit on a real cheque.
 */
export async function saveEntitlementOpenings(input: {
  orgId: string;
  actorId: string;
  /** Adoption date every carry-in in this load is dated. */
  movementDate: string;
  rows: EntitlementOpeningWrite[];
  note?: string | null;
  /** Reject (rather than skip) carry-ins a committed run consumed. Default true. */
  strictLocks?: boolean;
}): Promise<EntitlementOpeningSaveResult> {
  const movementDate = assertMovementDate(input.movementDate);
  const result: EntitlementOpeningSaveResult = {
    created: 0, updated: 0, deleted: 0, errors: [], warnings: [],
  };
  if (input.rows.length === 0) return result;

  return db.transaction(async (tx) => {
    const plans = await entitlementPlans(input.orgId, tx);
    if (plans.length === 0) {
      throw new PayrollError(
        "this organization has no active entitlement plans, so there is no bank to carry a "
        + "balance into — configure a plan first",
      );
    }
    const planByKey = new Map<string, EntitlementPlan>();
    for (const plan of plans) {
      planByKey.set(plan.id, plan);
      planByKey.set(plan.code.trim().toLowerCase(), plan);
    }

    const names = (await tx.execute<{ id: string; display_name: string }>(sql`
      select p.id, p.display_name from parties p
       where p.org_id = ${input.orgId} and p.id in (
         select (value->>'id')::uuid from jsonb_array_elements(${JSON.stringify(
           input.rows.map((r) => ({ id: r.employeePartyId })),
         )}::jsonb) as value)
    `));
    const nameById = new Map(names.rows.map((r) => [r.id, r.display_name]));

    const existing = (await tx.execute<{ plan_id: string; employee_party_id: string; amount: string }>(sql`
      select plan_id, employee_party_id, amount::text as amount
        from entitlement_ledger
       where org_id = ${input.orgId} and kind = 'opening'
    `));
    const storedKeys = new Set(existing.rows.map((r) => `${r.plan_id}:${r.employee_party_id}`));

    const locks = await entitlementOpeningLocks(input.orgId, tx);
    const blocks = await entitlementOpeningBlocks(input.orgId, movementDate, tx);

    const seen = new Set<string>();
    const planned: {
      employeePartyId: string;
      employeeName: string;
      /** planId → amount, or null to clear. */
      amounts: Map<string, string | null>;
    }[] = [];

    for (const row of input.rows) {
      const employeeName = nameById.get(row.employeePartyId);
      const fail = (message: string) =>
        result.errors.push({ employeePartyId: row.employeePartyId, employeeName, message });
      if (!employeeName) {
        fail("employee not found in this organization");
        continue;
      }
      if (seen.has(row.employeePartyId)) {
        fail("appears more than once in this load");
        continue;
      }
      seen.add(row.employeePartyId);

      const amounts = new Map<string, string | null>();
      for (const [rawKey, raw] of Object.entries(row.amounts)) {
        const key = String(rawKey).trim();
        const plan = planByKey.get(key) ?? planByKey.get(key.toLowerCase());
        if (!plan) {
          fail(`"${key}" is not an active entitlement plan in this organization`);
          continue;
        }
        const stored = storedKeys.has(`${plan.id}:${row.employeePartyId}`);
        const lock = locks.get(`${plan.id}:${row.employeePartyId}`);
        if (lock) {
          if (input.strictLocks !== false) {
            fail(
              `a pay run committed on ${lock.payDate}`
              + `${lock.documentNumber ? ` (${lock.documentNumber})` : ""} already used the `
              + `${plan.code} carry-in; void that run before changing it`,
            );
          }
          continue;
        }

        const cleaned = String(raw ?? "").trim().replace(/[,$]/g, "") || "0";
        const exact = canonicalDecimal(cleaned, 4);
        if (exact === null) {
          fail(`${plan.code} carry-in is not an amount: "${String(raw)}"`);
          continue;
        }
        let value: string;
        try {
          value = normalizeMoney(exact);
        } catch {
          fail(`${plan.code} carry-in is not an amount: "${String(raw)}"`);
          continue;
        }
        if (cmp(value, "0") === 0) {
          if (stored) amounts.set(plan.id, null);
          continue;
        }
        if (plan.direction === "accrue" && cmp(value, "0") < 0) {
          fail(
            `${plan.code} is a bank the employer owes the employee, so its carry-in cannot be `
            + "negative",
          );
          continue;
        }
        if (plan.direction === "owe" && cmp(value, "0") > 0) {
          fail(
            `${plan.code} is a balance the EMPLOYEE owes, so its carry-in must be negative `
            + `(enter ${neg(value)} for an outstanding ${value})`,
          );
          continue;
        }
        // Inserting a carry-in dated on or before a committed run would change
        // the balance that run's stub was computed from. Nothing can put that
        // back, so it is refused rather than warned about.
        const block = blocks.get(row.employeePartyId);
        if (block && !stored) {
          fail(
            `a pay run committed on ${block.payDate}`
            + `${block.documentNumber ? ` (${block.documentNumber})` : ""} already paid this `
            + `employee on or after ${movementDate}; date the carry-in after it, or void the run`,
          );
          continue;
        }
        amounts.set(plan.id, value);

        // A carry-in above the resolved cap is legitimate at adoption (the cap
        // was configured for the future), so it is reported, never refused —
        // refusing would make an accurate liability impossible to record.
        const limit = await resolvePlanLimit(
          tx, input.orgId, plan.id, row.employeePartyId, movementDate,
        );
        if (limit?.maxBalance != null && cmp(value, limit.maxBalance) > 0) {
          result.warnings.push({
            employeePartyId: row.employeePartyId,
            employeeName,
            message: `${plan.code} carry-in ${value} is above the ${limit.maxBalance} limit that `
              + `resolves for this employee (${limit.scope} scope)`,
          });
        }
      }
      planned.push({ employeePartyId: row.employeePartyId, employeeName, amounts });
    }

    if (result.errors.length > 0) throw new EntitlementOpeningSaveError(result);

    for (const row of planned) {
      for (const [planId, amount] of row.amounts) {
        const stored = storedKeys.has(`${planId}:${row.employeePartyId}`);
        if (stored) {
          // The trigger permits this exactly while no committed run has read it.
          await tx.execute(sql`
            delete from entitlement_ledger
             where org_id = ${input.orgId} and plan_id = ${planId}
               and employee_party_id = ${row.employeePartyId} and kind = 'opening'`);
        }
        if (amount === null) {
          result.deleted++;
          await auditEntitlementOpening(tx, {
            orgId: input.orgId, actorId: input.actorId, action: "delete",
            changes: { planId, employeePartyId: row.employeePartyId },
          });
          continue;
        }
        // One insert path for every ledger write in this module.
        await recordEntitlementMovements(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          payRunDocumentId: null,
          movements: [{
            planId,
            employeePartyId: row.employeePartyId,
            movementDate,
            amount,
            hours: null,
            kind: "opening",
            componentId: null,
            note: input.note ?? "Mid-year adoption carry-in",
          }],
        });
        if (stored) result.updated++;
        else result.created++;
        await auditEntitlementOpening(tx, {
          orgId: input.orgId, actorId: input.actorId,
          action: stored ? "update" : "insert",
          changes: { planId, employeePartyId: row.employeePartyId, movementDate, after: amount },
        });
      }
    }

    return result;
  });
}

async function auditEntitlementOpening(
  runner: Executor,
  args: {
    orgId: string; actorId: string | null;
    action: "insert" | "update" | "delete";
    changes: Record<string, unknown>;
  },
): Promise<void> {
  // The ledger row id changes on every replacement (delete + insert), so the
  // audit trail is keyed to the PLAN — the thing whose balance moved and the
  // thing an auditor asks about.
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'entitlement_ledger', ${String(args.changes.planId)}, ${args.action},
            ${JSON.stringify({ kind: "opening", ...args.changes })}, ${args.actorId})`);
}
