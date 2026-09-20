import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { postDocument } from "../ledger/posting.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import {
  createRemittanceBill,
  payrollRemittanceSummary,
} from "./remittance.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A payroll remittance bill is a posted AP document: it must be raised on
 * the legal entity whose payroll accrued the liability, in that entity's
 * currency, so the debit clears the credited liability on the same books.
 * Stamping the root subsidiary unconditionally leaves the liability open on
 * both sets of books.
 */

type EntityFixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  actorId: string;
  liability: string;
  expense: string;
  component: string;
  schedule: string;
};

async function seedEntityOrg(): Promise<EntityFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const liability = randomUUID();
  const expense = randomUUID();
  const component = randomUUID();
  const schedule = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children)
    values
      (${liability}, ${org.orgId}, ${`24${component.slice(0, 2)}`},
       'Remittance liability', 'liability_current', false, true, false, false,
       '[]'::jsonb, '{}'::jsonb, true),
      (${expense}, ${org.orgId}, ${`60${component.slice(2, 4)}`},
       'Wages expense', 'expense', false, true, false, false,
       '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
    on conflict do nothing`);
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, system_key, liability_account_id,
       remittance_party_id, sequence, country, created_by, updated_by)
    values
      (${component}, ${org.orgId}, ${`ENTTAX-${component.slice(0, 6)}`},
       'Test withholding', 'deduction', 'income_tax', ${liability},
       ${org.vendorId}, 10, 'CA', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${schedule}, ${org.orgId}, 'Entity schedule', 'monthly', 12,
       '2026-09-30', 0, true, ${actorId}, ${actorId})`);
  return { org, actorId, liability, expense, component, schedule };
}

async function newSchedule(fx: EntityFixture): Promise<string> {
  // pay_runs is unique per (schedule, period): each fixture run gets its own
  // schedule row rather than sharing one period.
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${id}, ${fx.org.orgId}, ${`Entity schedule ${id.slice(0, 8)}`}, 'monthly', 12,
       '2026-09-30', 0, true, ${fx.actorId}, ${fx.actorId})`);
  return id;
}

async function addChildSubsidiary(
  fx: EntityFixture,
  name: string,
  baseCurrency: string,
): Promise<string> {
  if (baseCurrency !== "CAD") {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values (${baseCurrency}, ${`${name} currency`}, 2)
      on conflict (code) do nothing`);
  }
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids,
       is_elimination, is_active, custom)
    values
      (${id}, ${fx.org.orgId}, ${fx.org.subsidiaryId}, ${name},
       ${baseCurrency}, 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  // Bills post against the destination vendor on the billed entity's books,
  // so the shared remittance vendor must transact with the new entity.
  await db.execute(sql`
    insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
    values (${randomUUID()}, ${fx.org.orgId}, ${fx.org.vendorId}, ${id})`);
  return id;
}

