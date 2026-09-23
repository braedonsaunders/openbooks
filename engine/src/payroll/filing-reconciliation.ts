import { sql } from "drizzle-orm";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

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
        // Historical payroll belongs to its original pay-run entity. Hold that
        // document against a concurrent void before resolving its source stub,
        // exactly as the liability reconciliation does for its lines.
        const source = (await db.execute<{ subsidiary_id: string | null; subsidiary_name: string | null }>(sql`
          select d.subsidiary_id, ent.name as subsidiary_name from pay_stubs s
          join documents d on d.org_id=s.org_id and d.id=s.pay_run_document_id
          left join subsidiaries ent on ent.org_id=s.org_id and ent.id=d.subsidiary_id
          where s.org_id=${input.orgId} and s.id=${row.stubId} for share of d`)).rows[0];
        const allowed = await actorAllowedSubsidiaryIds(db,input.orgId,input.actorId);
        if (!source || (allowed !== null && (!source.subsidiary_id || !allowed.has(source.subsidiary_id)))) {
          throw new PayrollError("Historical payroll is not visible in this organization and legal-entity scope.");
        }
        // A filing account registered to another entity must never stamp this
        // stub: the bill creator refuses the mismatch, and the one-time
        // unknown→reconciled guard would make it uncorrectable. Org-wide
        // (null-subsidiary) accounts stay usable everywhere. An account the
        // org does not hold falls through to the update, where the tenant FK
        // and country guard refuse it as before.
        if (row.filingAccountId !== null) {
          const account = (await db.execute<{
            subsidiary_id: string | null; account_number: string | null;
            name: string | null; entity_name: string | null;
          }>(sql`
            select a.subsidiary_id, a.account_number, a.name, ent.name as entity_name
              from payroll_filing_accounts a
              left join subsidiaries ent on ent.org_id=a.org_id and ent.id=a.subsidiary_id
             where a.org_id=${input.orgId} and a.id=${row.filingAccountId}`)).rows[0] ?? null;
          if (account && account.subsidiary_id != null && account.subsidiary_id !== source.subsidiary_id) {
            const label = account.account_number ?? account.name ?? row.filingAccountId;
            const accountEntity = account.entity_name ?? account.subsidiary_id;
            if (source.subsidiary_id == null) {
              throw new PayrollError(
                `Cannot reconcile pay stub ${row.stubId} with filing account ${label} registered to ${accountEntity}: ` +
                `the stub's pay run has no recorded legal entity. Reconcile with an org-wide filing account.`,
              );
            }
            const stubEntity = source.subsidiary_name ?? source.subsidiary_id;
            throw new PayrollError(
              `Cannot reconcile pay stub ${row.stubId} with filing account ${label} registered to ${accountEntity}: ` +
              `the stub's pay run belongs to ${stubEntity}. ` +
              `Reconcile with a filing account registered to ${stubEntity}, or an org-wide account.`,
            );
          }
        }
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
