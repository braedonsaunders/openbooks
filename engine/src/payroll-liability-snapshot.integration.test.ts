import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createRemittanceBill, payrollRemittanceSummary } from "./payroll-remittance.ts";
import { commitPayRun } from "./payroll-run.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";

/**
 * The account a committed deduction was credited to is history. Before
 * migration 0094 the remittance summary and the remittance bill re-read the
 * pay component's CURRENT liability account, so repointing a component in
 * setup moved an already-accrued period to a different account: the original
 * stayed credited forever and the new one went contra.
 */
test(
  "a committed remittance period keeps the liability account it was credited to after the component is repointed",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const range = { from: "2026-07-01", to: "2026-07-31" };
      const before = await payrollRemittanceSummary(fx.orgId, range);
      assert.ok(before.length > 0);
      const cppBefore = before.flatMap((g) => g.components).find((c) => c.systemKey === "cpp");
      assert.ok(cppBefore?.liabilityAccountId, "CPP accrued to a liability account");
      const original = cppBefore.liabilityAccountId;

      // Every committed liability line carries its credited account.
      const stamped = (await db.execute<{ source: string; n: string }>(sql`
        select l.liability_account_source as source, count(*)::text as n
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
         where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${input.documentId}
           and l.kind in ('deduction', 'employer_contribution')
         group by 1`)).rows;
      assert.deepEqual(stamped.map((r) => r.source), ["commit"]);
      assert.ok(Number(stamped[0]!.n) > 0);

      // Setup repoints the CPP component to a new payable account.
      const replacement = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${replacement}, ${fx.orgId}, '2311', 'CPP payable (new)', 'liability_current_other',
                false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await db.execute(sql`
        update pay_components set liability_account_id = ${replacement}, updated_at = now()
         where org_id = ${fx.orgId} and system_key = 'cpp'`);

      const after = await payrollRemittanceSummary(fx.orgId, range);
      const cppAfter = after.flatMap((g) => g.components).find((c) => c.systemKey === "cpp");
      assert.equal(cppAfter?.liabilityAccountId, original, "the accrued period stays on the credited account");

      // The remittance bill debits the credited account, not the new setup.
      const vendor = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${vendor}, ${fx.orgId}, 'organization', 'Receiver General', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
        values (${fx.orgId}, ${vendor}, true, ${fx.actorId}, ${fx.actorId})`);
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{payroll,craRemittancePartyId}', to_jsonb(${vendor}::text))
         where id = ${fx.orgId}`);
      const group = (await payrollRemittanceSummary(fx.orgId, range)).find((g) =>
        g.components.some((c) => c.systemKey === "cpp"),
      );
      assert.ok(group);
      const bill = await createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: group.partyId ?? vendor,
        from: range.from,
        to: range.to,
        filingAccountId: group.filingAccount.id,
      });
      const debited = (await db.execute<{ account_id: string }>(sql`
        select account_id from document_lines
         where org_id = ${fx.orgId} and document_id = ${bill.documentId}`)).rows.map((r) => r.account_id);
      assert.ok(debited.includes(original));
      assert.ok(!debited.includes(replacement));

      // The stamp is immutable once committed.
      await assert.rejects(
        db.execute(sql`
          update pay_stub_lines l set liability_account_id = ${replacement}
            from pay_stubs s
           where s.id = l.stub_id and s.org_id = l.org_id and s.org_id = ${fx.orgId}
             and s.pay_run_document_id = ${input.documentId} and l.liability_account_source = 'commit'`),
        (error: unknown) => {
          const cause = (error as { cause?: { message?: string } }).cause;
          assert.match(String(cause?.message ?? error), /immutable/);
          return true;
        },
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
