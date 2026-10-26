import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "@openbooks/engine/testing/fixtures";
import { seedAdoption } from "@openbooks/engine/testing/payroll/filing-test-fixtures";
import { payrollRoeReportingResource } from "./payroll-roe-reporting-resource";

async function fixture() {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  const filingAccountId = randomUUID(),
    folder = randomUUID(),
    file = randomUUID(),
    version = randomUUID();
  const bytes = Buffer.from(
    "Original employee reporting periods and explicit insurance/hour facts",
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
    values(${filingAccountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001','Employer account','regular',true,true,${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folder},${f.orgId},'Original ROE source',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${file},${f.orgId},${folder},'original.txt','text/plain',${bytes.length},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${version},${file},1,${bytes.length},'text/plain',${hash},${f.actorId}) returning id`,
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
    ...f,
    row: {
      employeePartyId: f.employeeId,
      employmentId: f.employmentId,
      subsidiaryId: f.subsidiaryId,
      filingAccountId,
      payScheduleId: f.scheduleId,
      frequency: "biweekly",
      periodStart: "2026-07-05",
      periodEnd: "2026-07-18",
      payDate: "2026-07-21",
      earnedFrom: "2026-07-14",
      earnedTo: "2026-07-14",
      insurableEarnings: "80.1234",
      insurableHours: "4.25",
      nilPeriod: false,
      sourceFileId: file,
      sourceVersionId: version,
      sourceSha256: hash,
      sourceReference: "Original employee and period",
      insuranceReference: "Original insured earnings declaration",
      hoursReference: "Original insured hours declaration",
      reason: "Retain the qualified reporting facts",
      expectedId: "new",
      expectedUpdatedAt: "",
    },
    resource: payrollRoeReportingResource(f.orgId, "period"),
    context: { orgId: f.orgId, actorId: f.actorId, allowedSubsidiaryIds: null, dryRun: false },
  };
}
async function retainedState(orgId: string) {
  return {
    periods: await db.execute(
      sql`select to_jsonb(p) as row from payroll_roe_historical_periods p where org_id=${orgId} order by id`,
      "objects",
    ),
    audits: await db.execute(
      sql`select to_jsonb(a) as row from audit_log a where org_id=${orgId} and table_name='payroll_roe_historical_periods' order by id`,
      "objects",
    ),
    runs: await db.execute(
      sql`select document_id from pay_runs where org_id=${orgId} order by document_id`,
      "objects",
    ),
    journals: await db.execute(
      sql`select id from journal_entries where org_id=${orgId} order by id`,
      "objects",
    ),
  };
}
test(
  "shared ROE import preview rolls back native evidence and audit; commit/export/replay retain exact decimals and original identity",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await withBypassContext(fixture);
    try {
      await withOrgContext(f.orgId, async () => {
        const before = await retainedState(f.orgId);
        const keys: (readonly (string | null)[])[] = [];
        const preview = await f.resource.write([f.row], "upsert", {
          ...f.context,
          dryRun: true,
          recordKeys: async (value) => {
            keys.push(value);
          },
        });
        assert.deepEqual(preview, { created: 1, updated: 0, failed: 0, errors: [] });
        assert.equal(keys.length, 1);
        assert.ok(keys[0]![0]);
        assert.deepEqual(await retainedState(f.orgId), before);
        assert.deepEqual(await f.resource.write([f.row], "upsert", f.context), preview);
        const exported = (await f.resource.read({ actorId: f.actorId, allowedSubsidiaryIds: null }))
          .rows;
        assert.equal(exported.length, 1);
        assert.equal(exported[0]!.insurableEarnings, "80.1234");
        assert.equal(exported[0]!.insurableHours, "4.2500");
        assert.equal(exported[0]!.sourceVersionId, f.row.sourceVersionId);
        assert.notEqual(exported[0]!.expectedId, "new");
        const saved = await retainedState(f.orgId);
        assert.deepEqual(saved.runs, before.runs);
        assert.deepEqual(saved.journals, before.journals);
        assert.deepEqual(await f.resource.write(exported, "upsert", f.context), {
          created: 0,
          updated: 0,
          failed: 0,
          errors: [],
        });
        assert.deepEqual(await retainedState(f.orgId), saved);
        assert.equal(
          (await f.resource.read({ actorId: f.actorId, allowedSubsidiaryIds: new Set<string>() }))
            .rows.length,
          0,
        );
        await assert.rejects(f.resource.read({ allowedSubsidiaryIds: null }), /acting user/);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
test(
  "ROE imports refuse duplicate/overlapping periods, missing declarations, numeric money, hidden employers and stale reviewed versions",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await withBypassContext(fixture);
    try {
      await withOrgContext(f.orgId, async () => {
        const before = await retainedState(f.orgId);
        for (const dryRun of [true, false]) {
          const ctx = { ...f.context, dryRun };
          const duplicated = await f.resource.write([f.row, f.row], "upsert", ctx);
          assert.equal(duplicated.failed, 2);
          assert.match(duplicated.errors[0]!.message, /more than once/);
          const overlapping = await f.resource.write(
            [f.row, { ...f.row, periodStart: "2026-07-12", periodEnd: "2026-07-25" }],
            "upsert",
            ctx,
          );
          assert.equal(overlapping.failed, 2);
          assert.match(overlapping.errors[0]!.message, /overlap/);
          for (const [row, pattern] of [
            [{ ...f.row, nilPeriod: "" }, /explicitly as true or false/],
            [{ ...f.row, insuranceReference: "" }, /insurance and hours sources/],
            [{ ...f.row, insurableEarnings: 80.1234 }, /text|JSON|number|decimal/i],
            [{ ...f.row, sourceSha256: "f".repeat(64) }, /exact retained version and hash/],
          ] as const) {
            const refused = await f.resource.write([row], "upsert", ctx);
            assert.equal(refused.failed, 1);
            assert.match(refused.errors[0]!.message, pattern);
          }
          const hidden = await f.resource.write([f.row], "upsert", {
            ...ctx,
            allowedSubsidiaryIds: new Set<string>(),
          });
          assert.equal(hidden.failed, 1);
          assert.match(hidden.errors[0]!.message, /payroll scope/);
        }
        assert.deepEqual(await retainedState(f.orgId), before);
        await f.resource.write([f.row], "upsert", f.context);
        const reviewed = (await f.resource.read({ actorId: f.actorId, allowedSubsidiaryIds: null }))
          .rows[0]!;
        const changed = await f.resource.write(
          [
            {
              ...reviewed,
              insurableEarnings: "90",
              reason: "Correct source-qualified insurance amount",
            },
          ],
          "upsert",
          f.context,
        );
        assert.equal(changed.updated, 1);
        const stale = await f.resource.write(
          [{ ...reviewed, insurableEarnings: "100", reason: "Use obsolete review version" }],
          "upsert",
          f.context,
        );
        assert.equal(stale.failed, 1);
        assert.match(stale.errors[0]!.message, /changed.*reload/);
        const posting = () => f.resource.write([f.row], "upsert", { ...f.context, post: true });
        await assert.rejects(posting(), /cannot post payroll or journals/);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