async function addEntityAccrual(
  fx: EntityFixture,
  input: {
    subsidiaryId: string; currency: string; amount: string;
    payDate?: string; docNumber?: string; filingAccountId?: string | null;
  },
): Promise<{ documentId: string; documentNumber: string }> {
  const payDate = input.payDate ?? "2026-07-15";
  const scheduleId = await newSchedule(fx);
  const documentId = randomUUID();
  const documentNumber = input.docNumber ?? `PAY-${documentId.slice(0, 8).toUpperCase()}`;
  const stubId = randomUUID();
  const lineId = randomUUID();
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id,
                         is_active, custom, created_by, updated_by)
    values (${employeeId}, ${fx.org.orgId}, 'person', ${`Emp ${documentNumber}`},
            ${input.subsidiaryId}, true, '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date, posting_date,
       posting_period_id, currency, status, memo, created_by, updated_by)
    values (${documentId}, ${fx.org.orgId}, 'pay_run', ${documentNumber}, ${input.subsidiaryId},
            ${payDate}, ${payDate}, ${fx.org.periodId}, ${input.currency}, 'draft',
            'entity slice proof', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year,
       run_status, run_type, created_by, updated_by)
    values (${documentId}, ${fx.org.orgId}, ${scheduleId}, '2026-07-01', ${payDate},
            ${payDate}, 2026, 'committed', 'regular', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province, periods_per_year,
       pay_date, tax_year, currency_code, gross, pensionable_earnings, insurable_earnings,
       net_pay, employer_cost, vacation_accrued, factors, filing_account_id,
       filing_account_source, created_by, updated_by)
    values (${stubId}, ${fx.org.orgId}, ${documentId}, ${employeeId}, 'ON', 12,
            ${payDate}, 2026, ${input.currency}, ${input.amount}, ${input.amount},
            ${input.amount}, ${input.amount}, ${input.amount}, '0', '{}'::jsonb,
            ${input.filingAccountId ?? null}, ${input.filingAccountId ? "calculation" : "unknown"},
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, created_by, updated_by)
    values (${lineId}, ${fx.org.orgId}, ${stubId}, ${fx.component}, 'deduction',
            'Test withholding', ${input.amount}, 10, ${fx.liability}, 'commit',
            ${fx.actorId}, ${fx.actorId})`);
  return { documentId, documentNumber };
}

/** Post a raw pay-run accrual the way a committed run posts: DR expense / CR liability. */
async function postAccrualSource(
  fx: EntityFixture,
  documentId: string,
  amount: string,
): Promise<void> {
  await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, amount, created_by)
    values
      (${fx.org.orgId}, ${documentId}, 1, ${fx.expense}, ${amount}, ${fx.actorId}),
      (${fx.org.orgId}, ${documentId}, 2, ${fx.liability}, ${`-${amount}`}, ${fx.actorId})`);
  await db.execute(sql`
    update documents set status = 'approved'
     where org_id = ${fx.org.orgId} and id = ${documentId}`);
  await postDocument(documentId, {
    control: { ar: fx.org.accounts.ar, ap: fx.org.accounts.ap, bank: fx.org.accounts.bank },
  });
}

async function postRemittanceBill(fx: EntityFixture, documentId: string): Promise<void> {
  await submitAndReleaseIfUngated("vendor_bill", documentId, fx.actorId);
  await postDocument(documentId, {
    control: { ar: fx.org.accounts.ar, ap: fx.org.accounts.ap, bank: fx.org.accounts.bank },
  });
}

async function liabilityBalances(fx: EntityFixture): Promise<Map<string, string>> {
  const rows = (await db.execute<{ subsidiary_id: string; balance: string }>(sql`
    select jl.subsidiary_id, sum(jl.amount)::text as balance
      from journal_lines jl
     where jl.org_id = ${fx.org.orgId} and jl.account_id = ${fx.liability}
     group by jl.subsidiary_id`)).rows;
  assert.ok(rows.length > 0, "expected posted liability lines before asserting they clear");
  return new Map(rows.map((r) => [r.subsidiary_id, r.balance]));
}

async function subsidiaryName(fx: EntityFixture, id: string): Promise<string> {
  return (await db.execute<{ name: string }>(sql`
    select name from subsidiaries where org_id = ${fx.org.orgId} and id = ${id}`)).rows[0]!.name;
}

const PERIOD = { from: "2026-07-01", to: "2026-07-31" };

