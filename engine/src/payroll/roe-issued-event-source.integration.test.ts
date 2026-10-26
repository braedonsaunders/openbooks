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
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { importRoePriorPeriod, type RoePriorPeriodInput } from "./roe-history.ts";
import { readRoeSeparationFacts, saveRoeSeparationFacts } from "./roe-separation-facts.ts";
import { roeEventRow } from "./roe-event-row.ts";
import { roeRecord, roeCandidates } from "./yearend.ts";
import { recordFilingIssue } from "./yearend-amendments.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;

async function setup() {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  const accountId = randomUUID();
  await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
  values(${accountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001','Original legal-employer account',true)`);
  await db.execute(sql`update employee_payroll_profiles set filing_account_id=${accountId},
  sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })},sin_last3='286'
  where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll,t4Transmitter}',
  ${JSON.stringify({ bn: "123456789RP0001", name: "Fixture employer", contactName: "Pat Payroll", contactPhone: "5555550100" })}::jsonb)
  where id=${f.orgId}`);
  await seedRoeIssuanceFixture(f.orgId, f.employeeId);
  return { ...f, accountId };
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
async function source(f: Fixture, start: string, end: string): Promise<RoePriorPeriodInput> {
  const bytes = Buffer.from(
    JSON.stringify({
      employee: f.employeeId,
      start,
      end,
      insurableEarnings: "100",
      insurableHours: "4",
    }),
  );
  const hash = createHash("sha256").update(bytes).digest("hex"),
    folder = randomUUID(),
    file = randomUUID(),
    version = randomUUID();
  await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
  values(${folder},${f.orgId},'Original statutory reporting evidence',true,${f.actorId},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
  values(${file},${f.orgId},${folder},'original-period.json','application/json',${bytes.length},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
  values(${version},${file},1,${bytes.length},'application/json',${hash},${f.actorId})`);
  await db.execute(sql`insert into file_blobs(version_id,bytes) values(${version},${bytes})`);
  await db.execute(
    sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file}`,
  );
  return {
    sourceFileId: file,
    sourceVersionId: version,
    sourceSha256: hash,
    sourceReference: "Original employee period declaration",
    insuranceReference: "Original insurable-pay classification",
    hoursReference: "Original recorded paid hours",
    reason: "Retain statutory reporting evidence",
    filingAccountId: f.accountId,
    payScheduleId: f.scheduleId,
    frequency: "biweekly",
    periodStart: start,
    periodEnd: end,
    payDate: end,
    earnedFrom: start,
    earnedTo: end,
    insurableEarnings: "100",
    insurableHours: "4",
    nilPeriod: false,
    expectedId: null,
    expectedUpdatedAt: null,
  };
}
const facts = {
  salaryContinuanceEndOn: null,
  status: "confirmed" as const,
  sourceReference: "Original employer interruption declaration",
  reason: "Confirm the independently declared service spell",
};
async function retained(f: Fixture) {
  return (
    await db.execute<{ snapshot: string }>(
      sql`select jsonb_build_object(
  'submissions',(select jsonb_agg(to_jsonb(s) order by s.id) from payroll_filing_submissions s where s.org_id=${f.orgId}),
  'slips',(select jsonb_agg(to_jsonb(s) order by s.id) from payroll_filing_submission_slips s where s.org_id=${f.orgId}),
  'bindings',(select jsonb_agg(to_jsonb(s) order by s.id) from payroll_roe_issued_event_sources s where s.org_id=${f.orgId}))::text as snapshot`,
      "objects",
    )
  )[0]!.snapshot;
}

test(
  "issued event A freezes its used source while later event B retains an independent original and artifact",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const current = await readRoeSeparationFacts(scope(f));
        assert.ok(current);
        const a = await saveRoeSeparationFacts({
          ...scope(f),
          ...facts,
          firstDayWorked: "2026-07-05",
          lastInsurableEarningsOn: "2026-07-18",
          interruptionOn: "2026-07-19",
          expectedId: current.id,
          expectedUpdatedAt: current.updatedAt,
        });
        const inputA = await source(f, "2026-07-05", "2026-07-18");
        const periodA = await importRoePriorPeriod(scope(f), inputA);
        const issuedA = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: roeEventRow(f.employeeId, a.id) + ":A" },
        });
        const before = await retained(f);
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope(f),
            ...facts,
            firstDayWorked: "2026-07-05",
            lastInsurableEarningsOn: "2026-07-17",
            interruptionOn: "2026-07-19",
            expectedId: a.id,
            expectedUpdatedAt: a.updatedAt,
          }),
          /changed|issued ROE event/,
        );
        await assert.rejects(
          importRoePriorPeriod(scope(f), {
            ...inputA,
            reason: "Change a used reference",
            expectedId: periodA.id,
            expectedUpdatedAt: periodA.updatedAt,
          }),
          (error) => errorChainMatches(error, /used source cannot be changed/),
        );
        assert.equal(await retained(f), before);
        const b = await saveRoeSeparationFacts({
          ...scope(f),
          ...facts,
          firstDayWorked: "2026-07-19",
          lastInsurableEarningsOn: "2026-08-01",
          interruptionOn: "2026-08-02",
          expectedId: null,
          expectedUpdatedAt: null,
        });
        await importRoePriorPeriod(scope(f), await source(f, "2026-07-19", "2026-08-01"));
        await assert.rejects(roeRecord(f.orgId, f.employeeId), /multiple separation events/);
        const recordA = await roeRecord(f.orgId, f.employeeId, a.id);
        assert.equal(recordA?.totalInsurableEarnings, "100.0000");
        const recordB = await roeRecord(f.orgId, f.employeeId, b.id);
        assert.equal(recordB?.firstDayWorked, "2026-07-19");
        const candidates = await roeCandidates(f.orgId, 2026);
        assert.deepEqual(
          candidates.map((c) => c.roeRowId).sort(),
          [roeEventRow(f.employeeId, a.id), roeEventRow(f.employeeId, b.id)].sort(),
        );
        const issuedB = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: roeEventRow(f.employeeId, b.id) + ":E" },
        });
        assert.notEqual(issuedA.submission.id, issuedB.submission.id);
        assert.equal(issuedB.submission.revisionNumber, 2);
        const original = (
          await db.execute<{ body: string; sha: string }>(
            sql`select artifact_body as body,
    encode(public.digest(artifact_body,'sha256'),'hex') as sha from payroll_filing_submissions where org_id=${f.orgId} and id=${issuedA.submission.id}`,
            "objects",
          )
        )[0]!;
        assert.equal(original.body, issuedA.file?.body);
        assert.equal(original.sha, createHash("sha256").update(issuedA.file!.body).digest("hex"));
        const after = await retained(f);
        await assert.rejects(
          recordFilingIssue({
            orgId: f.orgId,
            actorId: f.actorId,
            country: "CA",
            filingKey: "roe",
            taxYear: 2026,
            revision: "original",
            params: { employees: roeEventRow(f.employeeId, a.id) + ":A" },
          }),
          /already has an issued ROE/,
        );
        assert.equal(await retained(f), after);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "a prior spell keeps its retained account and schedule when the current payroll profile changes",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const current = await readRoeSeparationFacts(scope(f));
        assert.ok(current);
        const event = await saveRoeSeparationFacts({
          ...scope(f),
          ...facts,
          firstDayWorked: "2026-07-05",
          lastInsurableEarningsOn: "2026-07-18",
          interruptionOn: "2026-07-19",
          expectedId: current.id,
          expectedUpdatedAt: current.updatedAt,
        });
        await importRoePriorPeriod(scope(f), await source(f, "2026-07-05", "2026-07-18"));
        const before = await roeRecord(f.orgId, f.employeeId, event.id);
        assert.ok(before);
        const scheduleId = randomUUID(),
          accountId = randomUUID(),
          employerId = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
   values(${employerId},${f.orgId},${f.subsidiaryId},'Current legal employer','CAD','CA')`);
        const employmentId = await seedWorkerEmployment(f.orgId, f.employeeId, employerId);
        await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,is_active)
   values(${scheduleId},${f.orgId},'Current monthly schedule','monthly',12,'2026-08-31',0,true)`);
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
   values(${accountId},${f.orgId},${employerId},'CA','ca_rp','123456789RP0002','Current payroll account',true)`);
        await db.execute(
          sql`update parties set subsidiary_id=${employerId} where org_id=${f.orgId} and id=${f.employeeId}`,
        );
        await db.execute(sql`update employee_payroll_profiles set employment_id=${employmentId},pay_schedule_id=${scheduleId},filing_account_id=${accountId}
   where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
        assert.deepEqual(await roeRecord(f.orgId, f.employeeId, event.id), before);
        const original = await readRoeSeparationFacts({ ...scope(f), eventId: event.id });
        assert.equal(original?.employmentId, f.employmentId);
        await assert.rejects(
          readRoeSeparationFacts({
            ...scope(f),
            eventId: event.id,
            employmentId,
            subsidiaryId: employerId,
          }),
          /different native employment or employer/,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "unbound legacy issued artifacts block new source declarations without guessing event ownership",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const submissionId = randomUUID();
        await db.execute(sql`insert into payroll_filing_submissions(id,org_id,country,filing_key,tax_year,revision,revision_number,slip_count,
   artifact_filename,artifact_content_type,artifact_body,created_by,updated_by)
   values(${submissionId},${f.orgId},'CA','roe',2025,'original',1,1,'retained-roe.xml','application/xml','retained original artifact',${f.actorId},${f.actorId})`);
        await db.execute(sql`insert into payroll_filing_submission_slips(org_id,submission_id,row_id,label,revision,reported,created_by,updated_by)
   values(${f.orgId},${submissionId},${f.employeeId},'Retained legacy employee','original','{}'::jsonb,${f.actorId},${f.actorId})`);
        const before = await retained(f),
          current = await readRoeSeparationFacts(scope(f));
        assert.ok(current);
        await assert.rejects(
          saveRoeSeparationFacts({
            ...scope(f),
            ...facts,
            firstDayWorked: "2026-07-05",
            lastInsurableEarningsOn: "2026-07-18",
            interruptionOn: "2026-07-19",
            expectedId: current.id,
            expectedUpdatedAt: current.updatedAt,
          }),
          /no qualified separation-event source binding/,
        );
        await assert.rejects(
          importRoePriorPeriod(scope(f), await source(f, "2026-07-05", "2026-07-18")),
          /no qualified separation-event source binding/,
        );
        assert.equal(await retained(f), before);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
