import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { RemittanceExecutor } from "./remittance-summary.ts";

/** Remittance coverage: the committed stub lines a bill consumed. */

/**
 * One committed accrual line in a bill's scope, with the fields destination
 * resolution reads. The bill creator resolves these in TypeScript through the
 * same resolver the summary folds by, so coverage records exactly the lines
 * the bill consumed — including region-scoped rows whose snapshot party is
 * not their resolved destination.
 */
export interface RemittanceScopeLine {
  lineId: string;
  kind: "deduction" | "employer_contribution" | "credit";
  /** Raw native amount (credits net at read time, as the summary nets). */
  amount: string;
  /** The stub line's commit-time destination snapshot (migration 0296). */
  snapshotPartyId: string | null;
  /** The component's CURRENT remittance vendor (see RemittanceResolvableRow). */
  componentPartyId: string | null;
  /** The live bill that consumed this line, if any (see RemittanceResolvableRow). */
  coveredPartyId: string | null;
  systemKey: string | null;
  country: string | null;
  province: string;
  /** Which component accrued this line — the bill aggregates remainder lines
   *  by the same (component, kind, liability account) identity the summary
   *  folds by, so an incremental bill debits exactly the accounts its own
   *  lines credited. */
  componentId: string;
  componentName: string;
  /** The historical liability account credited at commit. */
  liabilityAccountId: string | null;
}

/**
 * Every committed accrual line behind one (period, filing account, entity)
 * scope — the bill's coverage population. Destination resolution stays in
 * TypeScript (pack declarations cannot be re-derived in SQL); callers keep
 * the lines whose resolved destination is their vendor.
 */
export async function remittanceScopeLines(
  executor: RemittanceExecutor,
  orgId: string,
  key: { from: string; to: string; filingAccountId: string | null; entityId: string },
): Promise<RemittanceScopeLine[]> {
  const rows = await executor.execute<{
    line_id: string;
    kind: "deduction" | "employer_contribution" | "credit";
    amount: string;
    snapshot_party_id: string | null;
    component_party_id: string | null;
    covered_party_id: string | null;
    system_key: string | null;
    country: string | null;
    province: string;
    component_id: string;
    component_name: string;
    liability_account_id: string | null;
  }>(
    sql`
    select l.id::text as line_id, l.kind, l.amount::text as amount,
           l.remittance_party_id::text as snapshot_party_id,
           c.remittance_party_id::text as component_party_id,
           (select cover_bill.party_id::text
              from payroll_remittance_coverage cov
              join documents cover_bill
                on cover_bill.id = cov.bill_document_id and cover_bill.org_id = cov.org_id
               and cover_bill.status <> 'voided'
             where cov.org_id = l.org_id and cov.stub_line_id = l.id
             order by cover_bill.created_at desc, cover_bill.id desc
             limit 1) as covered_party_id,
           c.system_key, c.country, s.province,
           c.id::text as component_id, c.name as component_name,
           l.liability_account_id::text as liability_account_id
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${key.from} and ${key.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       and d.subsidiary_id = ${key.entityId}
       and s.filing_account_id is not distinct from ${key.filingAccountId}
     order by l.id
  `,
    "objects",
  );
  return rows.map((row) => ({
    lineId: row.line_id,
    kind: row.kind,
    amount: row.amount,
    snapshotPartyId: row.snapshot_party_id,
    componentPartyId: row.component_party_id,
    coveredPartyId: row.covered_party_id,
    systemKey: row.system_key,
    country: row.country,
    province: row.province,
    componentId: row.component_id,
    componentName: row.component_name,
    liabilityAccountId: row.liability_account_id,
  }));
}

/**
 * Every accrual line a live (non-voided) remittance bill has consumed, by
 * stub line id. Voiding a bill frees its lines: the void-then-recreate
 * correction path re-bills them, and the overlap fence treats a freed window
 * as open. A live bill with no coverage rows at all (a legacy bill the 0296
 * repair could not reconcile) covers an unknowable set, so callers fail
 * closed on it rather than guess a remainder.
 */
export async function coveredRemittanceStubLines(
  executor: RemittanceExecutor,
  orgId: string,
): Promise<Set<string>> {
  const rows = await executor.execute<{ stub_line_id: string }>(
    sql`
    select cov.stub_line_id::text as stub_line_id
      from payroll_remittance_coverage cov
      join documents bill
        on bill.id = cov.bill_document_id and bill.org_id = cov.org_id
     where cov.org_id = ${orgId} and bill.status <> 'voided'
  `,
    "objects",
  );
  return new Set(rows.map((row) => row.stub_line_id));
}

/**
 * Which live (non-voided) intersecting bills carry no coverage rows. Such a
 * bill consumed an unknowable set of lines, so no remainder can be proven
 * against its window — the creator refuses rather than risk a double bill.
 */
export async function remittanceBillsWithoutCoverage(
  executor: RemittanceExecutor,
  orgId: string,
  billIds: readonly string[],
): Promise<string[]> {
  if (billIds.length === 0) return [];
  const rows = await executor.execute<{ bill_document_id: string }>(
    sql`
    select distinct cov.bill_document_id::text as bill_document_id
      from payroll_remittance_coverage cov
     where cov.org_id = ${orgId}
       and cov.bill_document_id = any(${`{${billIds.join(",")}}`}::uuid[])
  `,
    "objects",
  );
  const withCoverage = new Set(rows.map((row) => row.bill_document_id));
  return billIds.filter((id) => !withCoverage.has(id));
}

/**
 * The distinct stub currencies behind one entity slice of one group — the
 * ground truth for whether the slice can be stamped in its entity's base
 * currency. Re-read in the creator's transaction, not trusted from a
 * preflight summary.
 */
export async function sliceStubCurrencies(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  key: {
    from: string;
    to: string;
    partyId: string;
    filingAccountId: string | null;
    entityId: string;
  },
): Promise<string[]> {
  // The destination half of the group key is deliberately absent: components
  // resolve destinations through pack declarations the SQL cannot re-derive,
  // and the slice's entity × filing account × period already identifies the
  // accruals the summary folded in. A second destination sharing the slice
  // would only ADD a currency, failing safer.
  const rows = await tx.execute<{ currency: string }>(
    sql`
    select distinct s.currency_code as currency
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${key.from} and ${key.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       and d.subsidiary_id = ${key.entityId}
       and s.filing_account_id is not distinct from ${key.filingAccountId}
  `,
    "objects",
  );
  return rows.map((r) => r.currency).sort();
}