test(
  "a subsidiary's payroll remits on that subsidiary and clears its liability",
  { skip: !DB },
  async () => {
    const fx = await seedEntityOrg();
    try {
      const child = await addChildSubsidiary(fx, "Child Entity", "CAD");
      const run = await addEntityAccrual(fx, {
        subsidiaryId: child, currency: "CAD", amount: "1000.00",
      });

      const groups = await payrollRemittanceSummary(fx.org.orgId, PERIOD);
      assert.equal(groups.length, 1);
      const group = groups[0]!;
      assert.equal(group.slices.length, 1, "one accruing entity means one slice");
      assert.equal(group.slices[0]!.subsidiaryId, child);
      assert.equal(cmp(group.slices[0]!.total, "1000.00"), 0);

      const bill = await createRemittanceBill(fx.org.orgId, fx.actorId, {
        partyId: fx.org.vendorId, ...PERIOD,
      });
      const stamped = (await db.execute<{
        subsidiary_id: string; currency: string; total: string;
      }>(sql`
        select subsidiary_id, currency, total from documents
         where org_id = ${fx.org.orgId} and id = ${bill.documentId}`)).rows[0]!;
      assert.equal(stamped.subsidiary_id, child, "the bill lands on the accruing entity, not the root");
      assert.equal(stamped.currency, "CAD");
      assert.equal(cmp(stamped.total, "1000.00"), 0);

      // The whole point: post both sides and watch the liability clear ON B.
      await postAccrualSource(fx, run.documentId, "1000.00");
      await postRemittanceBill(fx, bill.documentId);
      const balances = await liabilityBalances(fx);
      assert.equal(balances.size, 1, "no other entity's books were touched");
      assert.equal(cmp(balances.get(child)!, "0"), 0, "the liability clears on the accruing entity");
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "the bill carries the accruing entity's base currency, never the root's",
  { skip: !DB },
  async () => {
    const fx = await seedEntityOrg();
    try {
      const child = await addChildSubsidiary(fx, "US Child", "USD");
      await addEntityAccrual(fx, {
        subsidiaryId: child, currency: "USD", amount: "500.00",
      });

      const bill = await createRemittanceBill(fx.org.orgId, fx.actorId, {
        partyId: fx.org.vendorId, ...PERIOD,
      });
      const stamped = (await db.execute<{
        subsidiary_id: string; currency: string; total: string;
      }>(sql`
        select subsidiary_id, currency, total from documents
         where org_id = ${fx.org.orgId} and id = ${bill.documentId}`)).rows[0]!;
      assert.equal(stamped.subsidiary_id, child);
      assert.equal(stamped.currency, "USD", "USD accruals bill in USD, not the root's CAD");
      assert.equal(cmp(stamped.total, "500.00"), 0, "no raw-sum translation into the bill");
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "a filing account registered to another entity refuses, naming both and the run",
  { skip: !DB },
  async () => {
    const fx = await seedEntityOrg();
    try {
      const child = await addChildSubsidiary(fx, "Child Entity", "CAD");
      const childName = await subsidiaryName(fx, child);
      const rootName = await subsidiaryName(fx, fx.org.subsidiaryId);
      const accountId = randomUUID();
      await db.execute(sql`
        insert into payroll_filing_accounts
          (id, org_id, country, program_type, account_number, name, remitter_type,
           subsidiary_id, is_default)
        values (${accountId}, ${fx.org.orgId}, 'CA', 'ca_rp', '111222333RP0001',
                'Head office program', 'regular', ${fx.org.subsidiaryId}, true)`);
      const run = await addEntityAccrual(fx, {
        subsidiaryId: child, currency: "CAD", amount: "250.00", filingAccountId: accountId,
      });

      await assert.rejects(
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.org.vendorId, ...PERIOD, filingAccountId: accountId,
        }),
        (error: unknown) => {
          const message = (error as Error).message;
          for (const expected of [childName, rootName, run.documentNumber, "111222333RP0001"]) {
            assert.ok(
              message.includes(expected),
              `refusal names ${expected}: ${message}`,
            );
          }
          return true;
        },
        "the refusal must name both entities, the account, and the run",
      );
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "a group spanning two entities splits into two bills that sum exactly",
  { skip: !DB },
  async () => {
    const fx = await seedEntityOrg();
    try {
      const child = await addChildSubsidiary(fx, "Child Entity", "CAD");
      const rootRun = await addEntityAccrual(fx, {
        subsidiaryId: fx.org.subsidiaryId, currency: "CAD", amount: "300.00",
        docNumber: "PAY-ROOT-001",
      });
      const childRun = await addEntityAccrual(fx, {
        subsidiaryId: child, currency: "CAD", amount: "700.00",
        docNumber: "PAY-CHILD-001",
      });

      const groups = await payrollRemittanceSummary(fx.org.orgId, PERIOD);
      assert.equal(groups.length, 1, "one destination and account stays one group");
      const group = groups[0]!;
      assert.equal(group.slices.length, 2);
      // The worksheet figure is the consolidated reading, untouched by slicing.
      assert.equal(cmp(group.total, "1000.00"), 0);
      assert.equal(cmp(group.grossPayroll, "1000.00"), 0);
      assert.equal(group.employeeCount, 2);

      // An unnamed call cannot pick an entity: it splits, it does not merge.
      await assert.rejects(
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.org.vendorId, ...PERIOD,
        }),
        /spans 2 legal entities.*raise one bill per entity/,
      );

      const rootBill = await createRemittanceBill(fx.org.orgId, fx.actorId, {
        partyId: fx.org.vendorId, ...PERIOD, subsidiaryId: fx.org.subsidiaryId,
      });
      const childBill = await createRemittanceBill(fx.org.orgId, fx.actorId, {
        partyId: fx.org.vendorId, ...PERIOD, subsidiaryId: child,
      });
      const stamped = (await db.execute<{ id: string; subsidiary_id: string; total: string }>(sql`
        select id, subsidiary_id, total from documents
         where org_id = ${fx.org.orgId} and id = any(${`{${rootBill.documentId},${childBill.documentId}}`}::uuid[])`)).rows;
      assert.equal(stamped.length, 2);
      const bySub = new Map(stamped.map((b) => [b.subsidiary_id, b.total]));
      assert.equal(cmp(bySub.get(fx.org.subsidiaryId)!, "300.00"), 0);
      assert.equal(cmp(bySub.get(child)!, "700.00"), 0);
      assert.equal(
        cmp(sum([...bySub.values()]), group.total),
        0,
        "the split loses and duplicates nothing: slices sum exactly to the group total",
      );

      // Each bill clears its own entity's liability and no other.
      await postAccrualSource(fx, rootRun.documentId, "300.00");
      await postAccrualSource(fx, childRun.documentId, "700.00");
      await postRemittanceBill(fx, rootBill.documentId);
      await postRemittanceBill(fx, childBill.documentId);
      const balances = await liabilityBalances(fx);
      assert.equal(balances.size, 2);
      for (const [subsidiaryId, balance] of balances) {
        assert.equal(cmp(balance, "0"), 0, `liability clears on ${subsidiaryId}`);
      }
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "concurrent creators split without collision and serialize on one slice",
  { skip: !DB },
  async () => {
    const fx = await seedEntityOrg();
    try {
      const child = await addChildSubsidiary(fx, "Child Entity", "CAD");
      await addEntityAccrual(fx, {
        subsidiaryId: fx.org.subsidiaryId, currency: "CAD", amount: "300.00",
      });
      await addEntityAccrual(fx, {
        subsidiaryId: child, currency: "CAD", amount: "700.00",
      });

      // Different slices proceed independently — no deadlock, one bill each.
      const split = await Promise.all([
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.org.vendorId, ...PERIOD, subsidiaryId: fx.org.subsidiaryId,
        }),
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.org.vendorId, ...PERIOD, subsidiaryId: child,
        }),
      ]);
      assert.equal(split.length, 2);

      // The same slice twice serializes on the entity fence: exactly one bill.
      const again = await Promise.allSettled([
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.org.vendorId, ...PERIOD,
          subsidiaryId: child,
        }),
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.org.vendorId, ...PERIOD,
          subsidiaryId: child,
        }),
      ]);
      const fulfilled = again.filter((r) => r.status === "fulfilled");
      const rejected = again.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 0, "the slice was already billed above — both refuse");
      assert.equal(rejected.length, 2);
      for (const r of rejected) {
        assert.match(
          (r as PromiseRejectedResult).reason.message as string,
          /already exists|overlaps/,
        );
      }
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "a single-subsidiary org bills exactly as before, stamped from its slice",
  { skip: !DB },
  async () => {
    const fx = await seedEntityOrg();
    try {
      await addEntityAccrual(fx, {
        subsidiaryId: fx.org.subsidiaryId, currency: "CAD", amount: "100.00",
      });

      const groups = await payrollRemittanceSummary(fx.org.orgId, PERIOD);
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.slices.length, 1);

      const bill = await createRemittanceBill(fx.org.orgId, fx.actorId, {
        partyId: fx.org.vendorId, ...PERIOD,
      });
      const stamped = (await db.execute<{
        subsidiary_id: string; currency: string; memo: string; custom: { payrollRemittance: Record<string, unknown> };
      }>(sql`
        select subsidiary_id, currency, memo, custom from documents
         where org_id = ${fx.org.orgId} and id = ${bill.documentId}`)).rows[0]!;
      assert.equal(stamped.subsidiary_id, fx.org.subsidiaryId);
      assert.equal(stamped.currency, "CAD");
      assert.equal(stamped.memo, "Payroll remittance 2026-07-01 – 2026-07-31");
      assert.equal(
        stamped.custom.payrollRemittance.subsidiaryId,
        fx.org.subsidiaryId,
        "the marker carries the entity for the overlap fence",
      );
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);
