import { sql } from "drizzle-orm";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

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
        const source = (await db.execute<{ subsidiary_id: string | null; subsidiary_name: string | null }>(sql`
          select d.subsidiary_id, ent.name as subsidiary_name from pay_stub_lines l
          join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
          join documents d on d.org_id=s.org_id and d.id=s.pay_run_document_id
          left join subsidiaries ent on ent.org_id=l.org_id and ent.id=d.subsidiary_id
          where l.org_id=${input.orgId} and l.id=${row.lineId} for share of d`)).rows[0];
        const allowed = await actorAllowedSubsidiaryIds(db,input.orgId,input.actorId);
        if (!source || (allowed !== null && (!source.subsidiary_id || !allowed.has(source.subsidiary_id)))) {
          throw new PayrollError("Historical payroll line is not visible in this organization and legal-entity scope.");
        }
        if (!(await actorHasPermission(db,input.orgId,input.actorId,"payroll.manage"))) {
          throw new PayrollError("Payroll management permission is required to reconcile legacy liability attribution.");
        }
        // Resolve the account like the filing path: an id the org does not
        // hold, one restricted to another legal entity, or one that cannot
        // carry a posting must refuse by name here. Falling through to the
        // update would surface only a raw database error from the tenant FK
        // or the liability guard — and the one-time unknown→reconciled guard
        // would make a bad stamp permanent and misroute remittance grouping.
        const account = (await db.execute<{
          subsidiary_id: string | null; number: string | null;
          name: string | null; type: string; is_summary: boolean;
          entity_name: string | null;
        }>(sql`
          select a.subsidiary_id, a.number, a.name, a.type, a.is_summary, ent.name as entity_name
            from accounts a
            left join subsidiaries ent on ent.org_id=a.org_id and ent.id=a.subsidiary_id
           where a.org_id=${input.orgId} and a.id=${row.accountId}`)).rows[0] ?? null;
        if (!account) {
          throw new PayrollError(
            `Cannot reconcile payroll line ${row.lineId} with liability account ${row.accountId}: ` +
            `this organization holds no account with that id. Create it in the chart of accounts first, then reconcile.`,
          );
        }
        const accountLabel = account.number ?? account.name ?? row.accountId;
        if (account.subsidiary_id != null && account.subsidiary_id !== source.subsidiary_id) {
          const accountEntity = account.entity_name ?? account.subsidiary_id;
          if (source.subsidiary_id == null) {
            throw new PayrollError(
              `Cannot reconcile payroll line ${row.lineId} with liability account ${accountLabel} restricted to ${accountEntity}: ` +
              `the line's pay run has no recorded legal entity. Reconcile with an org-wide liability account.`,
            );
          }
          const lineEntity = source.subsidiary_name ?? source.subsidiary_id;
          throw new PayrollError(
            `Cannot reconcile payroll line ${row.lineId} with liability account ${accountLabel} restricted to ${accountEntity}: ` +
            `the line's pay run belongs to ${lineEntity}. ` +
            `Reconcile with a liability account available to ${lineEntity}, or an org-wide account.`,
          );
        }
        if (account.is_summary || !account.type.startsWith("liability")) {
          const kind = account.is_summary
            ? "a summary account"
            : `${/^[aeiou]/i.test(account.type) ? "an" : "a"} ${account.type} account`;
          throw new PayrollError(
            `Cannot reconcile payroll line ${row.lineId} with account ${accountLabel}: it is ${kind}, not a posting liability account. ` +
            `Reconcile with a posting (non-summary) liability account.`,
          );
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
