import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type PgError = Error & { code?: string; constraint?: string; cause?: unknown };

function isCellUniquenessViolation(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as PgError).cause) {
    if (!current || typeof current !== "object") continue;
    const candidate = current as PgError;
    if (candidate.code === "23505" && candidate.constraint === "payroll_parallel_findings_cell") {
      return true;
    }
  }
  return false;
}

async function seedComparison(orgId: string, token: string): Promise<string> {
  const registerId = randomUUID();
  await db.execute(sql`
    insert into payroll_prior_registers
      (id, org_id, name, period_start, period_end, pay_date)
    values
      (${registerId}, ${orgId}, ${"Prior — uniqueness " + token},
       '2026-07-05', '2026-07-18', '2026-07-21')
  `);

  const payRunDocumentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, document_date, currency, status)
    values
      (${payRunDocumentId}, ${orgId}, 'pay_run', ${"PR-UNIQUENESS-" + token},
       '2026-07-21', 'CAD', 'draft')
  `);

  const comparisonId = randomUUID();
  await db.execute(sql`
    insert into payroll_parallel_comparisons
      (id, org_id, register_id, pay_run_document_id, status)
    values
      (${comparisonId}, ${orgId}, ${registerId}, ${payRunDocumentId}, 'differences')
  `);
  return comparisonId;
}

test("an unattributed finding cell is unique per tenant and run", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const otherOrg = await createScratchOrg();
  try {
    const comparisonId = await seedComparison(org.orgId, randomUUID());
    const otherRunComparisonId = await seedComparison(org.orgId, randomUUID());
    const otherTenantComparisonId = await seedComparison(otherOrg.orgId, randomUUID());
    const employeePartyId = randomUUID();
    await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeePartyId}, ${org.orgId}, 'person', 'Attributed finding', true, '{}'::jsonb)
      `);

    const insertFinding = (
      orgId: string,
      comparison: string,
      id: string,
      slot: string,
      employee: string | null = null,
      classification = "unattributed",
    ) =>
      db.execute(sql`
        insert into payroll_parallel_findings
          (id, org_id, comparison_id, employee_party_id, employee_name,
           kind, slot, slot_label, classification, prior_amount, our_amount, difference)
        values
          (${id}, ${orgId}, ${comparison}, ${employee},
           ${employee == null ? "Unattributed total" : "Attributed employee"},
           'total', ${slot}, ${slot}, ${classification}, '100.0000', '90.0000', '10.0000')
      `);

    await insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:gross");
    await insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:net_pay");
    await insertFinding(
      org.orgId,
      comparisonId,
      randomUUID(),
      "unattributed:gross",
      employeePartyId,
      "difference",
    );

    // A NULL employee key is one unattributed cell, not a fresh value:
    // ordinary UNIQUE semantics would admit a second row for the same
    // comparison/kind/slot.
    await assert.rejects(
      insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:gross"),
      isCellUniquenessViolation,
    );
    const cells = await db.execute<{ n: number }>(
      sql`
        select count(*)::int as n
          from payroll_parallel_findings
         where comparison_id = ${comparisonId}
      `,
      "objects",
    );
    assert.equal(
      cells[0]?.n,
      3,
      "the refused duplicate leaves both unattributed cells and the attributed row",
    );

    // The cell identity is run- and tenant-scoped.
    await insertFinding(org.orgId, otherRunComparisonId, randomUUID(), "unattributed:gross");
    await insertFinding(
      otherOrg.orgId,
      otherTenantComparisonId,
      randomUUID(),
      "unattributed:gross",
    );
    const independentRuns = await db.execute<{ n: number }>(
      sql`
        select count(*)::int as n
          from payroll_parallel_findings
         where comparison_id in (${otherRunComparisonId}, ${otherTenantComparisonId})
           and employee_party_id is null
           and kind = 'total' and slot = 'unattributed:gross'
      `,
      "objects",
    );
    assert.equal(independentRuns[0]?.n, 2, "the cell identity remains run- and tenant-scoped");
  } finally {
    await dropScratchOrgReporting(otherOrg.orgId);
    await dropScratchOrgReporting(org.orgId);
  }
});
