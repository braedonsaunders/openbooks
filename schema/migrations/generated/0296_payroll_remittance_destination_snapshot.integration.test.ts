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

// One committed US deduction accrual remitting to the scratch vendor,
// shaped like a pre-0296 commit (the snapshot is the component's vendor, as
// the 0296 UPDATE backfills it).
async function seedLiabilityAccount(fx: SeededOrg, number: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${fx.orgId}, ${number}, ${name}, 'liability_current',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

let runSeq = 0;

async function seedAccrual(
  fx: SeededOrg,
  overrides: {
    amount?: string;
    liabilityId?: string;
    code?: string;
    name?: string;
    snapshot?: string;
  } = {},
): Promise<{ lineId: string; liability: string }> {
  const amount = overrides.amount ?? "100.00";
  const liability = overrides.liabilityId ?? (await seedLiabilityAccount(fx, "2310", "Withholding payable"));
  const code = overrides.code ?? "GARN";
  const componentId = randomUUID();
  const scheduleId = randomUUID();
  const employeeId = randomUUID();
  const runId = randomUUID();
  const stubId = randomUUID();
  const lineId = randomUUID();
  runSeq += 1;
  const scheduleName = `0296 schedule ${runSeq}`;
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, country, is_active, liability_account_id,
       remittance_party_id, sequence, created_by, updated_by)
    values (${componentId}, ${fx.orgId}, ${code}, ${overrides.name ?? "Garnishment"}, 'deduction', 'US', true,
            ${liability}, ${overrides.snapshot ?? fx.vendorId}, 10, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${fx.orgId}, ${scheduleName}, 'monthly', 12,
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
    values (${runId}, ${fx.orgId}, 'pay_run', ${`PR-0296-${runSeq}`}, ${fx.subsidiaryId}, '2026-07-21',
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
    values (${lineId}, ${fx.orgId}, ${stubId}, ${componentId}, 'deduction', ${overrides.name ?? "Garnishment"},
            ${amount}, 10, ${liability}, 'commit', ${overrides.snapshot ?? fx.vendorId}, ${fx.actor}, ${fx.actor})`);
  return { lineId, liability };
}

async function seedBill(
  fx: SeededOrg,
  number: string,
  marker: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  // Draft first: document lines are immutable once the bill leaves draft, so
  // lines are seeded before approval. 'approved', not 'posted': a posted bill
  // needs a journal entry, which the backfill never reads. Approved bills are
  // live (non-voided) and count in the overlap check, which is all the
  // backfill cares about.
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, subsidiary_id, party_id,
                           document_date, posting_date, posting_period_id, currency,
                           status, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${id}, ${fx.orgId}, 'vendor_bill', ${number}, ${fx.subsidiaryId}, ${fx.vendorId},
            '2026-07-31', '2026-07-31', ${fx.periodId}, 'USD',
            'draft', '100', '0', '100', ${JSON.stringify({ payrollRemittance: marker })}::jsonb,
            ${fx.actor}, ${fx.actor})`);
  return id;
}

async function approveBill(fx: SeededOrg, billId: string): Promise<void> {
  await db.execute(sql`
    update documents set status = 'approved'
     where org_id = ${fx.orgId} and id = ${billId}`);
}

async function seedBillLines(
  fx: SeededOrg,
  billId: string,
  lines: { account: string; amount: string; description: string }[],
): Promise<void> {
  let lineNumber = 1;
  for (const line of lines) {
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description,
                                  quantity, unit_price, amount, created_by, updated_by)
      values (${fx.orgId}, ${billId}, ${lineNumber++}, ${line.account}, ${line.description},
              1, ${line.amount}, ${line.amount}, ${fx.actor}, ${fx.actor})`);
  }
}

// The migration's repair-notice predicate, mirrored for assertions: live
// in-scope bills with a party or line mismatch, with reasons. Any drift
// between this mirror and the notice block fails the naming tests below.
async function namedBills(orgId: string): Promise<{ number: string; reasons: string }[]> {
  return (await db.execute<{ number: string; reasons: string }>(sql`
    with sane_bills as (
      select b.org_id, b.id, b.subsidiary_id,
             case when (b.custom -> 'payrollRemittance' ->> 'from') ~ '^\\d{4}-\\d{2}-\\d{2}$'
                  then (b.custom -> 'payrollRemittance' ->> 'from')::date end as from_date,
             case when (b.custom -> 'payrollRemittance' ->> 'to') ~ '^\\d{4}-\\d{2}-\\d{2}$'
                  then (b.custom -> 'payrollRemittance' ->> 'to')::date end as to_date,
             case when (b.custom -> 'payrollRemittance' ->> 'partyId') ~ '^[0-9a-fA-F-]{36}$'
                  then (b.custom -> 'payrollRemittance' ->> 'partyId')::uuid end as party_id,
             ((b.custom -> 'payrollRemittance' ->> 'filingAccountId') is null
              or (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$') as filing_ok,
             case when (b.custom -> 'payrollRemittance' ->> 'filingAccountId') is null
                    or (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$'
                  then (b.custom -> 'payrollRemittance' ->> 'filingAccountId')::uuid end as filing_id
        from public.documents b
       where b.org_id = ${orgId} and b.kind = 'vendor_bill' and b.status <> 'voided'
         and (b.custom -> 'payrollRemittance') is not null
    ),
    scoped as (
      select s.* from sane_bills s
      join public.documents b on b.org_id = s.org_id and b.id = s.id
     where b.status <> 'voided'
       and not exists (
         select 1 from public.payroll_remittance_coverage c
          where c.org_id = s.org_id and c.bill_document_id = s.id and c.created_by is not null
       )
    ),
    scoped_lines as (
      select s.org_id, s.id as bill, l.liability_account_id as acct,
             case when l.kind = 'credit' then -l.amount else l.amount end as net
        from scoped s
        join public.pay_stub_lines l on l.org_id = s.org_id
        join public.pay_stubs st on st.id = l.stub_id and st.org_id = l.org_id
        join public.pay_runs r on r.document_id = st.pay_run_document_id and r.org_id = st.org_id
       where s.from_date is not null and s.to_date is not null and s.party_id is not null
         and s.filing_ok
         and r.run_status = 'committed'
         and l.kind in ('deduction', 'employer_contribution', 'credit')
         and st.pay_date between s.from_date and s.to_date
         and l.remittance_party_id is not distinct from s.party_id
         and st.filing_account_id is not distinct from s.filing_id
         and exists (
           select 1 from public.documents d
            where d.id = r.document_id and d.org_id = r.org_id
              and d.subsidiary_id is not distinct from s.subsidiary_id
         )
    ),
    accrual_groups as (
      select org_id, bill, acct, sum(net) as net from scoped_lines
       group by org_id, bill, acct having sum(net) <> 0
    ),
    bill_groups as (
      select s.org_id, s.id as bill, dl.account_id as acct, sum(dl.amount) as net
        from scoped s
        join public.document_lines dl on dl.org_id = s.org_id and dl.document_id = s.id
       where dl.amount <> 0
       group by s.org_id, s.id, dl.account_id
    ),
    flagged as (
      select b.document_number as number,
             (b.party_id is distinct from s.party_id) as party_bad,
             (exists (
                select ag.acct, ag.net from accrual_groups ag where ag.org_id = s.org_id and ag.bill = s.id
                except
                select bg.acct, bg.net from bill_groups bg where bg.org_id = s.org_id and bg.bill = s.id
              ) or exists (
                select bg.acct, bg.net from bill_groups bg where bg.org_id = s.org_id and bg.bill = s.id
                except
                select ag.acct, ag.net from accrual_groups ag where ag.org_id = s.org_id and ag.bill = s.id
              )) as line_bad
        from scoped s
        join public.documents b on b.org_id = s.org_id and b.id = s.id
    )
    select number,
           concat_ws(',', case when party_bad then 'party-mismatch' end,
                        case when line_bad then 'line-mismatch' end) as reasons
      from flagged
     where party_bad or line_bad
     order by number`)).rows;
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
        await approveBill(fx, await seedBill(fx, "VB-U1-DATE", { ...validMarker(fx), from: "2026-02-30" }));
        await approveBill(
          fx,
          await seedBill(fx, "VB-U1-UUID", {
            ...validMarker(fx),
            partyId: "------------------------------------",
          }),
        );
        const missingParty = validMarker(fx);
        delete missingParty.partyId;
        await approveBill(fx, await seedBill(fx, "VB-U1-NOPARTY", missingParty));
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
        const { lineId, liability } = await seedAccrual(fx);
        const billId = await seedBill(fx, "VB-U1-OK", validMarker(fx));
        await seedBillLines(fx, billId, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, billId);
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
        await approveBill(fx, await seedBill(fx, "VB-U1-NONSTRING", { ...validMarker(fx), from: 20260701 }));
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
        await approveBill(fx, await seedBill(fx, "VB-U1-SCALAR", "legacy" as unknown as Record<string, unknown>));
        await approveBill(fx, await seedBill(fx, "VB-U1-EMPTY", { note: "pre-structured" }));
        await runMigration();
        assert.deepEqual(await coverageRows(fx.orgId), []);
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 leaves a same-total wrong-account bill uncovered and names it",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const billId = await withBypass(async () => {
        // $100 accrued to A, but the bill debits $100 of B: same total, so
        // the old grand-total match covered the A line while A stayed
        // payable in the GL.
        const { liability } = await seedAccrual(fx);
        const other = await seedLiabilityAccount(fx, "2320", "Other payable");
        assert.notEqual(other, liability);
        const id = await seedBill(fx, "VB-U2-WRONGACCT", validMarker(fx));
        await seedBillLines(fx, id, [{ account: other, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, id);
        return id;
      });
      await withBypass(() => runMigration());
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      assert.deepEqual(rows, [], "a wrong-account bill gains no coverage");
      assert.deepEqual(named, [{ number: "VB-U2-WRONGACCT", reasons: "line-mismatch" }]);
      assert.ok(billId);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 empties a party-mismatched bill and names it",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        // The marker names the scratch vendor but the bill was re-pointed at
        // another vendor: simulate the rows the old grand-total backfill
        // wrote, then prove the repair removes them and names the bill.
        const { lineId, liability } = await seedAccrual(fx);
        const otherVendor = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id,
                               is_active, custom, created_by, updated_by)
          values (${otherVendor}, ${fx.orgId}, 'company', 'Other vendor', ${fx.subsidiaryId},
                  true, '{}'::jsonb, ${fx.actor}, ${fx.actor})`);
        const billId = await seedBill(fx, "VB-U2-PARTY", validMarker(fx));
        await seedBillLines(fx, billId, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await db.execute(sql`
          update documents set party_id = ${otherVendor}
           where org_id = ${fx.orgId} and id = ${billId}`);
        await approveBill(fx, billId);
        await db.execute(sql`
          insert into payroll_remittance_coverage (org_id, bill_document_id, stub_line_id, amount)
          values (${fx.orgId}, ${billId}, ${lineId}, '100.00')`);
      });
      await withBypass(() => runMigration());
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      assert.deepEqual(rows, [], "a party-mismatched bill keeps no backfill rows");
      assert.deepEqual(named, [{ number: "VB-U2-PARTY", reasons: "party-mismatch" }]);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 covers a bill whose lines reconcile across two liability accounts",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const { billId, lineA, lineB } = await withBypass(async () => {
        // $60 to A plus $40 to B, billed as two labelled lines: the account
        // split is legitimate, so both lines gain coverage and no notice names it.
        const first = await seedAccrual(fx, { amount: "60.00", code: "GARN-A", name: "Garnishment A" });
        const second = await seedAccrual(fx, {
          amount: "40.00",
          code: "GARN-B",
          name: "Garnishment B",
          liabilityId: await seedLiabilityAccount(fx, "2320", "Other payable"),
        });
        const id = await seedBill(fx, "VB-U2-TWOACCT", validMarker(fx));
        await seedBillLines(fx, id, [
          { account: first.liability, amount: "60", description: "Garnishment A" },
          { account: second.liability, amount: "40", description: "Garnishment B" },
        ]);
        // The seed bills total a fixed 100; the two lines sum to it.
        await db.execute(sql`
          update documents set total = '100', subtotal = '100'
           where org_id = ${fx.orgId} and id = ${id}`);
        await approveBill(fx, id);
        return { billId: id, lineA: first.lineId, lineB: second.lineId };
      });
      await withBypass(() => runMigration());
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      // Line uuids sort arbitrarily: compare as a set keyed by amount.
      assert.deepEqual(
        [...rows].sort((a, b) => (a.amount < b.amount ? -1 : 1)),
        [
          { bill: billId, line: lineB, amount: "40.0000" },
          { bill: billId, line: lineA, amount: "60.0000" },
        ],
      );
      assert.deepEqual(named, []);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 frees backfill rows when their bill is voided",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const billId = await withBypass(async () => {
        const { liability } = await seedAccrual(fx);
        const id = await seedBill(fx, "VB-U2-VOID", validMarker(fx));
        await seedBillLines(fx, id, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, id);
        await runMigration();
        assert.equal((await coverageRows(fx.orgId)).length, 1);
        await db.execute(sql`
          update documents
             set status = 'voided', voided_at = now(), voided_by = ${fx.actor},
                 void_reason = 'voided for the 0296 repair test'
           where org_id = ${fx.orgId} and id = ${id}`);
        return id;
      });
      await withBypass(() => runMigration());
      assert.deepEqual(await withBypass(() => coverageRows(fx.orgId)), []);
      assert.ok(billId);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);
