import {
  seedAdoption,
  calculatedRun,
  markLegacy,
} from "./payroll-filing-test-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { reconcilePayrollFilingAccounts } from "./payroll-filing-reconciliation.ts";
import { filingAccountsById, listFilingAccounts } from "./payroll-filing.ts";
import { commitPayRun } from "./payroll-run.ts";
import { t4Slips, t4Summary } from "./payroll-yearend.ts";
import { payrollRemittanceSummary } from "./payroll-remittance.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";
for (const change of [
  "profile",
  "default",
  "delete-profile",
  "deactivate",
] as const) {
  test(
    `committed payroll filing attribution survives a later ${change} assignment change`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      try {
        const first = randomUUID(),
          second = randomUUID();
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,is_default)
          values(${first},${fx.orgId},'CA','ca_rp','123456789RP0001','First payroll account',true),
          (${second},${fx.orgId},'CA','ca_rp','123456789RP0002','Second payroll account',false)`);
        if (change === "profile" || change === "delete-profile")
          await db.execute(sql`update employee_payroll_profiles set filing_account_id=${first}
          where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
        const { input } = await calculatedRun(fx);
        await commitPayRun(input);
        const summaryBefore = await t4Summary(fx.orgId, 2026, first);
        const before = await t4Slips(fx.orgId, 2026);
        assert.equal(before[0]?.filingAccountId, first);
        const remittanceBefore = await payrollRemittanceSummary(fx.orgId, {
          from: "2026-07-01",
          to: "2026-07-31",
        });
        assert.ok(remittanceBefore.length > 0);
        assert.equal(remittanceBefore[0]?.filingAccount.id, first);
        if (change === "profile")
          await db.execute(sql`update employee_payroll_profiles set filing_account_id=${second}
          where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
        else if (change === "delete-profile")
          await db.execute(
            sql`delete from employee_payroll_profiles where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
          );
        else if (change === "deactivate")
          await db.execute(
            sql`update payroll_filing_accounts set is_active=false where org_id=${fx.orgId} and id=${first}`,
          );
        else
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`update payroll_filing_accounts set is_default=false where org_id=${fx.orgId} and id=${first}`,
            );
            await tx.execute(
              sql`update payroll_filing_accounts set is_default=true where org_id=${fx.orgId} and id=${second}`,
            );
          });
        const after = await t4Slips(fx.orgId, 2026);
        const remittanceAfter = await payrollRemittanceSummary(fx.orgId, {
          from: "2026-07-01",
          to: "2026-07-31",
        });
        assert.deepEqual(
          { slips: after, remittance: remittanceAfter },
          { slips: before, remittance: remittanceBefore },
        );
        assert.deepEqual(await t4Summary(fx.orgId, 2026, first), summaryBefore);
        if (change === "deactivate") {
          assert.equal(
            (await listFilingAccounts(fx.orgId)).some((a) => a.id === first),
            false,
          );
          assert.equal(
            (await filingAccountsById(fx.orgId)).get(first)?.accountNumber,
            "123456789RP0001",
          );
        }
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "captured unassigned payroll never adopts a later default and rejects attribution rewrites",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const before = await t4Slips(fx.orgId, 2026);
      const stub = (
        await db.execute<{ id: string; filing_account_source: string }>(
          sql`select id,filing_account_source from pay_stubs where org_id=${fx.orgId}`,
        )
      ).rows[0]!;
      assert.equal(stub.filing_account_source, "calculation");
      const account = randomUUID();
      await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,is_default)
      values(${account},${fx.orgId},'CA','ca_rp','123456789RP0001','Later account',true)`);
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      assert.equal(
        (
          await payrollRemittanceSummary(fx.orgId, {
            from: "2026-07-01",
            to: "2026-07-31",
          })
        )[0]?.filingAccount.id,
        null,
      );
      await assert.rejects(
        db.execute(
          sql`update pay_stubs set filing_account_id=${account} where org_id=${fx.orgId} and id=${stub.id}`,
        ),
        /Failed query/,
      );
      await assert.rejects(
        reconcilePayrollFilingAccounts({
          orgId: fx.orgId,
          actorId: fx.actorId,
          rows: [
            {
              stubId: stub.id,
              filingAccountId: account,
              reason: "Attempt reassignment",
              reference: "reviewed-register",
            },
          ],
        }),
        /not unresolved legacy/,
      );
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "legacy attribution requires evidence, is audited once, and rolls failed batches back inside caller transactions",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const before = await t4Slips(fx.orgId, 2026);
      const stubId = await markLegacy(fx.orgId);
      await assert.rejects(
        t4Slips(fx.orgId, 2026),
        /unknown historical filing account/,
      );
      await assert.rejects(
        payrollRemittanceSummary(fx.orgId, {
          from: "2026-07-01",
          to: "2026-07-31",
        }),
        /unknown historical filing account/,
      );
      const row = {
        stubId,
        filingAccountId: null,
        reason: "Reviewed original unassigned register",
        reference: "archive/payroll/2026-07-21",
      };
      await assert.rejects(
        reconcilePayrollFilingAccounts({
          orgId: fx.orgId,
          actorId: randomUUID(),
          rows: [row],
        }),
        /permission/,
      );
      await assert.rejects(
        reconcilePayrollFilingAccounts({
          orgId: fx.orgId,
          actorId: fx.actorId,
          rows: [{ ...row, reference: "" }],
        }),
        /evidence reference/,
      );
      await assert.rejects(
        db.execute(sql`update pay_stubs set filing_account_source='reconciled',filing_account_evidence='{}'::jsonb,
      updated_by=${fx.actorId} where org_id=${fx.orgId} and id=${stubId}`),
        /Failed query/,
      );
      await withOrgTransaction(fx.orgId, async () => {
        await assert.rejects(
          reconcilePayrollFilingAccounts({
            orgId: fx.orgId,
            actorId: fx.actorId,
            rows: [
              row,
              { ...row, stubId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
            ],
          }),
          /not unresolved legacy/,
        );
        assert.equal(
          (
            await db.execute<{ source: string }>(
              sql`select filing_account_source as source from pay_stubs where id=${stubId}`,
            )
          ).rows[0]?.source,
          "unknown",
        );
      });
      assert.equal(
        await reconcilePayrollFilingAccounts({
          orgId: fx.orgId,
          actorId: fx.actorId,
          rows: [row],
        }),
        1,
      );
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      const audits = await db.execute<{
        actor_id: string;
        changes: {
          before: { filing_account_source: string };
          after: { filing_account_source: string };
          evidence: { reference: string };
        };
      }>(sql`
      select actor_id,changes from audit_log where org_id=${fx.orgId} and table_name='pay_stubs' and row_id=${stubId}
        and changes->>'operation'='reconcile_filing_account'`);
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0]?.actor_id, fx.actorId);
      assert.equal(
        audits.rows[0]?.changes.before.filing_account_source,
        "unknown",
      );
      assert.equal(
        audits.rows[0]?.changes.after.filing_account_source,
        "reconciled",
      );
      assert.equal(audits.rows[0]?.changes.evidence.reference, row.reference);
      await assert.rejects(
        reconcilePayrollFilingAccounts({
          orgId: fx.orgId,
          actorId: fx.actorId,
          rows: [row],
        }),
        /not unresolved legacy/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "snapshot references reject cross-tenant/country accounts and preserve accounts needed by historical payroll",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    const other = await createScratchOrg();
    try {
      const account = randomUUID(),
        foreign = randomUUID(),
        us = randomUUID();
      await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,is_default)
      values(${account},${fx.orgId},'CA','ca_rp','123456789RP0001','Original account',true),
        (${foreign},${other.orgId},'CA','ca_rp','123456789RP0001','Other tenant',true),
        (${us},${fx.orgId},'US','us_ein','12-3456789','Other country',false)`);
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const before = await t4Slips(fx.orgId, 2026);
      await assert.rejects(
        db.execute(
          sql`delete from payroll_filing_accounts where org_id=${fx.orgId} and id=${account}`,
        ),
        /Failed query/,
      );
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      const stubId = await markLegacy(fx.orgId);
      for (const filingAccountId of [foreign, us]) {
        await assert.rejects(
          reconcilePayrollFilingAccounts({
            orgId: fx.orgId,
            actorId: fx.actorId,
            rows: [
              {
                stubId,
                filingAccountId,
                reason: "Review",
                reference: "Original payroll register",
              },
            ],
          }),
          /Failed query/,
        );
      }
      assert.equal(
        await reconcilePayrollFilingAccounts({
          orgId: fx.orgId,
          actorId: fx.actorId,
          rows: [
            {
              stubId,
              filingAccountId: account,
              reason: "Original account verified",
              reference: "Original payroll register",
            },
          ],
        }),
        1,
      );
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
      await dropScratchOrgReporting(other.orgId);
    }
  },
);
