import { sql } from "drizzle-orm";
import { actorHasPermission } from "./actor-permissions.ts";
import { db, withOrgTransaction } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";

export interface PayrollFilingReconciliation {
  stubId: string;
  /** Explicit null confirms that the original payroll was unassigned. */
  filingAccountId: string | null;
  reason: string;
  /** Durable reference to the original payroll register/issued filing evidence. */
  reference: string;
}

/**
 * Operational upgrade reconciliation, not a way to reassign captured history.
 * The DB guard allows unknown -> reconciled exactly once and writes the full
 * before/after evidence atomically. A failed row rolls back the whole batch.
 */
export async function reconcilePayrollFilingAccounts(input: {
  orgId: string;
  actorId: string;
  rows: readonly PayrollFilingReconciliation[];
}): Promise<number> {
  if (!input.rows.length || input.rows.length > 1000) {
    throw new PayrollError(
      "Provide between 1 and 1000 reviewed payroll attribution rows.",
    );
  }
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (
      !row ||
      typeof row.stubId !== "string" ||
      !uuid.test(row.stubId) ||
      (row.filingAccountId !== null &&
        (typeof row.filingAccountId !== "string" ||
          !uuid.test(row.filingAccountId))) ||
      typeof row.reason !== "string" ||
      !row.reason.trim() ||
      typeof row.reference !== "string" ||
      !row.reference.trim()
    ) {
      throw new PayrollError(
        "Each row needs a stub UUID, an explicit account UUID or null, a reason, and an original evidence reference.",
      );
    }
    if (seen.has(row.stubId.toLowerCase()))
      throw new PayrollError("Duplicate stub in reconciliation batch.");
    seen.add(row.stubId.toLowerCase());
  }
  return withOrgTransaction(input.orgId, async () => {
    if (
      !(await actorHasPermission(
        db,
        input.orgId,
        input.actorId,
        "payroll.manage",
      ))
    ) {
      throw new PayrollError(
        "Payroll management permission is required to reconcile legacy filing attribution.",
      );
    }
    await db.execute(sql`savepoint payroll_filing_reconciliation`);
    try {
      // Stable order prevents competing reviewed batches from deadlocking.
      for (const row of [...input.rows].sort((a, b) =>
        a.stubId.localeCompare(b.stubId),
      )) {
        const result = await db.execute(sql`
        update pay_stubs set filing_account_id = ${row.filingAccountId},
          filing_account_source = 'reconciled',
          filing_account_evidence = ${JSON.stringify({ reason: row.reason.trim(), reference: row.reference.trim() })}::jsonb,
          updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${row.stubId}
           and filing_account_source = 'unknown'
         returning id
      `);
        if (result.rows.length !== 1) {
          throw new PayrollError(
            `Pay stub ${row.stubId} is not unresolved legacy payroll in this organization.`,
          );
        }
      }
      await db.execute(sql`release savepoint payroll_filing_reconciliation`);
      return input.rows.length;
    } catch (error) {
      await db.execute(
        sql`rollback to savepoint payroll_filing_reconciliation`,
      );
      await db.execute(sql`release savepoint payroll_filing_reconciliation`);
      throw error;
    }
  });
}
