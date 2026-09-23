import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0296_payroll_remittance_destination_snapshot.sql", import.meta.url),
  "utf8",
);

async function runMigration(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

type SeededOrg = {
  orgId: string;
  vendorId: string;
  subsidiaryId: string;
  actor: string;
  periodId: string;
};

async function seedOrg(): Promise<SeededOrg> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "0296 upgrade", "m0296_upgrade");
  const period = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]?.id;
  assert.ok(period, "scratch org carries an accounting period");
  return { orgId: org.orgId, vendorId: org.vendorId, subsidiaryId: org.subsidiaryId, actor, periodId: period };
}

// One committed $100 US deduction accrual remitting to the scratch vendor,
// shaped like a pre-0296 commit (the snapshot is the component's vendor, as
// the 0296 UPDATE backfills it).
async function seedAccrual(fx: SeededOrg): Promise<{ lineId: string }> {
  const liability = randomUUID();
  const componentId = randomUUID();
  const scheduleId = randomUUID();
  const employeeId = randomUUID();
  const runId = randomUUID();
  const stubId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${liability}, ${fx.orgId}, '2310', 'Withholding payable', 'liability_current',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, country, is_active, liability_account_id,
       remittance_party_id, sequence, created_by, updated_by)
    values (${componentId}, ${fx.orgId}, 'GARN', 'Garnishment', 'deduction', 'US', true,
            ${liability}, ${fx.vendorId}, 10, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${fx.orgId}, '0296 schedule', 'monthly', 12,
            '2026-07-31', 0, true, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id,
                         is_active, custom, created_by, updated_by)
    values (${employeeId}, ${fx.orgId}, 'person', '0296 Accrual', ${fx.subsidiaryId},
            true, '{}'::jsonb, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, posting_period_id, currency, status, memo, created_by, updated_by)
    values (${runId}, ${fx.orgId}, 'pay_run', 'PR-0296-1', ${fx.subsidiaryId}, '2026-07-21',
            '2026-07-21', ${fx.periodId}, 'USD', 'draft', '0296 source', ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
       tax_year, run_status, run_type, created_by, updated_by)
    values (${runId}, ${fx.orgId}, ${scheduleId}, '2026-07-21', '2026-07-21',
            '2026-07-21', 2026, 'committed', 'regular', ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, factors, created_by, updated_by)
    values (${stubId}, ${fx.orgId}, ${runId}, ${employeeId}, 'ON', 12,
            '2026-07-21', 2026, 'USD', '100.00', '100.00', '100.00', '100.00',
            '100.00', '0', '{}'::jsonb, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, remittance_party_id, created_by, updated_by)
    values (${lineId}, ${fx.orgId}, ${stubId}, ${componentId}, 'deduction', 'Garnishment',
            '100.00', 10, ${liability}, 'commit', ${fx.vendorId}, ${fx.actor}, ${fx.actor})`);
  return { lineId };
}

async function seedBill(
  fx: SeededOrg,
  number: string,
  marker: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  // 'approved', not 'posted': a posted bill needs a journal entry, which the
  // backfill never reads. Approved bills are live (non-voided) and count in
  // the overlap check, which is all the backfill cares about.
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, subsidiary_id, party_id,
                           document_date, posting_date, posting_period_id, currency,
                           status, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${id}, ${fx.orgId}, 'vendor_bill', ${number}, ${fx.subsidiaryId}, ${fx.vendorId},
            '2026-07-31', '2026-07-31', ${fx.periodId}, 'USD',
            'approved', '100', '0', '100', ${JSON.stringify({ payrollRemittance: marker })}::jsonb,
            ${fx.actor}, ${fx.actor})`);
  return id;
}

function validMarker(fx: SeededOrg): Record<string, unknown> {
  return {
    partyId: fx.vendorId,
    from: "2026-07-01",
    to: "2026-07-31",
    filingAccountId: null,
    subsidiaryId: fx.subsidiaryId,
  };
}

