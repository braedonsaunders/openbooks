import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
  withMaintenanceTransaction,
} from "../../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedPayrollDocument,
  seedPayrollStub,
} from "../../testing/fixtures.ts";
import { errorChainMatches } from "../../testing/error-chain.ts";
import { createSandbox, deleteSandbox } from "../../sandbox/lifecycle.ts";
import { seedAdoption } from "../filing-test-fixtures.ts";
import { loadUsFilingAccounts, resolveUsFederalFilingAccount } from "./employer-scope.ts";
import { validateUsFilingAccountLineage } from "./filing-account-lineage.ts";
const skip = !process.env.OPENBOOKS_DB_URL;

test(
  "original used account lineage survives activation, cannot shrink across committed source dates, and serializes policy writes with readers",
  { skip },
  async () => {
    const f = await withBypassContext(() => seedAdoption());
    try {
      await withBypassContext(() =>
        db.execute(
          sql`update subsidiaries set country='US' where org_id=${f.orgId} and id=${f.subsidiaryId}`,
        ),
      );
      await withOrgContext(f.orgId, async () => {
        const ein = randomUUID(),
          state = randomUUID(),
          lineage = randomUUID();
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,subsidiary_id,state_code,created_by,updated_by)
        values(${ein},${f.orgId},'US','us_ein','12-3456789','Original EIN',${f.subsidiaryId},null,${f.actorId},${f.actorId}),
          (${state},${f.orgId},'US','us_state_sui','NJ-ORIGINAL','New Jersey registration',${f.subsidiaryId},'NJ',${f.actorId},${f.actorId})`);
        const input = {
          filingAccountId: state,
          federalAccountId: ein,
          subsidiaryId: f.subsidiaryId,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          sourceReference: "Original state employer registration",
          changeReason: "Retain the original state registration employer",
        };
        await db.transaction(async (tx) => {
          await validateUsFilingAccountLineage(tx, f.orgId, input);
          await tx.execute(sql`insert into payroll_us_filing_account_employer_lineage
          (id,org_id,filing_account_id,federal_account_id,subsidiary_id,effective_from,source_reference,change_reason,created_by,updated_by)
          values(${lineage},${f.orgId},${state},${ein},${f.subsidiaryId},'2026-01-01',${input.sourceReference},${input.changeReason},${f.actorId},${f.actorId})`);
        });
        const documentId = randomUUID();
        await seedPayrollDocument(f.orgId, documentId, {
          kind: "pay_run",
          documentNumber: "PAY-ORIGINAL-EIN",
          subsidiaryId: f.subsidiaryId,
          documentDate: "2026-07-21",
          currency: "USD",
          status: "draft",
          createdBy: f.actorId,
          updatedBy: f.actorId,
        });
        await db.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,created_by,updated_by)
        values(${documentId},${f.orgId},${f.scheduleId},'2026-07-05','2026-07-18','2026-07-21',2026,'committed',${f.actorId},${f.actorId})`);
        await seedPayrollStub(f.orgId, documentId, f.employeeId, f.employmentId, {
          country: "US",
          countrySource: "calculation",
          province: "NJ",
          filingAccountId: state,
          filingAccountSource: "insertion",
          periodsPerYear: 26,
          payDate: "2026-07-21",
          taxYear: 2026,
          currency: "USD",
          gross: "1000",
          netPay: "900",
          pensionableEarnings: "1000",
          insurableEarnings: "1000",
          factors: { SS: "62", MED: "14.5", MED2: "0" },
          createdBy: f.actorId,
          updatedBy: f.actorId,
        });
        await assert.rejects(
          db.transaction((tx) =>
            tx.execute(sql`update payroll_us_filing_account_employer_lineage
        set effective_to='2026-07-20',change_reason='Attempt to remove an original used date' where org_id=${f.orgId} and id=${lineage}`),
          ),
          (error) => errorChainMatches(error, /cannot end before payroll/),
        );
        await assert.rejects(
          db.transaction((tx) =>
            tx.execute(sql`update payroll_filing_accounts set subsidiary_id=null
        where org_id=${f.orgId} and id=${ein}`),
          ),
          (error) => errorChainMatches(error, /cannot change.*legal employer/),
        );
        await db.execute(
          sql`update payroll_filing_accounts set is_active=false where org_id=${f.orgId} and id=${ein}`,
        );
        assert.equal(
          resolveUsFederalFilingAccount(
            await loadUsFilingAccounts(db, f.orgId),
            state,
            f.subsidiaryId,
            "2026-07-21",
          ),
          ein,
        );
        // Normal row locks arbitrate concurrency: a writer cannot cross a
        // reader's parent lock and then invalidate its original-date resolution.
        await db.transaction(async (reader) => {
          await loadUsFilingAccounts(reader, f.orgId);
          await assert.rejects(
            withOrgContext(f.orgId, () =>
              db.transaction(async (writer) => {
                await writer.execute(sql`set local lock_timeout='100ms'`);
                await writer.execute(sql`update payroll_us_filing_account_employer_lineage
            set effective_to='2026-08-31',change_reason='Close after final original payroll' where org_id=${f.orgId} and id=${lineage}`);
              }),
            ),
            (error) => errorChainMatches(error, /lock timeout/),
          );
        });
        await db.execute(sql`update payroll_us_filing_account_employer_lineage set effective_to='2026-07-21',
        change_reason='Close after the last original payroll date' where org_id=${f.orgId} and id=${lineage}`);
        const retained = await db.execute<{ effective_to: string }>(
          sql`select effective_to::text from payroll_us_filing_account_employer_lineage
        where org_id=${f.orgId} and id=${lineage}`,
          "objects",
        );
        assert.equal(retained[0]!.effective_to, "2026-07-21");
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

for (const masked of [false, true]) {
  test(
    `a ${masked ? "masked" : "full"} native sandbox retains original filing identity and dates with only authorized source-prose redaction`,
    { skip },
    async () => {
      const f = await withBypassContext(() => seedAdoption());
      let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
      try {
        const ein = randomUUID(),
          state = randomUUID(),
          lineage = randomUUID();
        await withBypassContext(async () => {
          await db.execute(
            sql`update subsidiaries set country='US' where org_id=${f.orgId} and id=${f.subsidiaryId}`,
          );
          await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,subsidiary_id,state_code,created_by,updated_by)
          values(${ein},${f.orgId},'US','us_ein','98-7654321','Federal employer',${f.subsidiaryId},null,${f.actorId},${f.actorId}),
            (${state},${f.orgId},'US','us_state_sui','NJ-RETAINED','State registration',${f.subsidiaryId},'NJ',${f.actorId},${f.actorId})`);
          await db.execute(sql`insert into payroll_us_filing_account_employer_lineage
          (id,org_id,filing_account_id,federal_account_id,subsidiary_id,effective_from,effective_to,source_reference,change_reason,created_by,updated_by)
          values(${lineage},${f.orgId},${state},${ein},${f.subsidiaryId},'2026-01-01','2026-06-30',
            'Registration reviewed with Jordan Smith','Jordan Smith confirmed the original legal employer',${f.actorId},${f.actorId})`);
        });
        sandbox = await withBypassContext(() =>
          createSandbox({
            productionOrgId: f.orgId,
            name: "Original filing authority review",
            tier: masked ? "masked" : "full",
            masked,
          }),
        );
        const target = sandbox.sandboxOrgId;
        const copies = await withBypassContext(() =>
          db.execute<{ actual: Record<string, unknown>; expected: Record<string, unknown> }>(
            sql`
        select to_jsonb(copy) as actual,
          to_jsonb(original) || jsonb_build_object(
            'id',public.ob_rebase(original.id,org.sandbox_seed),'org_id',org.id,
            'filing_account_id',public.ob_rebase(original.filing_account_id,org.sandbox_seed),
            'federal_account_id',public.ob_rebase(original.federal_account_id,org.sandbox_seed),
            'subsidiary_id',public.ob_rebase(original.subsidiary_id,org.sandbox_seed),
            'created_by',public.ob_rebase(original.created_by,org.sandbox_seed),
            'updated_by',public.ob_rebase(original.updated_by,org.sandbox_seed),
            'source_reference',case when control.masked then 'REDACTED' else original.source_reference end,
            'change_reason',case when control.masked then 'REDACTED' else original.change_reason end
          ) as expected
        from orgs org join sandboxes control on control.org_id=org.id and control.production_org_id=org.sandbox_of
        join payroll_us_filing_account_employer_lineage original on original.org_id=org.sandbox_of and original.id=${lineage}
        join payroll_us_filing_account_employer_lineage copy on copy.org_id=org.id and copy.id=public.ob_rebase(original.id,org.sandbox_seed)
        where org.id=${target}
      `,
            "objects",
          ),
        );
        assert.equal(copies.length, 1);
        const actual = copies[0]!.actual;
        assert.deepEqual(
          actual,
          copies[0]!.expected,
          "every original identity, date, timestamp and actor follows the exact native clone projection",
        );
        assert.equal(
          actual.source_reference,
          masked ? "REDACTED" : "Registration reviewed with Jordan Smith",
        );
        assert.equal(
          actual.change_reason,
          masked ? "REDACTED" : "Jordan Smith confirmed the original legal employer",
        );
        const matches = async (candidate: Record<string, unknown>) =>
          (
            await db.execute<{ allowed: boolean }>(
              sql`
        select public.payroll_us_filing_account_lineage_clone_matches(${JSON.stringify(candidate)}::jsonb) as allowed
      `,
              "objects",
            )
          )[0]!.allowed;
        await withOrgContext(target, async () => {
          assert.equal(
            await matches(actual),
            false,
            "ordinary tenant access cannot invoke clone admission",
          );
        });
        await withMaintenanceTransaction(null, async () => {
          await db.execute(
            sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`,
          );
          assert.equal(
            await matches(actual),
            false,
            "a completed native sandbox is outside the recorded clone lifecycle",
          );
          const prior = (
            await db.execute<{ status: string }>(
              sql`select status from sandboxes where id=${sandbox!.sandboxId} for update`,
              "objects",
            )
          )[0]!.status;
          await db.execute(
            sql`update sandboxes set status='refreshing' where id=${sandbox!.sandboxId}`,
          );
          assert.equal(
            await matches(actual),
            true,
            "the exact projection is admitted only during native-authorized cloning",
          );
          for (const patch of [
            {
              source_reference: masked ? "Original prose copied into a masked sandbox" : "REDACTED",
            },
            { change_reason: masked ? "Another redaction marker" : "REDACTED" },
            { effective_from: "2026-01-02" },
            { effective_to: null },
            { federal_account_id: randomUUID() },
            { filing_account_id: randomUUID() },
            { subsidiary_id: randomUUID() },
            { created_by: randomUUID() },
            { updated_by: randomUUID() },
            { org_id: f.orgId },
          ])
            assert.equal(
              await matches({ ...actual, ...patch }),
              false,
              "prose, payer, account, date and actor changes cannot use exact clone admission",
            );
          await db.execute(
            sql`update sandboxes set status=${prior} where id=${sandbox!.sandboxId}`,
          );
        });
        await withBypassContext(() => deleteSandbox(sandbox!.sandboxId));
        sandbox = undefined;
      } finally {
        const failures: unknown[] = [];
        if (sandbox)
          try {
            await withBypassContext(() => dropScratchOrgReporting(sandbox!.sandboxOrgId));
          } catch (error) {
            failures.push(error);
          }
        try {
          await withBypassContext(() => dropScratchOrgReporting(f.orgId));
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new AggregateError(failures, "Original filing authority fixture teardown failed");
      }
    },
  );
}
