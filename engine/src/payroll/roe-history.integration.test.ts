import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import { seedAdoption, seedRoeIssuanceFixture } from "./filing-test-fixtures.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { seedComponent } from "../testing/hrm-harness.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import {
  importRoePriorPeriod,
  qualifyRoeLine,
  withdrawRoeLineEvidence,
  readRoeHistoricalEvidence,
  applyRoeReportingImport,
  type RoePriorPeriodInput,
  type RoeReportingSource,
} from "./roe-history.ts";
import { readRoeSeparationFacts, saveRoeSeparationFacts } from "./roe-separation-facts.ts";
import { readRoeReportingWindow, roeWindowContext } from "./roe-reporting-window.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { recordFilingIssue } from "./yearend-amendments.ts";
import { roeRecord } from "./yearend.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
async function setup() {
  const f = await seedAdoption({ hiredOn: "1998-08-25" });
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  const filingAccountId = randomUUID();
  const account = await db.execute(
    sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
    values(${filingAccountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001','Employer payroll account','regular',true,true,${f.actorId},${f.actorId}) returning id`,
    "objects",
  );
  assert.equal(account.length, 1);
  const profile = await db.execute(
    sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
    "objects",
  );
  assert.equal(profile.length, 1);
  return { ...f, filingAccountId };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const scope = (f: Fixture) => ({
  orgId: f.orgId,
  actorId: f.actorId,
  employeePartyId: f.employeeId,
  employmentId: f.employmentId,
  subsidiaryId: f.subsidiaryId,
  allowedSubsidiaryIds: null,
});
async function originalSource(f: Fixture, packet: unknown): Promise<RoeReportingSource> {
  const bytes = Buffer.from(JSON.stringify(packet)),
    sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const folder = randomUUID(),
    file = randomUUID(),
    version = randomUUID();
  const folders = await db.execute(
    sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folder},${f.orgId},'Original payroll reporting source',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
    "objects",
  );
  assert.equal(folders.length, 1);
  const files = await db.execute(
    sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${file},${f.orgId},${folder},'original-report.json','application/json',${bytes.length},${f.actorId},${f.actorId}) returning id`,
    "objects",
  );
  assert.equal(files.length, 1);
  const versions = await db.execute(
    sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${version},${file},1,${bytes.length},'application/json',${sourceSha256},${f.actorId}) returning id`,
    "objects",
  );
  assert.equal(versions.length, 1);
  const blobs = await db.execute(
    sql`insert into file_blobs(version_id,bytes) values(${version},${bytes}) returning id`,
    "objects",
  );
  assert.equal(blobs.length, 1);
  const current = await db.execute(
    sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file} returning id`,
    "objects",
  );
  assert.equal(current.length, 1);
  return {
    sourceFileId: file,
    sourceVersionId: version,
    sourceSha256,
    sourceReference: "Original employer reporting record, employee and period identified",
    insuranceReference: "Original employer insurable earning classification",
    hoursReference: "Original recorded insurable paid hours",
    reason: "Retain the original qualified reporting evidence",
  };
}
function prior(
  f: Fixture,
  ref: RoeReportingSource,
  changes: Partial<RoePriorPeriodInput> = {},
): RoePriorPeriodInput {
  return {
    ...ref,
    filingAccountId: f.filingAccountId,
    payScheduleId: f.scheduleId,
    frequency: "biweekly",
    periodStart: "2026-03-29",
    periodEnd: "2026-04-11",
    payDate: "2026-04-15",
    earnedFrom: "2026-03-30",
    earnedTo: "2026-04-03",
    insurableEarnings: "80",
    insurableHours: "4",
    nilPeriod: false,
    expectedId: null,
    expectedUpdatedAt: null,
    ...changes,
  };
}
async function finalRun(f: Fixture, mixed = false) {
  const separation = await db.execute(
    sql`update employee_roles set terminated_on='2026-05-09'
    where org_id=${f.orgId} and party_id=${f.employeeId} returning party_id`,
    "objects",
  );
  assert.equal(separation.length, 1);
  await seedRoeIssuanceFixture(f.orgId, f.employeeId);
  const current = await readRoeSeparationFacts(scope(f));
  assert.ok(current);
  await saveRoeSeparationFacts({
    ...scope(f),
    firstDayWorked: "2026-03-30",
    interruptionOn: "2026-05-09",
    lastInsurableEarningsOn: "2026-05-08",
    salaryContinuanceEndOn: null,
    sourceReference: "Original employment-spell and final worked date",
    reason: "Confirm the original interruption facts",
    status: "confirmed",
    expectedId: current.id,
    expectedUpdatedAt: current.updatedAt,
  });
  const base = await db.execute<{ id: string }>(
    sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
    "objects",
  );
  assert.equal(base.length, 1);
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
      componentId: base[0]!.id,
      amount: "100",
      hours: "1",
      replaceComponent: true,
      earnedFrom: "2026-05-08",
      earnedTo: "2026-05-08",
    },
  });
  let uninsured: string | null = null;
  if (mixed) {
    uninsured = await seedComponent(f.orgId, {
      code: "REIMBURSEMENT",
      kind: "earning",
      name: "Expense reimbursement",
    });
    const changed = await db.execute(
      sql`update pay_components set taxable=false,pensionable=false,insurable=false
      where org_id=${f.orgId} and id=${uninsured} returning id`,
      "objects",
    );
    assert.equal(changed.length, 1);
    await db.execute(
      sql`update pay_component_statutory_treatments set vacationable=false where org_id=${f.orgId} and pay_component_id=${uninsured}`,
    );
    await db.execute(sql`insert into payroll_roe_component_classifications(org_id,pay_component_id,effective_from,block,change_reason)
      values(${f.orgId},${uninsured},'2020-01-01','none','Original reimbursement classification')`);
    await mutatePayRunAdjustment({
      orgId: f.orgId,
      actorId: f.actorId,
      documentId: run.documentId,
      reason: "Original non-insurable reimbursement",
      mutation: {
        action: "add",
        employeePartyId: f.employeeId,
        componentId: uninsured,
        amount: "10",
        replaceComponent: true,
        earnedFrom: "2026-05-08",
        earnedTo: "2026-05-08",
      },
    });
  }
  assert.deepEqual(
    (await calculatePayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId }))
      .errors,
    [],
  );
  await commitPayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId });
  return { run, base: base[0]!.id, uninsured };
}
async function financialSnapshot(f: Fixture) {
  const stubs = await db.execute(
    sql`select to_jsonb(s) as snapshot from pay_stubs s where org_id=${f.orgId} order by s.id`,
    "objects",
  );
  const runs = await db.execute(
    sql`select to_jsonb(r) as snapshot from pay_runs r where org_id=${f.orgId} order by r.document_id`,
    "objects",
  );
  const journals = await db.execute(
    sql`select to_jsonb(j) as snapshot from journal_entries j where org_id=${f.orgId} order by j.id`,
    "objects",
  );
  return { stubs, runs, journals };
}

test(
  "qualified prior and nil reporting periods extend the ROE window without creating payroll or changing committed facts",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        await finalRun(f);
        const before = await financialSnapshot(f);
        const ref = await originalSource(f, {
          employee: f.employeeId,
          period: "2026-03-29/2026-04-11",
          insurableEarnings: "80",
          insurableHours: "4",
        });
        assert.deepEqual(
          await applyRoeReportingImport(
            scope(f),
            { kind: "period", evidence: prior(f, ref) },
            true,
          ),
          { action: "insert" },
        );
        assert.equal(
          (await readRoeHistoricalEvidence(scope(f))).periods.length,
          0,
          "preview retains no provisional period",
        );
        const previewAudit = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_log
      where org_id=${f.orgId} and table_name='payroll_roe_historical_periods'`,
          "objects",
        );
        assert.equal(
          previewAudit[0]!.n,
          0,
          "preview rolls back its native audit together with the reporting facts",
        );
        const imported = await importRoePriorPeriod(scope(f), prior(f, ref));
        assert.deepEqual(
          await importRoePriorPeriod(scope(f), prior(f, ref)),
          imported,
          "exact import replay retains the same identity and version",
        );
        const nilRef = await originalSource(f, {
          employee: f.employeeId,
          period: "2026-04-12/2026-04-25",
          nil: true,
        });
        await importRoePriorPeriod(
          scope(f),
          prior(f, nilRef, {
            periodStart: "2026-04-12",
            periodEnd: "2026-04-25",
            nilPeriod: true,
            payDate: null,
            earnedFrom: null,
            earnedTo: null,
            insurableEarnings: "0",
            insurableHours: "0",
          }),
        );
        const window = await readRoeReportingWindow(await roeWindowContext(f.orgId, f.employeeId));
        assert.equal(window.periods.length, 3);
        assert.equal(window.periods[1]!.payDate, null);
        assert.equal(window.periods[1]!.insurableEarnings, "0.0000");
        assert.equal(window.totalInsurableEarnings, "180.0000");
        assert.equal(window.totalInsurableHours, "5.0000");
        assert.equal(window.historicalPeriods.length, 2);
        assert.equal(window.sourceDocuments.length, 1);
        assert.deepEqual(await financialSnapshot(f), before);
        const audits = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_log
      where org_id=${f.orgId} and table_name='payroll_roe_historical_periods'`,
          "objects",
        );
        assert.equal(audits[0]!.n, 2);
        const correctedRef = await originalSource(f, {
          employee: f.employeeId,
          period: "2026-03-29/2026-04-11",
          insurableEarnings: "95",
          insurableHours: "4",
        });
        const corrected = await importRoePriorPeriod(
          scope(f),
          prior(f, correctedRef, {
            insurableEarnings: "95",
            expectedId: imported.id,
            expectedUpdatedAt: imported.updatedAt,
          }),
        );
        assert.equal(corrected.id, imported.id);
        assert.equal(corrected.insurableEarnings, "95.0000");
        await assert.rejects(
          importRoePriorPeriod(
            scope(f),
            prior(f, ref, {
              insurableEarnings: "90",
              expectedId: imported.id,
              expectedUpdatedAt: imported.updatedAt,
            }),
          ),
          /changed.*reload/,
        );
        assert.equal(
          (
            await readRoeHistoricalEvidence(scope(f), {
              periodFrom: "2026-04-12",
              periodTo: "2026-04-25",
            })
          ).periods.length,
          1,
        );
        await assert.rejects(
          readRoeHistoricalEvidence(scope(f), { periodFrom: "2026-02-30", periodTo: "2026-05-09" }),
          /calendar dates/,
        );
        assert.deepEqual(
          await financialSnapshot(f),
          before,
          "historical reporting edits never replace committed payroll",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
test(
  "historical imports refuse native overlap, foreign source identity, source-hash mismatch and out-of-scope employers",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup),
      other = await withBypassContext(setup);
    try {
      const foreignRef = await withOrgContext(other.orgId, () =>
        originalSource(other, { employee: other.employeeId, original: true }),
      );
      await withOrgContext(f.orgId, async () => {
        await finalRun(f);
        const ref = await originalSource(f, { employee: f.employeeId, original: true });
        const before = await financialSnapshot(f);
        await assert.rejects(
          importRoePriorPeriod(
            scope(f),
            prior(f, ref, {
              periodStart: "2026-04-26",
              periodEnd: "2026-05-09",
              earnedFrom: "2026-05-08",
              earnedTo: "2026-05-08",
            }),
          ),
          (error) =>
            errorChainMatches(error, /cannot replace or duplicate retained committed payroll/),
        );
        await assert.rejects(
          importRoePriorPeriod(scope(f), prior(f, foreignRef)),
          /exact retained version and hash/,
        );
        await assert.rejects(
          importRoePriorPeriod(scope(f), prior(f, { ...ref, sourceSha256: "f".repeat(64) })),
          /exact retained version and hash/,
        );
        await assert.rejects(
          importRoePriorPeriod({ ...scope(f), subsidiaryId: other.subsidiaryId }, prior(f, ref)),
          /Choose one Canadian employee with a native legal employer in your payroll scope/,
        );
        await assert.rejects(
          importRoePriorPeriod(
            { ...scope(f), allowedSubsidiaryIds: new Set<string>() },
            prior(f, ref),
          ),
          /payroll scope|native legal employer/,
        );
        await assert.rejects(
          importRoePriorPeriod(scope(f), prior(f, ref, { filingAccountId: other.filingAccountId })),
          (error) => errorChainMatches(error, /native Canadian payroll filing account/),
        );
        const accepted = await importRoePriorPeriod(scope(f), prior(f, ref));
        await assert.rejects(
          importRoePriorPeriod(
            scope(f),
            prior(f, ref, { periodStart: "2026-04-05", periodEnd: "2026-04-18" }),
          ),
          (error) => errorChainMatches(error, /cannot overlap/),
        );
        assert.equal((await readRoeHistoricalEvidence(scope(f))).periods[0]!.id, accepted.id);
        assert.deepEqual(await financialSnapshot(f), before);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      await withBypassContext(() => dropScratchOrgReporting(other.orgId));
    }
  },
);
test(
  "mixed earning lines require complete insurance evidence and issued ROEs freeze its exact source audit",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { run, base, uninsured } = await finalRun(f, true);
        const before = await financialSnapshot(f);
        const ref = await originalSource(f, {
          employee: f.employeeId,
          wages: { amount: "100", hours: "1", insurable: true },
          reimbursement: { amount: "10", insurable: false },
          prior: { period: "2026-03-29/2026-04-11", insurableEarnings: "80", insurableHours: "4" },
          nil: { period: "2026-04-12/2026-04-25" },
        });
        await importRoePriorPeriod(scope(f), prior(f, ref));
        await importRoePriorPeriod(
          scope(f),
          prior(f, ref, {
            periodStart: "2026-04-12",
            periodEnd: "2026-04-25",
            nilPeriod: true,
            payDate: null,
            earnedFrom: null,
            earnedTo: null,
            insurableEarnings: "0",
            insurableHours: "0",
          }),
        );
        const lines = await db.execute<{ id: string; componentId: string }>(
          sql`select l.id,l.component_id as "componentId" from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where l.org_id=${f.orgId} and s.pay_run_document_id=${run.documentId} and l.kind='earning' and l.amount<>0 order by l.id`,
          "objects",
        );
        const wage = lines.find((line) => line.componentId === base),
          reimbursement = lines.find((line) => line.componentId === uninsured);
        assert.ok(wage);
        assert.ok(reimbursement);
        const evidence = {
          ...ref,
          reportPeriodStart: "2026-04-26",
          reportPeriodEnd: "2026-05-09",
          earnedFrom: "2026-05-08",
          earnedTo: "2026-05-08",
          expectedId: null,
          expectedUpdatedAt: null,
        };
        let insured = await qualifyRoeLine(scope(f), {
          ...evidence,
          payStubLineId: wage.id,
          isInsurable: true,
          insurableHours: "1",
        });
        await assert.rejects(
          readRoeReportingWindow(await roeWindowContext(f.orgId, f.employeeId)),
          /attribution is incomplete/,
        );
        assert.deepEqual(
          await applyRoeReportingImport(
            scope(f),
            {
              kind: "line",
              evidence: {
                ...evidence,
                payStubLineId: reimbursement.id,
                isInsurable: false,
                insurableHours: "0",
              },
            },
            true,
          ),
          { action: "insert" },
        );
        assert.equal(
          (await readRoeHistoricalEvidence(scope(f))).lines.length,
          1,
          "line preview retains only the previously qualified wage",
        );
        const unqualified = await qualifyRoeLine(scope(f), {
          ...evidence,
          payStubLineId: reimbursement.id,
          isInsurable: false,
          insurableHours: "0",
        });

        const retainedBeforeUpdate = await financialSnapshot(f);
        const corrected = await qualifyRoeLine(scope(f), {
          ...evidence,
          payStubLineId: wage.id,
          isInsurable: true,
          insurableHours: "1",
          reason: "Clarify the original paid-hours source reference",
          expectedId: insured.id,
          expectedUpdatedAt: insured.updatedAt,
        });
        assert.equal(corrected.id, insured.id);
        assert.notEqual(corrected.updatedAt, insured.updatedAt);
        assert.deepEqual(
          corrected.lineSnapshot,
          insured.lineSnapshot,
          "source-only clarification preserves every retained payroll fact",
        );
        insured = corrected;
        assert.deepEqual(
          await financialSnapshot(f),
          retainedBeforeUpdate,
          "ordinary evidence INSERT/UPDATE cannot mutate committed payroll",
        );
        const window = await readRoeReportingWindow(await roeWindowContext(f.orgId, f.employeeId));
        assert.equal(window.totalInsurableEarnings, "180.0000");
        assert.equal(window.totalInsurableHours, "5.0000");
        await assert.rejects(
          qualifyRoeLine(scope(f), {
            ...evidence,
            payStubLineId: wage.id,
            isInsurable: true,
            insurableHours: "2",
            expectedId: insured.id,
            expectedUpdatedAt: insured.updatedAt,
          }),
          /retained paid-hour source/,
        );
        const profile = await db.execute(
          sql`update employee_payroll_profiles set sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })},sin_last3='286'
      where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
          "objects",
        );
        assert.equal(profile.length, 1);
        const config = await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{payroll,t4Transmitter}',
      ${JSON.stringify({ bn: "123456789RP0001", name: "Fixture employer", contactName: "Pat Payroll", contactPhone: "5555550100" })}::jsonb) where id=${f.orgId} returning id`,
          "objects",
        );
        assert.equal(config.length, 1);
        const issued = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: f.employeeId + ":E" },
          note: "Original source-qualified reporting evidence",
        });
        assert.equal(issued.submission.slipCount, 1);
        const audit = await db.execute<{
          changes: {
            reportingEvidence: {
              historicalPeriods: { id: string }[];
              lineEvidence: { id: string }[];
            };
          };
        }>(
          sql`select changes from audit_log
      where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and changes->>'event'='roe_source_issued'`,
          "objects",
        );
        assert.equal(audit.length, 1);
        assert.equal(audit[0]!.changes.reportingEvidence.historicalPeriods.length, 2);
        assert.deepEqual(
          audit[0]!.changes.reportingEvidence.lineEvidence.map((line) => line.id).sort(),
          [insured.id, unqualified.id].sort(),
        );
        await assert.rejects(
          qualifyRoeLine(scope(f), {
            ...evidence,
            payStubLineId: reimbursement.id,
            isInsurable: false,
            insurableHours: "0",
            reason: "Replace the issued source reference",
            expectedId: unqualified.id,
            expectedUpdatedAt: unqualified.updatedAt,
          }),
          (error) =>
            errorChainMatches(
              error,
              /Issued ROE reporting evidence must be retained; its used source cannot be changed/,
            ),
        );
        await assert.rejects(
          db.execute(
            sql`delete from payroll_roe_historical_periods where org_id=${f.orgId} and employee_party_id=${f.employeeId}`,
          ),
          (error) =>
            errorChainMatches(
              error,
              /Issued ROE reporting evidence must be retained; its used source cannot be changed/,
            ),
        );
        await assert.rejects(
          db.execute(
            sql`delete from payroll_roe_line_evidence where org_id=${f.orgId} and id=${insured.id}`,
          ),
          (error) =>
            errorChainMatches(
              error,
              /Issued ROE reporting evidence must be retained; its used source cannot be changed/,
            ),
        );
        assert.deepEqual(
          await financialSnapshot(f),
          before,
          "ROE source import and issuance preserve native paid payroll and its journal history",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "source-qualified separation cash reports once in the final period with true dates and immutable issued evidence",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        await finalRun(f);
        const event = await readRoeSeparationFacts(scope(f));
        assert.ok(event);
        const ref = await originalSource(f, {
          employee: f.employeeId,
          kind: "vacation_paid_on_separation",
          amount: "296",
          payDate: "2026-05-29",
        });
        await importRoePriorPeriod(scope(f), prior(f, ref));
        await importRoePriorPeriod(
          scope(f),
          prior(f, ref, {
            periodStart: "2026-04-12",
            periodEnd: "2026-04-25",
            nilPeriod: true,
            payDate: null,
            earnedFrom: null,
            earnedTo: null,
            insurableEarnings: "0",
            insurableHours: "0",
          }),
        );
        const component = await seedComponent(f.orgId, {
          code: "SEPVAC",
          kind: "earning",
          name: "Vacation cash",
        });
        const changed = await db.execute(
          sql`update pay_components set taxable=true,pensionable=true,insurable=true
      where org_id=${f.orgId} and id=${component} returning id`,
          "objects",
        );
        assert.equal(changed.length, 1);
        await db.execute(
          sql`update pay_component_statutory_treatments set vacationable=false where org_id=${f.orgId} and pay_component_id=${component}`,
        );
        // Ordinary component policy remains independent of this payment's source declaration.
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_roe_component_classifications(org_id,pay_component_id,effective_from,block,category_code,change_reason)
      values(${f.orgId},${component},'2020-01-01','17A','1','Ordinary vacation-with-pay classification') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const late = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          runType: "supplemental",
          employeePartyIds: [f.employeeId],
          periodStart: "2026-04-26",
          periodEnd: "2026-05-09",
          payDate: "2026-05-29",
        });
        await mutatePayRunAdjustment({
          orgId: f.orgId,
          actorId: f.actorId,
          documentId: late.documentId,
          reason: "Original separation vacation cash",
          mutation: {
            action: "add",
            employeePartyId: f.employeeId,
            componentId: component,
            amount: "296",
            hours: "0",
            replaceComponent: true,
            earnedFrom: "2026-04-26",
            earnedTo: "2026-05-09",
          },
        });
        assert.deepEqual(
          (
            await calculatePayRun({
              orgId: f.orgId,
              actorId: f.actorId,
              documentId: late.documentId,
            })
          ).errors,
          [],
        );
        await commitPayRun({ orgId: f.orgId, actorId: f.actorId, documentId: late.documentId });
        const lines = await db.execute<{ id: string; snapshot: Record<string, unknown> }>(
          sql`select l.id,public.payroll_roe_reporting_line_snapshot(l.id,l.org_id) as snapshot
      from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id where l.org_id=${f.orgId}
        and s.pay_run_document_id=${late.documentId} and l.component_id=${component} and l.amount<>0`,
          "objects",
        );
        assert.equal(lines.length, 1);
        const line = lines[0]!;
        const input = {
          ...ref,
          payStubLineId: line.id,
          reportPeriodStart: "2026-04-26",
          reportPeriodEnd: "2026-05-09",
          earnedFrom: "2026-04-26",
          earnedTo: "2026-05-09",
          isInsurable: true,
          insurableHours: "0",
          reportingBasis: "separation_payment" as const,
          separationEventId: event.id,
          separationBlock: "17A" as const,
          separationCategoryCode: "2",
          expectedId: null,
          expectedUpdatedAt: null,
        };
        const before = await financialSnapshot(f);
        await assert.rejects(
          readRoeReportingWindow(await roeWindowContext(f.orgId, f.employeeId, event.id)),
          /after the confirmed/,
        );
        await assert.rejects(
          qualifyRoeLine(scope(f), {
            ...input,
            reportPeriodStart: "2026-05-10",
            reportPeriodEnd: "2026-05-23",
          }),
          /retained final pay period/,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_roe_separation_payments where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
          "a refused allocation rolls back its source-generated declaration and audit",
        );
        await assert.rejects(
          qualifyRoeLine(scope(f), { ...input, earnedTo: "2026-05-08" }),
          /true retained earned dates/,
        );
        await assert.rejects(
          qualifyRoeLine(scope(f), { ...input, separationEventId: randomUUID() }),
          /exact confirmed separation event/,
        );
        let evidence = await qualifyRoeLine(scope(f), input);
        assert.deepEqual(evidence.lineSnapshot, line.snapshot);
        assert.equal(evidence.earnedTo, "2026-05-09");
        assert.equal(evidence.separationBlock, "17A");
        assert.equal(evidence.separationCategoryCode, "2");
        const initialPayment = evidence.separationPaymentId;
        assert.ok(initialPayment);
        assert.equal((await qualifyRoeLine(scope(f), input)).id, evidence.id);
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_roe_separation_payments where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          withdrawRoeLineEvidence(scope(f), {
            expectedId: evidence.id,
            expectedUpdatedAt: "stale",
            reason: "Review changed source",
          }),
          /changed/,
        );
        await withdrawRoeLineEvidence(scope(f), {
          expectedId: evidence.id,
          expectedUpdatedAt: evidence.updatedAt,
          reason: "Withdraw unissued attribution for source review",
        });
        assert.equal((await readRoeHistoricalEvidence(scope(f))).lines.length, 0);
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_roe_separation_payments where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.deepEqual(await financialSnapshot(f), before);
        const declared = await db.execute<{ id: string; snapshot: Record<string, unknown> }>(
          sql`insert into payroll_roe_separation_payments
      (org_id,separation_event_id,pay_component_id,amount,payment_status,expected_payment_on,change_reason,created_by,updated_by)
      values(${f.orgId},${event.id},${component},'296','paid','2026-05-29','Original paid vacation declaration',${f.actorId},${f.actorId})
      returning id,to_jsonb(payroll_roe_separation_payments) as snapshot`,
          "objects",
        );
        assert.equal(declared.length, 1);
        const manual = declared[0]!;
        await assert.rejects(qualifyRoeLine(scope(f), input), /select its exact declaration ID/);
        const selected = { ...input, separationPaymentId: manual.id };
        evidence = await qualifyRoeLine(scope(f), selected);
        const bindingAudit = await db.execute<{ before: Record<string, unknown> }>(
          sql`select changes->'before' as before from audit_log
      where org_id=${f.orgId} and table_name='payroll_roe_separation_payments' and row_id=${manual.id} and action='update'`,
          "objects",
        );
        assert.equal(bindingAudit.length, 1);
        assert.deepEqual(
          bindingAudit[0]!.before,
          manual.snapshot,
          "binding retains the full original native declaration",
        );
        const boundPayment = await db.execute(
          sql`select to_jsonb(p) as snapshot from payroll_roe_separation_payments p where org_id=${f.orgId} and id=${manual.id}`,
          "objects",
        );
        await withdrawRoeLineEvidence(scope(f), {
          expectedId: evidence.id,
          expectedUpdatedAt: evidence.updatedAt,
          reason: "Withdraw attribution while preserving the original paid declaration",
        });
        assert.deepEqual(
          await db.execute(
            sql`select to_jsonb(p) as snapshot from payroll_roe_separation_payments p where org_id=${f.orgId} and id=${manual.id}`,
            "objects",
          ),
          boundPayment,
        );
        evidence = await qualifyRoeLine(scope(f), selected);
        const window = await readRoeReportingWindow(
          await roeWindowContext(f.orgId, f.employeeId, event.id),
        );
        assert.equal(window.totalInsurableEarnings, "476.0000");
        assert.equal(window.totalInsurableHours, "5.0000");
        assert.equal(window.periods[0]!.insurableEarnings, "396.0000");
        const record = await roeRecord(f.orgId, f.employeeId, event.id);
        assert.ok(record);
        assert.equal(record.totalInsurableEarnings, "476.0000");
        assert.equal(record.vacationPayOnSeparation, "296.0000");
        assert.equal(record.separationAmounts.filter((p) => p.block === "17A")[0]!.code, "2");
        assert.equal(
          (
            await db.execute<{ code: string }>(
              sql`select category_code as code from payroll_roe_component_classifications
      where org_id=${f.orgId} and pay_component_id=${component}`,
              "objects",
            )
          )[0]!.code,
          "1",
          "payment source does not rewrite ordinary component policy",
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })},sin_last3='286'
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
        await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: f.employeeId + "~" + event.id + ":E" },
          note: "Original qualified separation cash reporting",
        });
        const issuedBefore = await db.execute(
          sql`select to_jsonb(b) as snapshot from payroll_roe_issued_event_sources b where org_id=${f.orgId}`,
          "objects",
        );
        assert.equal(
          (await roeRecord(f.orgId, f.employeeId, event.id))!.totalInsurableEarnings,
          "476.0000",
          "the confirmed-to-issued transition retains the same proof",
        );
        await assert.rejects(
          withdrawRoeLineEvidence(scope(f), {
            expectedId: evidence.id,
            expectedUpdatedAt: evidence.updatedAt,
            reason: "Try to remove issued source",
          }),
          (error) => errorChainMatches(error, /Issued ROE reporting evidence must be retained/),
        );
        await assert.rejects(
          db.execute(
            sql`update payroll_roe_separation_payments set amount=297 where org_id=${f.orgId} and id=${evidence.separationPaymentId}`,
          ),
          (error) =>
            errorChainMatches(error, /Issued ROE separation payment declarations are immutable/),
        );
        assert.deepEqual(
          await db.execute(
            sql`select to_jsonb(b) as snapshot from payroll_roe_issued_event_sources b where org_id=${f.orgId}`,
            "objects",
          ),
          issuedBefore,
        );
        assert.deepEqual(
          await financialSnapshot(f),
          before,
          "reporting qualification, withdrawal and issuance never alter paid payroll or journals",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
