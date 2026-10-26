import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sealSecret } from "../platform/secrets.ts";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { seedAdoption, seedHiredEmployee, seedRoeIssuanceFixture } from "./filing-test-fixtures.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { roeRecord } from "./yearend.ts";
import { recordFilingIssue } from "./yearend-amendments.ts";
import {
  readRoeSeparationFacts,
  readRoeSeparationFactsContext,
  saveRoeSeparationFacts,
} from "./roe-separation-facts.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
async function setup() {
  const f = await seedAdoption({ hiredOn: "1998-08-25" });
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  return f;
}

const declaration = {
  firstDayWorked: "2009-03-16",
  interruptionOn: "2026-05-09",
  lastInsurableEarningsOn: "2026-05-08",
  salaryContinuanceEndOn: null,
  sourceReference: "Original employer separation record, Block 11",
  reason: "Record the confirmed interruption facts",
  status: "draft" as const,
  expectedId: null,
  expectedUpdatedAt: null,
};

for (const dated of [true, false]) {
  test(
    dated
      ? "ROE accepts a later final cheque with retained earned dates and refuses genuinely later service"
      : "ROE refuses a later final cheque whose retained earned-period attribution is missing",
    { skip: !DB },
    async () => {
      const f = await withBypassContext(setup);
      try {
        await withOrgContext(f.orgId, async () => {
          const filingAccountId = randomUUID();
          const account = await db.execute(
            sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
    values (${filingAccountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001',
     'Canadian payroll account','regular',true,true,${f.actorId},${f.actorId}) returning id`,
            "objects",
          );
          assert.equal(account.length, 1);
          const profile = await db.execute(
            sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
            "objects",
          );
          assert.equal(profile.length, 1);
          await seedRoeIssuanceFixture(f.orgId, f.employeeId);
          const scope = {
            orgId: f.orgId,
            actorId: f.actorId,
            employeePartyId: f.employeeId,
            employmentId: f.employmentId,
            subsidiaryId: f.subsidiaryId,
            allowedSubsidiaryIds: null,
          };
          const original = await readRoeSeparationFacts(scope);
          assert.ok(original);
          const confirmed = await saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            firstDayWorked: "2026-05-07",
            status: "confirmed",
            expectedId: original.id,
            expectedUpdatedAt: original.updatedAt,
          });
          const component = await db.execute<{ id: string }>(
            sql`select id from pay_components
    where org_id=${f.orgId} and system_key='base_pay'`,
            "objects",
          );
          assert.equal(component.length, 1);
          const run = await createPayRun({
            orgId: f.orgId,
            actorId: f.actorId,
            payScheduleId: f.scheduleId,
            periodStart: "2026-04-26",
            periodEnd: "2026-05-09",
            payDate: "2026-05-13",
          });
          await mutatePayRunAdjustment({
            orgId: f.orgId,
            actorId: f.actorId,
            documentId: run.documentId,
            reason: "Original final wage instruction",
            mutation: {
              action: "add",
              employeePartyId: f.employeeId,
              componentId: component[0]!.id,
              amount: "100",
              hours: "1",
              replaceComponent: true,
              ...(dated ? { earnedFrom: "2026-05-08", earnedTo: "2026-05-08" } : {}),
            },
          });
          assert.deepEqual(
            (
              await calculatePayRun({
                orgId: f.orgId,
                actorId: f.actorId,
                documentId: run.documentId,
              })
            ).errors,
            [],
          );
          await commitPayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId });
          const sourceDocumentIds = [run.documentId];
          if (dated) {
            const supplemental = await createPayRun({
              orgId: f.orgId,
              actorId: f.actorId,
              payScheduleId: f.scheduleId,
              runType: "supplemental",
              periodStart: "2026-04-26",
              periodEnd: "2026-05-09",
              payDate: "2026-05-14",
            });
            await mutatePayRunAdjustment({
              orgId: f.orgId,
              actorId: f.actorId,
              documentId: supplemental.documentId,
              reason: "Additional dated final wage",
              mutation: {
                action: "add",
                employeePartyId: f.employeeId,
                componentId: component[0]!.id,
                amount: "25",
                hours: "0.25",
                replaceComponent: true,
                earnedFrom: "2026-05-08",
                earnedTo: "2026-05-08",
              },
            });
            assert.deepEqual(
              (
                await calculatePayRun({
                  orgId: f.orgId,
                  actorId: f.actorId,
                  documentId: supplemental.documentId,
                })
              ).errors,
              [],
            );
            await commitPayRun({
              orgId: f.orgId,
              actorId: f.actorId,
              documentId: supplemental.documentId,
            });
            sourceDocumentIds.push(supplemental.documentId);
          }
          const before = await db.execute(
            sql`select to_jsonb(stub) as snapshot from pay_stubs stub
    where org_id=${f.orgId} and pay_run_document_id in (${sql.join(
      sourceDocumentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) order by id`,
            "objects",
          );
          const retained = await db.execute<{ earnedFrom: string | null; earnedTo: string | null }>(
            sql`
    select line.earned_from::text as "earnedFrom",line.earned_to::text as "earnedTo"
      from pay_stub_lines line join pay_stubs stub on stub.org_id=line.org_id and stub.id=line.stub_id
     where stub.org_id=${f.orgId} and stub.pay_run_document_id=${run.documentId}
       and line.component_id=${component[0]!.id} and line.kind='earning' and line.amount=100`,
            "objects",
          );
          assert.deepEqual(retained, [
            { earnedFrom: dated ? "2026-05-08" : null, earnedTo: dated ? "2026-05-08" : null },
          ]);
          if (dated) {
            const record = await roeRecord(f.orgId, f.employeeId);
            assert.ok(record);
            assert.equal(record.lastDayPaid, "2026-05-08");
            assert.equal(record.finalPayPeriodEnd, "2026-05-09");
            assert.equal(record.periods.length, 1);
            assert.equal(record.totalInsurableEarnings, "125.0000");
            assert.equal(record.totalInsurableHours, "1.2500");
            await saveRoeSeparationFacts({
              ...scope,
              ...declaration,
              firstDayWorked: "2026-05-07",
              status: "confirmed",
              lastInsurableEarningsOn: "2026-05-07",
              expectedId: confirmed.id,
              expectedUpdatedAt: confirmed.updatedAt,
            });
            await assert.rejects(
              roeRecord(f.orgId, f.employeeId),
              /earning evidence after the confirmed insurable or continuance cutoff/,
            );
          } else {
            await assert.rejects(
              roeRecord(f.orgId, f.employeeId),
              /earning evidence after the confirmed insurable or continuance cutoff/,
            );
          }
          assert.deepEqual(
            await db.execute(
              sql`select to_jsonb(stub) as snapshot from pay_stubs stub
    where org_id=${f.orgId} and pay_run_document_id in (${sql.join(
      sourceDocumentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) order by id`,
              "objects",
            ),
            before,
            "ROE preview and refusal preserve committed payroll",
          );
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      }
    },
  );
}

test(
  "native separation facts preserve source and audit, confirm explicitly and refuse stale edits",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const scope = {
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          employmentId: f.employmentId,
          subsidiaryId: f.subsidiaryId,
          allowedSubsidiaryIds: null,
        };
        assert.equal(await readRoeSeparationFacts(scope), null);
        const hireBefore = (
          await db.execute<{ hired_on: string | null }>(
            sql`select hired_on::text from employee_roles where org_id=${f.orgId} and party_id=${f.employeeId}`,
            "objects",
          )
        )[0]!;
        const draft = await saveRoeSeparationFacts({ ...scope, ...declaration });
        assert.equal(draft.status, "draft");
        assert.equal(draft.firstDayWorked, "2009-03-16");
        assert.equal(draft.employmentId, f.employmentId);
        assert.equal(draft.subsidiaryId, f.subsidiaryId);
        assert.equal(draft.lastInsurableEarningsOn, "2026-05-08");
        assert.equal(draft.sourceReference, declaration.sourceReference);
        assert.deepEqual(await readRoeSeparationFacts(scope), draft);
        assert.deepEqual(
          (
            await db.execute(
              sql`select hired_on::text from employee_roles where org_id=${f.orgId} and party_id=${f.employeeId}`,
              "objects",
            )
          )[0],
          hireBefore,
          "declared first worked does not rewrite hire history",
        );
        const confirmed = await saveRoeSeparationFacts({
          ...scope,
          ...declaration,
          status: "confirmed",
          expectedId: draft.id,
          expectedUpdatedAt: draft.updatedAt,
        });
        assert.equal(confirmed.id, draft.id);
        assert.equal(confirmed.status, "confirmed");
        assert.notEqual(confirmed.updatedAt, draft.updatedAt);
        const audit = await db.execute<{ actor_id: string; changes: Record<string, unknown> }>(
          sql`select actor_id,changes from audit_log
   where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and row_id=${draft.id} order by at,id`,
          "objects",
        );
        assert.equal(audit.length, 2);
        assert.ok(audit.every((a) => a.actor_id === f.actorId));
        assert.equal(audit[1]!.changes.sourceReference, declaration.sourceReference);
        const retried = await saveRoeSeparationFacts({
          ...scope,
          ...declaration,
          status: "confirmed",
          expectedId: confirmed.id,
          expectedUpdatedAt: confirmed.updatedAt,
        });
        assert.deepEqual(retried, confirmed);
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int n from audit_log where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and row_id=${draft.id}`,
              "objects",
            )
          )[0]!.n,
          2,
        );
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            interruptionOn: "2026-05-10",
            expectedId: draft.id,
            expectedUpdatedAt: draft.updatedAt,
          }),
          /Separation facts changed/,
        );
        assert.deepEqual(await readRoeSeparationFacts(scope), confirmed);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "a new separation event is proposed from the employment and committed payroll, and nothing is stored until saved",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const scope = {
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          employmentId: f.employmentId,
          subsidiaryId: f.subsidiaryId,
          allowedSubsidiaryIds: null,
        };
        const terminated = await db.execute(
          sql`update employee_roles set terminated_on='2026-05-06'
   where org_id=${f.orgId} and party_id=${f.employeeId} returning party_id`,
          "objects",
        );
        assert.equal(terminated.length, 1);
        const run = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          periodStart: "2026-04-26",
          periodEnd: "2026-05-09",
          payDate: "2026-05-13",
        });
        assert.deepEqual(
          (
            await calculatePayRun({
              orgId: f.orgId,
              actorId: f.actorId,
              documentId: run.documentId,
            })
          ).errors,
          [],
        );
        await commitPayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId });
        const context = await readRoeSeparationFactsContext(scope);
        assert.equal(context.record, null);
        assert.ok(context.proposal);
        const serviceStart = (
          await db.execute<{ start: string | null }>(
            sql`select coalesce(employment.service_start,role.hired_on)::text as start
   from worker_employments employment join employee_roles role on role.org_id=employment.org_id and role.party_id=employment.worker_party_id
   where employment.org_id=${f.orgId} and employment.id=${f.employmentId}`,
            "objects",
          )
        )[0]!.start;
        assert.equal(context.proposal.firstDayWorked, serviceStart);
        // Terminated inside the final period: the last insurable day is the termination, never the period end.
        assert.equal(context.proposal.interruptionOn, "2026-05-06");
        assert.equal(context.proposal.lastInsurableEarningsOn, "2026-05-06");
        assert.match(
          context.proposal.sourceReference,
          /termination 2026-05-06; committed pay stubs through the period ending 2026-05-09/,
        );
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int n from payroll_roe_separation_events where org_id=${f.orgId}`,
              "objects",
            )
          )[0]!.n,
          0,
          "a proposal is never stored",
        );
        const saved = await saveRoeSeparationFacts({
          ...scope,
          firstDayWorked: context.proposal.firstDayWorked,
          interruptionOn: context.proposal.interruptionOn!,
          lastInsurableEarningsOn: context.proposal.lastInsurableEarningsOn!,
          salaryContinuanceEndOn: null,
          sourceReference: context.proposal.sourceReference,
          reason: "Recorded from the employment and payroll records",
          status: "confirmed",
          expectedId: null,
          expectedUpdatedAt: null,
        });
        const after = await readRoeSeparationFactsContext(scope);
        assert.equal(after.record?.id, saved.id);
        assert.equal(after.proposal, null, "a recorded event is read back, not re-proposed");
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "native separation facts refuse impossible dates and out-of-scope identities without writing",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup),
      other = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const scope = {
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          employmentId: f.employmentId,
          subsidiaryId: f.subsidiaryId,
          allowedSubsidiaryIds: null,
        };
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            status: "confirmed",
            firstDayWorked: null,
          }),
          /first day worked/,
        );
        await assert.rejects(
          saveRoeSeparationFacts({ ...scope, ...declaration, employmentId: other.employmentId }),
          /Choose one Canadian employee with a native legal employer in your payroll scope/,
        );
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            lastInsurableEarningsOn: "2026-05-10",
          }),
          /precede or equal/,
        );
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            salaryContinuanceEndOn: "2026-05-07",
          }),
          /precede or equal/,
        );
        await assert.rejects(
          saveRoeSeparationFacts({ ...scope, ...declaration, employeePartyId: other.employeeId }),
          /Canadian employee/,
        );
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            allowedSubsidiaryIds: new Set<string>(),
          }),
          /Canadian employee/,
        );
        assert.equal(await readRoeSeparationFacts(scope), null);
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int n from payroll_roe_separation_events where org_id=${f.orgId}`,
              "objects",
            )
          )[0]!.n,
          0,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      await withBypassContext(() => dropScratchOrgReporting(other.orgId));
    }
  },
);

