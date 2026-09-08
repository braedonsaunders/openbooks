import { sql } from "drizzle-orm";
import { actorAllowedSubsidiaryIds } from "./actor-subsidiaries.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import { db, withOrgTransaction } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";

export interface PayrollLiabilityReconciliation {
  lineId: string;
  accountId: string;
  reason: string;
  /** Durable reference to the original payroll posting/register evidence. */
  reference: string;
}

/**
 * Operational upgrade reconciliation, not a way to reassign captured history.
 * The DB guard allows unknown -> reconciled exactly once and writes the full
 * before/after evidence atomically. A failed row rolls back the whole batch.
 */
export async function reconcilePayrollLiabilityAccounts(input: {
  orgId: string;
  actorId: string;
  rows: readonly PayrollLiabilityReconciliation[];
}): Promise<number> {
  if (!input.rows.length || input.rows.length > 1000) {
    throw new PayrollError(
      "Provide between 1 and 1000 reviewed payroll liability rows.",
    );
  }
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (
      !row ||
      typeof row.lineId !== "string" ||
      !uuid.test(row.lineId) ||
      (typeof row.accountId !== "string" || !uuid.test(row.accountId)) ||
      typeof row.reason !== "string" ||
      !row.reason.trim() ||
      typeof row.reference !== "string" ||
      !row.reference.trim()
    ) {
      throw new PayrollError(
        "Each row needs a payroll-line UUID, an original liability account UUID, a reason, and an original evidence reference.",
      );
    }
    if (seen.has(row.lineId.toLowerCase()))
      throw new PayrollError("Duplicate line in reconciliation batch.");
    seen.add(row.lineId.toLowerCase());
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
        "Payroll management permission is required to reconcile legacy liability attribution.",
      );
    }
    await db.execute(sql`savepoint payroll_liability_reconciliation`);
    try {
      // Stable order prevents competing reviewed batches from deadlocking.
      for (const row of [...input.rows].sort((a, b) =>
        a.lineId.localeCompare(b.lineId),
      )) {
        // Historical payroll belongs to its original pay-run entity. Hold that
        // document against a concurrent void before resolving its source line.
        const source = (await db.execute<{ subsidiary_id: string | null }>(sql`
          select d.subsidiary_id from pay_stub_lines l
          join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
          join documents d on d.org_id=s.org_id and d.id=s.pay_run_document_id
          where l.org_id=${input.orgId} and l.id=${row.lineId} for share of d`)).rows[0];
        const allowed = await actorAllowedSubsidiaryIds(db,input.orgId,input.actorId);
        if (!source || (allowed !== null && (!source.subsidiary_id || !allowed.has(source.subsidiary_id)))) {
          throw new PayrollError("Historical payroll line is not visible in this organization and legal-entity scope.");
        }
        if (!(await actorHasPermission(db,input.orgId,input.actorId,"payroll.manage"))) {
          throw new PayrollError("Payroll management permission is required to reconcile legacy liability attribution.");
        }
        const result = await db.execute(sql`
        update pay_stub_lines set liability_account_id = ${row.accountId},
          liability_account_source = 'reconciled',
          liability_account_evidence = ${JSON.stringify({ reason: row.reason.trim(), reference: row.reference.trim() })}::jsonb,
          updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${row.lineId}
           and liability_account_source = 'unknown'
         returning id
      `);
        if (result.rows.length !== 1) {
          throw new PayrollError(
            `Payroll line ${row.lineId} is not unresolved legacy payroll in this organization.`,
          );
        }
      }
      await db.execute(sql`release savepoint payroll_liability_reconciliation`);
      return input.rows.length;
    } catch (error) {
      await db.execute(
        sql`rollback to savepoint payroll_liability_reconciliation`,
      );
      await db.execute(sql`release savepoint payroll_liability_reconciliation`);
      throw error;
    }
  });
}