// Drizzle reports the failed SQL in .message and the PostgreSQL refusal in
// .cause: match against the refusal, never the query text.
function refusalMessage(error: unknown): string {
  const cause = (error as { cause?: Error } | null)?.cause;
  return cause?.message ?? (error as Error)?.message ?? String(error);
}

async function coverageRows(orgId: string): Promise<{ bill: string; line: string; amount: string }[]> {
  return (await db.execute<{ bill: string; line: string; amount: string }>(sql`
    select bill_document_id::text as bill, stub_line_id::text as line, amount::text as amount
      from payroll_remittance_coverage
     where org_id = ${orgId}
     order by bill, line`)).rows;
}

test(
  "0296 refuses the upgrade by name for malformed legacy markers",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        await seedAccrual(fx);
        await seedBill(fx, "VB-U1-DATE", { ...validMarker(fx), from: "2026-02-30" });
        await seedBill(fx, "VB-U1-UUID", {
          ...validMarker(fx),
          partyId: "------------------------------------",
        });
        const missingParty = validMarker(fx);
        delete missingParty.partyId;
        await seedBill(fx, "VB-U1-NOPARTY", missingParty);
      });
      // The refusing upgrade runs alone: its aborted transaction rolls back
      // only its own statements, never the committed seeds above.
      await withBypass(async () => {
        await runMigration().then(
          () => assert.fail("malformed markers must refuse the upgrade"),
          (error: unknown) => {
            const message = refusalMessage(error);
            // The refusal names every bill and field — not a bare cast error.
            assert.match(message, /VB-U1-DATE/);
            assert.match(message, /from/);
            assert.match(message, /impossible calendar date/);
            assert.match(message, /VB-U1-UUID/);
            assert.match(message, /partyId/);
            assert.match(message, /unparseable reference/);
            assert.match(message, /VB-U1-NOPARTY/);
            assert.match(message, /missing/);
            assert.match(message, /re-apply/);
          },
        );
      });
      await withBypass(async () => {
        assert.deepEqual(await coverageRows(fx.orgId), [], "refused upgrade covers nothing");
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 covers a well-formed legacy bill, idempotently",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        const { lineId } = await seedAccrual(fx);
        const billId = await seedBill(fx, "VB-U1-OK", validMarker(fx));
        await runMigration();
        assert.deepEqual(await coverageRows(fx.orgId), [
          { bill: billId, line: lineId, amount: "100.0000" },
        ]);
        // Re-running changes nothing: the anti-join skips covered lines.
        await runMigration();
        assert.deepEqual(await coverageRows(fx.orgId), [
          { bill: billId, line: lineId, amount: "100.0000" },
        ]);
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 refuses a non-string marker value by name",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        await seedAccrual(fx);
        // A JSON number is not a date: ->> yields text that fails the shape
        // filter. The marker claims the structured shape but is unusable, so
        // the upgrade refuses by name instead of leaving silent debt.
        await seedBill(fx, "VB-U1-NONSTRING", { ...validMarker(fx), from: 20260701 });
      });
      await withBypass(async () => {
        await runMigration().then(
          () => assert.fail("a non-string marker value must refuse the upgrade"),
          (error: unknown) => {
            const message = refusalMessage(error);
            assert.match(message, /VB-U1-NONSTRING/);
            assert.match(message, /from/);
            assert.match(message, /malformed date/);
          },
        );
      });
      await withBypass(async () => {
        assert.deepEqual(await coverageRows(fx.orgId), [], "refused upgrade covers nothing");
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 skips markers that never claimed the structured shape",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        await seedAccrual(fx);
        // A scalar marker and an object naming none of the four fields
        // predate structured bills: the backfill skips them as before and
        // they keep the fail-closed overlap refusal.
        await seedBill(fx, "VB-U1-SCALAR", "legacy" as unknown as Record<string, unknown>);
        await seedBill(fx, "VB-U1-EMPTY", { note: "pre-structured" });
        await runMigration();
        assert.deepEqual(await coverageRows(fx.orgId), []);
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);