test(
  "issued separation facts remain immutable through the native authoring command",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const scope = {
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          employmentId: f.employmentId,
          subsidiaryId: f.subsidiaryId,
          allowedSubsidiaryIds: null,
        };
        const filingAccountId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
    values(${filingAccountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001','Original employer payroll account',true) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${filingAccountId},
    sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })},sin_last3='286'
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update orgs set settings=jsonb_set(settings,'{payroll,t4Transmitter}',
    ${JSON.stringify({ bn: "123456789RP0001", name: "Fixture employer", contactName: "Pat Payroll", contactPhone: "5555550100" })}::jsonb)
    where id=${f.orgId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedRoeIssuanceFixture(f.orgId, f.employeeId);
        const original = await readRoeSeparationFacts(scope);
        assert.ok(original);
        const saved = await saveRoeSeparationFacts({
          ...scope,
          ...declaration,
          firstDayWorked: "2026-05-07",
          status: "confirmed",
          expectedId: original.id,
          expectedUpdatedAt: original.updatedAt,
        });
        const component = await db.execute<{ id: string }>(
          sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
          "objects",
        );
        assert.equal(component.length, 1);
        const run = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          periodStart: "2026-04-26",
          periodEnd: "2026-05-09",
          payDate: "2026-05-13",
        });
        await mutatePayRunAdjustment({
          orgId: f.orgId,
          actorId: f.actorId,
          documentId: run.documentId,
          reason: "Original final dated wage",
          mutation: {
            action: "add",
            employeePartyId: f.employeeId,
            componentId: component[0]!.id,
            amount: "100",
            hours: "1",
            replaceComponent: true,
            earnedFrom: "2026-05-08",
            earnedTo: "2026-05-08",
          },
        });
        const input = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
        assert.deepEqual((await calculatePayRun(input)).errors, []);
        await commitPayRun(input);
        const filed = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: f.employeeId + ":E" },
        });
        assert.equal(filed.submission.slipCount, 1);
        const beforeArtifact = await db.execute(
          sql`select to_jsonb(s) as snapshot from payroll_filing_submissions s
    where org_id=${f.orgId} and id=${filed.submission.id}`,
          "objects",
        );
        const beforeAudit = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int n from audit_log where org_id=${f.orgId}
    and table_name='payroll_roe_separation_events' and row_id=${saved.id}`,
            "objects",
          )
        )[0]!.n;
        const issued = await readRoeSeparationFacts(scope);
        assert.equal(issued!.status, "issued");
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            expectedId: issued!.id,
            expectedUpdatedAt: issued!.updatedAt,
          }),
          /This issued ROE event retains its source facts — preserve them and use the Service Canada correction workflow/,
        );
        assert.deepEqual(await readRoeSeparationFacts(scope), issued);
        await assert.rejects(
          db.execute(
            sql`update payroll_roe_separation_events set first_day_worked='2009-03-17' where org_id=${f.orgId} and id=${saved.id}`,
          ),
          (error) =>
            errorChainMatches(error, /Issued Record of Employment separation facts are immutable/),
        );
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int n from audit_log where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and row_id=${saved.id}`,
              "objects",
            )
          )[0]!.n,
          beforeAudit,
        );
        assert.deepEqual(
          await db.execute(
            sql`select to_jsonb(s) as snapshot from payroll_filing_submissions s where org_id=${f.orgId} and id=${filed.submission.id}`,
            "objects",
          ),
          beforeArtifact,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "native ROE issuance freezes only selected employee facts alongside the retained artifact",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const unselected = await seedHiredEmployee(f.orgId, f.actorId, {
          scheduleId: f.scheduleId,
          subsidiaryId: f.subsidiaryId,
          partySubsidiaryId: f.subsidiaryId,
          name: "Unselected employee",
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          currency: "CAD",
          rate: "30",
          rateBasis: "hour",
          hiredOn: "2026-05-07",
          federalClaimCode: 1,
          provincialClaimCode: 1,
          wcbExempt: true,
          wcbExemptReason: "Declared fixture coverage exclusion",
        });
        const filingAccountId = randomUUID();
        const account = await db.execute(
          sql`insert into payroll_filing_accounts
   (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
   values (${filingAccountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001',
    'Canadian payroll account','regular',true,true,${f.actorId},${f.actorId}) returning id`,
          "objects",
        );
        assert.equal(account.length, 1);
        const profiles = await db.execute(
          sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
   where org_id=${f.orgId} and employee_party_id in (${f.employeeId},${unselected.employeeId}) returning employee_party_id`,
          "objects",
        );
        assert.equal(profiles.length, 2);
        const identity = await db.execute(
          sql`update employee_payroll_profiles
   set sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })},sin_last3='286'
   where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
          "objects",
        );
        assert.equal(identity.length, 1);
        const config = await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{payroll,t4Transmitter}',
   ${JSON.stringify({ bn: "123456789RP0001", name: "Fixture employer", contactName: "Pat Payroll", contactPhone: "5555550100" })}::jsonb)
   where id=${f.orgId} returning id`,
          "objects",
        );
        assert.equal(config.length, 1);
        await seedRoeIssuanceFixture(f.orgId, f.employeeId);
        const scope = {
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          employmentId: f.employmentId,
          subsidiaryId: f.subsidiaryId,
          allowedSubsidiaryIds: null,
        };
        const original = await readRoeSeparationFacts(scope);
        assert.ok(original);
        await saveRoeSeparationFacts({
          ...scope,
          ...declaration,
          firstDayWorked: "2026-05-07",
          interruptionOn: "2026-05-10",
          lastInsurableEarningsOn: "2026-05-09",
          status: "confirmed",
          expectedId: original.id,
          expectedUpdatedAt: original.updatedAt,
        });
        for (const employeeId of [f.employeeId, unselected.employeeId])
          for (const day of ["2026-05-07", "2026-05-08", "2026-05-09"])
            await db.execute(sql`insert into time_entries
   (org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
   values (${f.orgId},${employeeId},${day},8,'approved',false,'unbilled','actual',${f.actorId},${f.actorId})`);
        const terminations = await db.execute(
          sql`update employee_roles set terminated_on='2026-05-10'
   where org_id=${f.orgId} and party_id in (${f.employeeId},${unselected.employeeId}) returning party_id`,
          "objects",
        );
        assert.equal(terminations.length, 2);
        const run = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          periodStart: "2026-04-26",
          periodEnd: "2026-05-09",
          payDate: "2026-05-09",
        });
        assert.deepEqual(
          (
            await calculatePayRun({
              orgId: f.orgId,
              actorId: f.actorId,
              documentId: run.documentId,
            })
          ).errors,
          [],
        );
        await commitPayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId });
        const filed = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: f.employeeId + ":E" },
          note: "Employer confirmed source and original ROE filing",
        });
        assert.equal(filed.submission.slipCount, 1);
        assert.equal(
          await readRoeSeparationFacts({
            ...scope,
            employeePartyId: unselected.employeeId,
            employmentId: unselected.employmentId,
          }),
          null,
        );
        const retainedRows = await db.execute<{ row_id: string }>(
          sql`select row_id from payroll_filing_submission_slips
   where org_id=${f.orgId} and submission_id=${filed.submission.id}`,
          "objects",
        );
        assert.deepEqual(
          retainedRows.map((row) => row.row_id),
          [f.employeeId + "~" + original.id],
        );
        const issued = await readRoeSeparationFacts(scope);
        assert.equal(issued!.status, "issued");
        assert.equal(issued!.firstDayWorked, "2026-05-07");
        assert.equal(issued!.id, original.id);
        const before = await db.execute(
          sql`select to_jsonb(s) as snapshot from payroll_filing_submissions s where org_id=${f.orgId} and id=${filed.submission.id}`,
          "objects",
        );
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope,
            ...declaration,
            expectedId: issued!.id,
            expectedUpdatedAt: issued!.updatedAt,
          }),
          /This issued ROE event retains its source facts — preserve them and use the Service Canada correction workflow/,
        );
        assert.deepEqual(
          await db.execute(
            sql`select to_jsonb(s) as snapshot from payroll_filing_submissions s where org_id=${f.orgId} and id=${filed.submission.id}`,
            "objects",
          ),
          before,
        );
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int n from audit_log where org_id=${f.orgId} and table_name='payroll_roe_separation_events'
    and row_id=${original.id} and changes->>'event'='roe_source_issued' and changes->>'submissionId'=${filed.submission.id}`,
              "objects",
            )
          )[0]!.n,
          1,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
