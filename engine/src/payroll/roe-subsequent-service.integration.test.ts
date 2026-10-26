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
import { errorChainMatches } from "../testing/error-chain.ts";
import { readRoeSeparationFacts, saveRoeSeparationFacts } from "./roe-separation-facts.ts";
import {
  saveRoeSubsequentService,
  readRoeSubsequentService,
} from "./canada/roe-subsequent-service.ts";
import { readRoeReportingWindow, roeWindowContext } from "./roe-reporting-window.ts";
import { roeEventRow } from "./roe-event-row.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { recordFilingIssue } from "./yearend-amendments.ts";
import { qualifyRoeLine } from "./roe-history.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
async function setup() {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  const account = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
    values(${account},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001','Original employer account',true) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update employee_payroll_profiles set filing_account_id=${account},
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
  const base = await db.execute<{ id: string }>(
    sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
    "objects",
  );
  assert.equal(base.length, 1);
  return { ...f, base: base[0]!.id };
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
async function confirmEarlier(f: Fixture) {
  const current = await readRoeSeparationFacts(scope(f));
  assert.ok(current);
  return saveRoeSeparationFacts({
    ...scope(f),
    firstDayWorked: "2026-07-05",
    lastInsurableEarningsOn: "2026-07-18",
    interruptionOn: "2026-07-18",
    salaryContinuanceEndOn: null,
    status: "confirmed",
    sourceReference: "Original interruption and first-worked declaration",
    reason: "Retain the original first event",
    expectedId: current.id,
    expectedUpdatedAt: current.updatedAt,
  });
}
async function source(f: Fixture) {
  const bytes = Buffer.from(
    JSON.stringify({
      employee: f.employeeId,
      employment: f.employmentId,
      employer: f.subsidiaryId,
      firstDayWorked: "2026-07-19",
      insurableWages: "100",
      paidHours: "4",
    }),
  );
  const hash = createHash("sha256").update(bytes).digest("hex"),
    folder = randomUUID(),
    file = randomUUID(),
    version = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folder},${f.orgId},'Original service record',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${file},${f.orgId},${folder},'service.json','application/json',${bytes.length},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${version},${file},1,${bytes.length},'application/json',${hash},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes) values(${version},${bytes}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return {
    sourceFileId: file,
    sourceVersionId: version,
    sourceSha256: hash,
    sourceReference: "Original returned service and paid-work record",
    reason: "Retain actual service scope without creating an interruption",
    expectedId: null,
    expectedUpdatedAt: null,
    firstDayWorked: "2026-07-19",
  };
}
async function committed(
  f: Fixture,
  start: string,
  end: string,
  earned: string | null,
  earlierExtra?: string,
) {
  const run = await createPayRun({
    orgId: f.orgId,
    actorId: f.actorId,
    payScheduleId: f.scheduleId,
    periodStart: start,
    periodEnd: end,
    payDate: end,
  });
  await mutatePayRunAdjustment({
    orgId: f.orgId,
    actorId: f.actorId,
    documentId: run.documentId,
    reason: "Original wage and earned span",
    mutation: {
      action: "add",
      employeePartyId: f.employeeId,
      componentId: f.base,
      amount: "100",
      hours: "4",
      replaceComponent: true,
      earnedFrom: earned,
      earnedTo: earned,
    },
  });
  if (earlierExtra)
    await mutatePayRunAdjustment({
      orgId: f.orgId,
      actorId: f.actorId,
      documentId: run.documentId,
      reason: "Original separate earlier-work wage instruction",
      mutation: {
        action: "add",
        employeePartyId: f.employeeId,
        componentId: f.base,
        amount: "25",
        hours: "1",
        replaceComponent: false,
        earnedFrom: earlierExtra,
        earnedTo: earlierExtra,
      },
    });
  const input = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
  assert.deepEqual((await calculatePayRun(input)).errors, []);
  await commitPayRun(input);
  return run;
}
async function retained(f: Fixture) {
  return (
    await db.execute<{ body: string }>(
      sql`select jsonb_build_object(
  'stubs',(select jsonb_agg(to_jsonb(s) order by s.id) from pay_stubs s where s.org_id=${f.orgId}),
  'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l where l.org_id=${f.orgId}),
  'employment',(select to_jsonb(e) from worker_employments e where e.org_id=${f.orgId} and e.id=${f.employmentId}))::text as body`,
      "objects",
    )
  )[0]!.body;
}
test(
  "an active returned spell permits the earlier ROE, freezes its exact exclusion source and preserves native payroll history",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const event = await confirmEarlier(f);
        const earlier = await committed(f, "2026-07-05", "2026-07-18", "2026-07-18");
        const later = await committed(f, "2026-07-19", "2026-08-01", "2026-07-20");
        const before = await retained(f);
        await assert.rejects(
          readRoeReportingWindow(await roeWindowContext(f.orgId, f.employeeId, event.id)),
          /after|later|attribut|earned/,
        );
        const input = { ...(await source(f)), precedingEventId: event.id };
        const certificate = await saveRoeSubsequentService(scope(f), input);
        assert.deepEqual(
          await saveRoeSubsequentService(scope(f), input),
          certificate,
          "an exact native replay retains the certificate identity and audit",
        );
        assert.equal((await readRoeSubsequentService(scope(f), event.id))?.id, certificate.id);
        const selected = await db.execute<{
          id: string;
          documentId: string;
          proof: { stubId: string; lines: { retained: { stubId: string } }[] } | null;
        }>(
          sql`
      select s.id,s.pay_run_document_id as "documentId",public.payroll_roe_later_stub_source(${f.orgId},${event.id},s.id) as proof
      from pay_stubs s where s.org_id=${f.orgId} and s.employee_party_id=${f.employeeId}
        and s.pay_run_document_id in (${earlier.documentId},${later.documentId}) order by s.id`,
          "objects",
        );
        assert.equal(selected.length, 2);
        const earlierSource = selected.find((row) => row.documentId === earlier.documentId)!;
        const laterSource = selected.find((row) => row.documentId === later.documentId)!;
        assert.equal(
          earlierSource.proof,
          null,
          "earlier work cannot be attributed to the certified later spell",
        );
        assert.ok(
          laterSource.proof,
          "a selected later stub must not scan unrelated earlier earnings",
        );
        assert.equal(laterSource.proof.stubId, laterSource.id);
        assert.ok(laterSource.proof.lines.length > 0);
        assert.ok(
          laterSource.proof.lines.every((line) => line.retained.stubId === laterSource.id),
          "every material source belongs to the exact argument stub",
        );

        const window = await readRoeReportingWindow(
          await roeWindowContext(f.orgId, f.employeeId, event.id),
        );
        assert.equal(window.sourceDocuments.length, 1);
        assert.equal(window.totalInsurableEarnings, "100.0000");
        assert.equal(
          await retained(f),
          before,
          "reporting certification cannot change payroll or employment history",
        );
        const issued = await recordFilingIssue({
          orgId: f.orgId,
          actorId: f.actorId,
          country: "CA",
          filingKey: "roe",
          taxYear: 2026,
          revision: "original",
          params: { employees: roeEventRow(f.employeeId, event.id) + ":A" },
        });
        const bindings = await db.execute<{ body: Record<string, unknown> }>(
          sql`select source_snapshot as body from payroll_roe_issued_event_sources
      where org_id=${f.orgId} and event_id=${event.id}`,
          "objects",
        );
        assert.equal(bindings.length, 1);
        const exclusions = bindings[0]!.body.excludedLaterService as Array<{
          returnCertificate: { id: string };
          lines: unknown[];
        }>;
        assert.equal(exclusions.length, 1);
        assert.equal(exclusions[0]!.returnCertificate.id, certificate.id);
        assert.ok(exclusions[0]!.lines.length);
        const sha = createHash("sha256").update(issued.file!.body).digest("hex");
        const retainedLines = await db.execute<{ id: string }>(
          sql`select l.id from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where s.org_id=${f.orgId} and s.pay_run_document_id=${later.documentId} and s.employee_party_id=${f.employeeId}
        and l.component_id=${f.base} and l.kind='earning' and l.amount=100`,
          "objects",
        );
        assert.equal(retainedLines.length, 1);
        await assert.rejects(
          qualifyRoeLine(scope(f), {
            ...input,
            payStubLineId: retainedLines[0]!.id,
            reportPeriodStart: "2026-07-19",
            reportPeriodEnd: "2026-08-01",
            earnedFrom: "2026-07-20",
            earnedTo: "2026-07-20",
            isInsurable: true,
            insurableHours: "4",
            insuranceReference: "Original insured wages",
            hoursReference: "Original four paid hours",
          }),
          (error) => errorChainMatches(error, /used exclusion evidence cannot be changed/),
        );
        await assert.rejects(
          saveRoeSubsequentService(scope(f), {
            ...input,
            firstDayWorked: "2026-07-21",
            expectedId: certificate.id,
            expectedUpdatedAt: certificate.updatedAt,
          }),
          /earlier event|service scope|statutory correction/,
        );
        await assert.rejects(
          db.execute(sql`update payroll_roe_subsequent_service_sources set first_day_worked='2026-07-21'
      where org_id=${f.orgId} and id=${certificate.id}`),
          (error) => errorChainMatches(error, /issued ROE retains its service scope/i),
        );
        const artifact = await db.execute<{ sha: string }>(
          sql`select encode(public.digest(artifact_body,'sha256'),'hex') as sha
      from payroll_filing_submissions where org_id=${f.orgId} and id=${issued.submission.id}`,
          "objects",
        );
        assert.equal(artifact[0]!.sha, sha);
        assert.equal(await retained(f), before);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
test(
  "later payment for earlier work and unknown earned dates cannot be excluded by a returned-service certificate",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const event = await confirmEarlier(f);
        await committed(f, "2026-07-05", "2026-07-18", "2026-07-18");
        const later = await committed(f, "2026-07-19", "2026-08-01", "2026-07-18");
        const input = { ...(await source(f)), precedingEventId: event.id };
        await saveRoeSubsequentService(scope(f), input);
        const proof = await db.execute<{ proof: unknown }>(
          sql`select public.payroll_roe_later_stub_source(${f.orgId}::uuid,${event.id}::uuid,s.id) as proof
      from pay_stubs s where s.org_id=${f.orgId} and s.pay_run_document_id=${later.documentId} and s.employee_party_id=${f.employeeId}`,
          "objects",
        );
        assert.equal(proof.length, 1);
        assert.equal(
          proof[0]!.proof,
          null,
          "pay date cannot convert earlier earned work into later service",
        );
        const window = await readRoeReportingWindow(
          await roeWindowContext(f.orgId, f.employeeId, event.id),
        );
        assert.equal(
          window.totalInsurableEarnings,
          "200.0000",
          "qualified late earlier-work remains reportable",
        );
        const mixed = await committed(f, "2026-08-02", "2026-08-15", "2026-08-03", "2026-07-18");
        const mixedSource = await db.execute<{
          proof: unknown;
          earlierCount: number;
          laterCount: number;
        }>(
          sql`select
      public.payroll_roe_later_stub_source(${f.orgId}::uuid,${event.id}::uuid,s.id) as proof,
      (select count(*)::int from pay_stub_lines l where l.org_id=s.org_id and l.stub_id=s.id
        and l.kind='earning' and l.amount<>0 and l.earned_from='2026-07-18') as "earlierCount",
      (select count(*)::int from pay_stub_lines l where l.org_id=s.org_id and l.stub_id=s.id
        and l.kind='earning' and l.amount<>0 and l.earned_from='2026-08-03') as "laterCount"
      from pay_stubs s where s.org_id=${f.orgId} and s.pay_run_document_id=${mixed.documentId} and s.employee_party_id=${f.employeeId}`,
          "objects",
        );
        assert.equal(mixedSource.length, 1);
        assert.equal(mixedSource[0]!.earlierCount, 1);
        assert.equal(mixedSource[0]!.laterCount, 1);
        assert.equal(
          mixedSource[0]!.proof,
          null,
          "a selected stub mixing earlier and later service cannot be wholly excluded",
        );
        const undated = await committed(f, "2026-08-16", "2026-08-29", null);
        const undatedProof = await db.execute<{ proof: unknown; missing: boolean }>(
          sql`select
      public.payroll_roe_later_stub_source(${f.orgId}::uuid,${event.id}::uuid,s.id) as proof,
      exists(select 1 from pay_stub_lines l where l.org_id=s.org_id and l.stub_id=s.id and l.kind='earning'
        and (l.amount<>0 or l.hours<>0) and (l.earned_from is null or l.earned_to is null)) as missing
      from pay_stubs s where s.org_id=${f.orgId} and s.pay_run_document_id=${undated.documentId} and s.employee_party_id=${f.employeeId}`,
          "objects",
        );
        assert.equal(undatedProof.length, 1);
        assert.equal(
          undatedProof[0]!.missing,
          true,
          "the native committed source actually lacks earned dates",
        );
        assert.equal(undatedProof[0]!.proof, null);
        await assert.rejects(
          readRoeReportingWindow(await roeWindowContext(f.orgId, f.employeeId, event.id)),
          /earned|attribut|later|after/,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "return certificates enforce native employer scope, exact source ownership, stale correction and audit identity",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup),
      other = await withBypassContext(setup);
    try {
      const foreign = await withOrgContext(other.orgId, () => source(other));
      await withOrgContext(f.orgId, async () => {
        const event = await confirmEarlier(f),
          ref = await source(f);
        const input = { ...ref, precedingEventId: event.id };
        await assert.rejects(
          saveRoeSubsequentService(scope(f), { ...foreign, precedingEventId: event.id }),
          /importing operator/,
        );
        await assert.rejects(
          saveRoeSubsequentService({ ...scope(f), allowedSubsidiaryIds: new Set<string>() }, input),
          /payroll scope|native legal employer/,
        );
        await assert.rejects(
          saveRoeSubsequentService({ ...scope(f), subsidiaryId: other.subsidiaryId }, input),
          /actual native employment and legal employer/,
        );
        await assert.rejects(
          saveRoeSubsequentService(scope(f), { ...input, sourceSha256: "f".repeat(64) }),
          /retained version and hash/,
        );
        const before = await retained(f),
          certificate = await saveRoeSubsequentService(scope(f), input);
        const corrected = await saveRoeSubsequentService(scope(f), {
          ...input,
          sourceReference: "Corrected original source citation",
          expectedId: certificate.id,
          expectedUpdatedAt: certificate.updatedAt,
        });
        assert.equal(corrected.id, certificate.id);
        assert.notEqual(corrected.updatedAt, certificate.updatedAt);
        await assert.rejects(
          saveRoeSubsequentService(scope(f), {
            ...input,
            firstDayWorked: "2026-07-20",
            expectedId: certificate.id,
            expectedUpdatedAt: certificate.updatedAt,
          }),
          /changed.*reload/,
        );
        const audits = await db.execute<{ changes: { before: unknown; after: { id: string } } }>(
          sql`select changes from audit_log
        where org_id=${f.orgId} and table_name='payroll_roe_subsequent_service_sources' order by at,id`,
          "objects",
        );
        assert.equal(audits.length, 2);
        assert.equal(audits[0]!.changes.before, null);
        assert.equal(audits[1]!.changes.after.id, certificate.id);
        assert.equal(await retained(f), before);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      await withBypassContext(() => dropScratchOrgReporting(other.orgId));
    }
  },
);
