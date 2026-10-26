import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withBypassContext } from "../platform/db.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import { commitPayRun } from "./run-commit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { recordPayRunPayment, readPayRunPaymentEvidence } from "./payment.ts";
import { createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";

async function fixture() {
  const fx = await seedAdoption();
  try {
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    const accounts = await db.execute<{ id: string; type: string }>(
      sql`select id,type from accounts where org_id=${fx.orgId}`,
      "objects",
    );
    const account = (type: string) => {
      const id = accounts.find((a) => a.type === type)?.id;
      assert.ok(id);
      return id;
    };
    const bankAccountId = account("asset_bank");
    await db.execute(
      sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`,
    );
    await postDocument(input.documentId, {
      control: {
        ar: account("asset_receivable"),
        ap: account("liability_payable"),
        bank: bankAccountId,
      },
    });
    return { ...fx, input, bankAccountId };
  } catch (error) {
    await dropScratchOrgReporting(fx.orgId);
    throw error;
  }
}

test(
  "payroll settlement receipt and native reader retain exact endpoints, actor, before/after and immutable source",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await fixture();
    try {
      const before = await readPayRunPaymentEvidence(fx.input);
      assert.equal(before.paidAt, null);
      assert.deepEqual(before.applications, []);
      const source = await db.execute(
        sql`select (to_jsonb(d)-'open_balance'-'revision_seq'-'updated_at')::text as doc from documents d where org_id=${fx.orgId} and id=${fx.input.documentId}`,
        "objects",
      );
      const result = await recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId });
      const current = await readPayRunPaymentEvidence({
        ...fx.input,
        documentId: fx.input.documentId.toUpperCase(),
      });
      assert.deepEqual(current, result.evidence);
      assert.equal(current.paidEntryId, result.entryId);
      assert.ok(current.paidAt);
      assert.equal(current.applications.length, 1);
      const application = current.applications[0]!;
      assert.ok(application.id);
      assert.ok(application.fromLineId);
      assert.ok(application.toLineId);
      assert.equal(application.fromEntryId, result.entryId);
      assert.equal(application.toEntryId, before.sourceEntryId);
      assert.equal(application.employeePartyId, fx.employeeId);
      assert.equal(application.createdBy, fx.actorId);
      assert.equal(application.rateSource, "same_currency");
      assert.equal(application.sourceCurrency, "CAD");
      const event = await db.execute<{
        changes: { before: typeof before; after: typeof current };
        actor_id: string;
      }>(
        sql`
      select changes, actor_id from audit_log where org_id=${fx.orgId} and table_name='pay_runs' and row_id=${fx.input.documentId}
        and changes->>'operation'='record_pay_run_payment'`,
        "objects",
      );
      assert.equal(event.length, 1);
      assert.equal(event[0]!.actor_id, fx.actorId);
      assert.deepEqual(event[0]!.changes.before, before);
      assert.deepEqual(event[0]!.changes.after, current);
      await assert.rejects(
        recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId }),
        /already recorded as paid/,
      );
      assert.deepEqual(await readPayRunPaymentEvidence(fx.input), current);
      assert.deepEqual(
        await db.execute(
          sql`select (to_jsonb(d)-'open_balance'-'revision_seq'-'updated_at')::text as doc from documents d where org_id=${fx.orgId} and id=${fx.input.documentId}`,
          "objects",
        ),
        source,
      );
      assert.equal(
        (
          await db.execute<{ balance: string }>(
            sql`select open_balance::text as balance from documents where org_id=${fx.orgId} and id=${fx.input.documentId}`,
            "objects",
          )
        )[0]!.balance,
        "0.0000",
        "the native application updates only the derived outstanding balance and its revision stamps",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "payroll settlement read and write require current native permissions, complete posted entity scope and payroll feature",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await fixture();
    try {
      const reader = await createScratchUser(
        fx.orgId,
        "Settlement reader",
        "payroll_settlement_reader",
      );
      const role = async (permissions: string[], ids: string[]) =>
        db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb,
      subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: ids })}::jsonb where org_id=${fx.orgId} and key='payroll_settlement_reader'`);
      const read = () =>
        withOrgContext(fx.orgId, () => readPayRunPaymentEvidence({ ...fx.input, actorId: reader }));
      const pay = () =>
        withOrgContext(fx.orgId, () =>
          recordPayRunPayment({ ...fx.input, actorId: reader, bankAccountId: fx.bankAccountId }),
        );
      for (const permissions of [[], ["ap.read"], ["gl.read"]]) {
        await role(permissions, [fx.subsidiaryId]);
        await assert.rejects(read, /pay run not found/);
        await assert.rejects(pay, /pay run not found/);
      }
      await role(["payroll.read"], []);
      await assert.rejects(read, /pay run not found/);
      await role(["payroll.read"], [fx.subsidiaryId]);
      assert.equal((await read()).paidAt, null);
      await assert.rejects(pay, /pay run not found/);
      await role(["payroll.run", "payroll.read"], [randomUUID()]);
      await assert.rejects(read, /pay run not found/);
      await assert.rejects(pay, /pay run not found/);
      await role(["payroll.read", "payroll.run"], [fx.subsidiaryId]);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','false'::jsonb) where id=${fx.orgId}`,
      );
      await assert.rejects(read, /feature is disabled/);
      await assert.rejects(pay, /feature is disabled/);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','true'::jsonb) where id=${fx.orgId}`,
      );
      assert.equal((await read()).paidAt, null);
      assert.equal(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from applications where org_id=${fx.orgId}`,
            "objects",
          )
        )[0]!.n,
        "0",
      );
      const missing = randomUUID();
      await assert.rejects(
        readPayRunPaymentEvidence({ ...fx.input, actorId: missing }),
        /pay run not found/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "failed settlement audit rolls the entry, applications and paid stamps back",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await fixture();
    const trigger = `payroll_settlement_audit_fault_${randomUUID().replaceAll("-", "")}`;
    try {
      await withBypassContext(() =>
        db.execute(
          sql.raw(
            `create function public.${trigger}() returns trigger language plpgsql as $$begin if new.org_id='${fx.orgId}'::uuid and new.changes->>'operation'='record_pay_run_payment' then raise exception 'settlement audit refused'; end if; return new; end$$; create trigger ${trigger} before insert on audit_log for each row execute function public.${trigger}()`,
          ),
        ),
      );
      await assert.rejects(recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId }));
      const evidence = await readPayRunPaymentEvidence(fx.input);
      assert.equal(evidence.paidAt, null);
      assert.equal(evidence.paidEntryId, null);
      assert.deepEqual(evidence.applications, []);
      assert.equal(
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from journal_entries where org_id=${fx.orgId}`,
            "objects",
          )
        )[0]!.n,
        "1",
      );
    } finally {
      await withBypassContext(() =>
        db.execute(
          sql.raw(
            `drop trigger if exists ${trigger} on audit_log; drop function if exists public.${trigger}()`,
          ),
        ),
      );
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
