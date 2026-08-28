import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

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

async function seedComparison(
  orgId: string,
  token: string,
): Promise<string> {
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

test(
  "legacy unattributed duplicates repair once and stay unique per tenant and run",
  { skip: !DB },
  async () => {
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
      ) => db.execute(sql`
        insert into payroll_parallel_findings
          (id, org_id, comparison_id, employee_party_id, employee_name,
           kind, slot, slot_label, classification, prior_amount, our_amount, difference)
        values
          (${id}, ${orgId}, ${comparison}, ${employee},
           ${employee == null ? "Unattributed total" : "Attributed employee"},
           'total', ${slot}, ${slot}, ${classification}, '100.0000', '90.0000', '10.0000')
      `);

      // Build the exact pre-0072 state: the ordinary unique index allowed two
      // NULL employee keys for one cell. Keep an attributed row and two
      // independent runs/tenants to prove repair scope.
      await insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:gross");
      await insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:net_pay");
      await insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:gross", employeePartyId, "difference");

      // Put this test database into the legacy state regardless of whether
      // the template started before or after 0072. Dropping the strict
      // constraint also removes its backing index; an old template instead
      // has only the ordinary index to drop.
      await db.execute(sql.raw(`
        do $$
        begin
          if exists (
            select 1
              from pg_constraint c
              join pg_class r on r.oid = c.conrelid
              join pg_namespace n on n.oid = r.relnamespace
             where c.conname = 'payroll_parallel_findings_cell'
               and r.relname = 'payroll_parallel_findings'
               and n.nspname = 'public'
          ) then
            alter table public.payroll_parallel_findings
              drop constraint payroll_parallel_findings_cell;
          else
            drop index if exists public.payroll_parallel_findings_cell;
          end if;
        end $$
      `));
      await db.execute(sql`
        create unique index payroll_parallel_findings_cell
          on payroll_parallel_findings (comparison_id, employee_party_id, kind, slot)
      `);
      await insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:gross");
      await insertFinding(org.orgId, otherRunComparisonId, randomUUID(), "unattributed:gross");
      await insertFinding(otherOrg.orgId, otherTenantComparisonId, randomUUID(), "unattributed:gross");

      const migration = readFileSync(
        new URL("../../schema/migrations/generated/0072_payroll_parallel_unattributed_uniqueness.sql", import.meta.url),
        "utf8",
      );
      await db.execute(sql.raw(migration));

      const repaired = await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from payroll_parallel_findings
         where comparison_id = ${comparisonId}
      `);
      assert.equal(repaired.rows[0]?.n, 3, "repair keeps one NULL row, the distinct NULL cell, and the attributed row");

      const attributed = await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from payroll_parallel_findings
         where comparison_id = ${comparisonId} and employee_party_id = ${employeePartyId}
      `);
      assert.equal(attributed.rows[0]?.n, 1, "legacy repair never removes attributed findings");

      const independentRuns = await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from payroll_parallel_findings
         where comparison_id in (${otherRunComparisonId}, ${otherTenantComparisonId})
           and employee_party_id is null
           and kind = 'total' and slot = 'unattributed:gross'
      `);
      assert.equal(independentRuns.rows[0]?.n, 2, "the cell identity remains run- and tenant-scoped");

      // Replaying the same forward migration must not delete or rewrite the
      // surviving rows and must not attempt to drop the constraint's index.
      await db.execute(sql.raw(migration));
      const replayed = await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from payroll_parallel_findings
         where comparison_id = ${comparisonId}
      `);
      assert.equal(replayed.rows[0]?.n, 3);

      // RED before 0072: PostgreSQL's ordinary UNIQUE semantics allow a
      // second NULL employee key for the same comparison/kind/slot. GREEN
      // after 0072: the NULL bucket is one unattributed cell.
      await assert.rejects(
        insertFinding(org.orgId, comparisonId, randomUUID(), "unattributed:gross"),
        isCellUniquenessViolation,
      );
    } finally {
      await dropScratchOrgReporting(otherOrg.orgId);
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
