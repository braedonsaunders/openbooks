import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";
import { recordPayRunPayment } from "./payment.ts";
import { commitPayRun } from "./run-commit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { dropScratchOrgReporting, grantScratchPermissions } from "../testing/fixtures.ts";
import { validateNetPayClearingChange, type NetPayClearingWindow } from "./net-pay-clearing.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function postedRun() {
  const fx = await seedAdoption();
  await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.manage", "payroll.run"]);
  const { input } = await calculatedRun(fx);
  await commitPayRun(input);
  const accounts = await db.execute<{ id: string; type: string }>(
    sql`select id,type from accounts where org_id=${fx.orgId}`,
    "objects",
  );
  const account = (type: string) => accounts.find((row) => row.type === type)!.id;
  await db.execute(
    sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`,
  );
  await postDocument(input.documentId, {
    control: {
      ar: account("asset_receivable"),
      ap: account("liability_payable"),
      bank: account("asset_bank"),
    },
  });
  const clearing = randomUUID();
  await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                                             required_dimensions, custom, subsidiary_include_children)
    values (${clearing}, ${fx.orgId}, '9990', 'Payroll cheque clearing', 'expense_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const payDate = (
    await db.execute<{ pay_date: string }>(
      sql`select pay_date::text as pay_date from pay_runs
    where org_id=${fx.orgId} and document_id=${input.documentId}`,
      "objects",
    )
  )[0]!.pay_date;
  return { fx, input, account, clearing, payDate };
}

async function designate(orgId: string, actorId: string, windows: NetPayClearingWindow[]) {
  return withOrgTransaction(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "exclusive");
    const before = (
      await db.execute<{ windows: unknown; net: string | null }>(
        sql`
      select settings->'payroll'->'netPaySettlementClearing' as windows, settings->'payroll'->>'netPayAccountId' as net
        from orgs where id=${orgId} for update`,
        "objects",
      )
    )[0]!;
    const after = await validateNetPayClearingChange(db, {
      orgId,
      actorId,
      before: before.windows,
      after: windows,
      netPayAccountId: before.net,
    });
    await db.execute(
      sql`update orgs set settings = jsonb_set(settings, '{payroll,netPaySettlementClearing}', ${JSON.stringify(after)}::jsonb) where id=${orgId}`,
    );
  });
}

test(
  "net pay settles to the clearing account designated for the payment date, with the ordinary applications and paid state",
  { skip: !DB },
  async () => {
    const { fx, input, account, clearing, payDate } = await postedRun();
    try {
      const window: NetPayClearingWindow = {
        id: randomUUID(),
        accountId: clearing,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        reason: "Bonus cheques are paid from the clearing account",
      };
      await assert.rejects(
        recordPayRunPayment({ ...input, settlementClearingAccountId: clearing }),
        /no net-pay settlement clearing designation names this account/,
      );
      await assert.rejects(
        recordPayRunPayment({
          ...input,
          bankAccountId: account("asset_bank"),
          settlementClearingAccountId: clearing,
        }),
        /choose either/,
      );
      await assert.rejects(
        designate(fx.orgId, fx.actorId, [{ ...window, accountId: account("asset_bank") }]),
        /a bank account is not a clearing account/,
      );
      await designate(fx.orgId, fx.actorId, [window]);
      const dayBefore = new Date(Date.parse(`${payDate}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      await assert.rejects(
        recordPayRunPayment({
          ...input,
          settlementClearingAccountId: clearing,
          paidOn: "2025-12-31",
        }),
        /no net-pay settlement clearing designation/,
      );

      const payment = await recordPayRunPayment({
        ...input,
        settlementClearingAccountId: clearing,
        paidOn: payDate,
      });
      const lines = await db.execute<{ account_id: string; amount: string; applied: boolean }>(
        sql`
      select jl.account_id::text as account_id, jl.amount::text as amount,
             exists(select 1 from applications a where a.org_id=jl.org_id and a.from_line_id=jl.id) as applied
        from journal_lines jl where jl.org_id=${fx.orgId} and jl.entry_id=${payment.entryId}`,
        "objects",
      );
      const credit = lines.filter((line) => line.amount.startsWith("-"));
      assert.deepEqual(
        credit.map((line) => line.account_id),
        [clearing],
        "the net pay is credited to the clearing account, never a bank",
      );
      assert.ok(
        lines.filter((line) => !line.amount.startsWith("-")).every((line) => line.applied),
        "each net-pay debit settles its open item",
      );
      const paid = (
        await db.execute<{ paid_entry_id: string }>(
          sql`select paid_entry_id::text as paid_entry_id from pay_runs
      where org_id=${fx.orgId} and document_id=${input.documentId}`,
          "objects",
        )
      )[0]!;
      assert.equal(paid.paid_entry_id, payment.entryId);
      const audit = (
        await db.execute<{ changes: Record<string, unknown> }>(
          sql`select changes from audit_log where org_id=${fx.orgId}
      and table_name='pay_runs' and row_id=${input.documentId} and changes->>'operation'='record_pay_run_payment'`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(audit.changes.settlement, {
        kind: "clearing",
        accountId: clearing,
        designation: window,
      });
      assert.equal(audit.changes.bankAccountId, null);

      // A used window keeps its identity, account, start and reason; it can only be end-dated after its last use.
      await assert.rejects(designate(fx.orgId, fx.actorId, []), /can only be end-dated/);
      await assert.rejects(
        designate(fx.orgId, fx.actorId, [{ ...window, reason: "Restated" }]),
        /can only be end-dated/,
      );
      await assert.rejects(
        designate(fx.orgId, fx.actorId, [{ ...window, effectiveTo: dayBefore }]),
        /end it on or after/,
      );
      await designate(fx.orgId, fx.actorId, [{ ...window, effectiveTo: payDate }]);
      await assert.rejects(
        designate(fx.orgId, fx.actorId, [
          { ...window, effectiveTo: payDate },
          {
            id: randomUUID(),
            accountId: clearing,
            effectiveFrom: payDate,
            effectiveTo: null,
            reason: "Overlapping",
          },
        ]),
        /overlap/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test("a run with issued cheques never settles to a clearing account", { skip: !DB }, async () => {
  const { fx, input, clearing, payDate } = await postedRun();
  try {
    await designate(fx.orgId, fx.actorId, [
      {
        id: randomUUID(),
        accountId: clearing,
        effectiveFrom: payDate,
        effectiveTo: null,
        reason: "Clearing settlement",
      },
    ]);
    await db.execute(
      sql`update pay_stubs set cheque_number='000101' where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`,
    );
    await assert.rejects(
      recordPayRunPayment({ ...input, settlementClearingAccountId: clearing }),
      /issued cheques/,
    );
    assert.equal(
      (
        await db.execute(
          sql`select paid_entry_id from pay_runs where org_id=${fx.orgId}
      and document_id=${input.documentId} and paid_entry_id is not null`,
          "objects",
        )
      ).length,
      0,
    );
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test(
  "corrupted designations that repeat an id or overlap refuse instead of choosing one",
  { skip: !DB },
  async () => {
    const { fx, input, clearing, payDate } = await postedRun();
    try {
      const window = {
        id: randomUUID(),
        accountId: clearing,
        effectiveFrom: payDate,
        effectiveTo: null,
        reason: "Clearing settlement",
      };
      for (const stored of [
        [window, { ...window, effectiveFrom: "2000-01-01", effectiveTo: "2000-12-31" }],
        [window, { ...window, id: randomUUID(), effectiveFrom: "2000-01-01" }],
      ]) {
        await db.execute(
          sql`update orgs set settings = jsonb_set(settings, '{payroll,netPaySettlementClearing}', ${JSON.stringify(stored)}::jsonb) where id=${fx.orgId}`,
        );
        await assert.rejects(
          recordPayRunPayment({ ...input, settlementClearingAccountId: clearing }),
          /its own id|overlap/,
        );
      }
      // A valid replacement still repairs corrupted storage.
      await designate(fx.orgId, fx.actorId, [window]);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a clearing settlement never credits the net-pay payable the run actually posted to",
  { skip: !DB },
  async () => {
    const { fx, input, account, payDate } = await postedRun();
    try {
      const posted = (
        await db.execute<{ account_id: string }>(
          sql`select distinct jl.account_id::text as account_id
      from documents d join journal_lines jl on jl.org_id=d.org_id and jl.entry_id=d.posted_entry_id
      where d.org_id=${fx.orgId} and d.id=${input.documentId} and jl.is_open_item and jl.party_id is not null and jl.amount<0`,
          "objects",
        )
      )[0]!.account_id;
      // Settings moved on after posting, so the current payable no longer names the posted one.
      const replacement = randomUUID();
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                                               required_dimensions, custom, subsidiary_include_children)
      values (${replacement}, ${fx.orgId}, '2401', 'Net pay payable (new)', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await db.execute(
        sql`update orgs set settings = jsonb_set(settings, '{payroll,netPayAccountId}', to_jsonb(${replacement}::text)) where id=${fx.orgId}`,
      );
      assert.notEqual(posted, account("asset_bank"));
      await designate(fx.orgId, fx.actorId, [
        {
          id: randomUUID(),
          accountId: posted,
          effectiveFrom: payDate,
          effectiveTo: null,
          reason: "Mis-designated payable",
        },
      ]);
      await assert.rejects(
        recordPayRunPayment({ ...input, settlementClearingAccountId: posted }),
        /net-pay payable this run posted to/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
