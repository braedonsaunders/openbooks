import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "../../testing/fixtures.ts";
import { errorChainMatches } from "../../testing/error-chain.ts";
import { seedAdoption, type AdoptionFixture } from "../filing-test-fixtures.ts";
import { saveOpeningBalances } from "../opening-balances.ts";
import {
  qualifyOpeningEmployerAuthority,
  readOpeningEmployerContext,
} from "../opening-employer-authority.ts";
import {
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
  type OpeningLevySourceAllocationInput,
} from "../opening-levy-source-authority.ts";
import { correctOpeningLevySourceAuthority } from "../opening-levy-source-correction.ts";
import {
  qualifyCanadianOpeningReportingSource,
  readCanadianOpeningReportingSourceContext,
} from "./opening-reporting-authority.ts";
import { readEmployeeCanadianOpeningReportingSource } from "./opening-reporting-reader.ts";
import { t4Slips } from "../yearend.ts";
import { rl1Return } from "./quebec/rl1.ts";
import type { CanadianOpeningReportingAllocation } from "./opening-reporting-source.ts";

const skip = !process.env.OPENBOOKS_DB_URL;
const facts = {
  originalCountry: "CA",
  originalCurrency: "CAD",
  coverageStart: "2026-01-01",
  coverageEnd: "2026-06-30",
  coverageComplete: true,
} as const;
const provinces = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const levies: OpeningLevySourceAllocationInput[] = [
  ...provinces.map((region) => ({
    programKey: "ca_wcb",
    region,
    federalAccountId: null,
    amount: "0",
  })),
  ...["BC", "MB", "NL", "ON"].map((region) => ({
    programKey: "ca_eht",
    region,
    federalAccountId: null,
    amount: "0",
  })),
  { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: "0" },
];

async function setup() {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  return f;
}

async function retainFile(f: AdoptionFixture, label: string) {
  const fileId = randomUUID(),
    versionId = randomUUID(),
    folderId = randomUUID();
  const bytes = Buffer.from(
    JSON.stringify({ employeePartyId: f.employeeId, taxYear: 2026, ...facts, label }),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values (${folderId},${f.orgId},'Original reporting evidence',true,${f.actorId},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values (${fileId},${f.orgId},${folderId},'original-report.json','application/json',${bytes.length},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values (${versionId},${fileId},1,${bytes.length},'application/json',${sha256},${f.actorId})`);
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes) values (${versionId},${bytes}) returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${versionId} where org_id=${f.orgId} and id=${fileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return { sourceFileId: fileId, sourceVersionId: versionId, sourceSha256: sha256 };
}

async function qualifyOriginal(f: AdoptionFixture) {
  const saved = await saveOpeningBalances({
    orgId: f.orgId,
    actorId: f.actorId,
    taxYear: 2026,
    rows: [
      {
        employeePartyId: f.employeeId,
        amounts: { taxableYtd: "12000.0001", taxYtd: "125", qpipYtd: "40" },
        programs: { qpip: "5000" },
      },
    ],
  });
  assert.deepEqual(saved.errors, []);
  const file = await retainFile(f, "Original annual report");
  const contextInput = {
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    allowedSubsidiaryIds: null,
  };
  const employer = await readOpeningEmployerContext({
    ...contextInput,
    sourceFileId: file.sourceFileId,
  });
  const levy = await readOpeningLevySourceContext(contextInput);
  assert.ok(employer.record);
  assert.ok(levy.record);
  const packet = {
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: employer.record.id,
    expectedOpeningSha256: employer.record.openingSha256,
    expectedOpeningChildrenSha256: levy.record.openingChildrenSha256,
    ...file,
    ...facts,
    allocations: levies,
    sourceReference: "Original Canadian statutory report",
    reason: "Retain original statutory allocation",
    allowedSubsidiaryIds: null,
  };
  await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: f.subsidiaryId });
  const original = await qualifyOpeningLevySourceAuthority(packet);
  const accounts = [randomUUID(), randomUUID()].sort();
  for (const [index, id] of accounts.entries()) {
    assert.equal(
      (
        await db.execute(
          sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,subsidiary_id,created_by,updated_by)
      values (${id},${f.orgId},'CA','ca_rp',${"123456789RP000" + String(index + 1)},${"Original RP " + String(index + 1)},${f.subsidiaryId},${f.actorId},${f.actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
  }
  const context = await readCanadianOpeningReportingSourceContext({
    ...contextInput,
    sourceFileId: file.sourceFileId,
  });
  const zeroAnnual = Object.fromEntries(
    Object.keys(context.original.annualAmounts).map((key) => [key, "0"]),
  );
  const allocations: CanadianOpeningReportingAllocation[] = [
    {
      sourceOrdinal: 2,
      firstCoveredPayDate: "2026-03-15",
      filingAccountId: accounts[0]!,
      province: "ON",
      reportableBases: { ei: "0", cpp: "0", qpip: "0" },
      annualAmounts: { ...zeroAnnual, taxable_ytd: "7000.0001", tax_ytd: "75" },
      children: {
        components: [],
        programBases: [{ program_key: "qpip", insurable_ytd: "0" }],
        accountBases: [],
        suiStates: [],
      },
    },
    {
      sourceOrdinal: 1,
      firstCoveredPayDate: "2026-01-15",
      filingAccountId: accounts[1]!,
      province: "QC",
      reportableBases: { ei: "0", cpp: "0", qpip: "5000" },
      annualAmounts: { ...zeroAnnual, taxable_ytd: "5000", tax_ytd: "50", qpip_ytd: "40" },
      children: {
        components: [],
        programBases: [{ program_key: "qpip", insurable_ytd: "5000" }],
        accountBases: [],
        suiStates: [],
      },
    },
  ];
  const reporting = {
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: packet.openingBalanceId,
    requestId: randomUUID(),
    expectedLevyAuthorityId: original.id,
    expectedLevyAllocationSha256: original.allocationSha256,
    expectedOpeningSha256: packet.expectedOpeningSha256,
    expectedOpeningChildrenSha256: packet.expectedOpeningChildrenSha256,
    ...file,
    sourceReference: "Source-attested original RP and province order",
    reason: "Retain every exact original reporting allocation",
    allocations,
    allowedSubsidiaryIds: null,
  };
  return { packet, original, reporting, contextInput };
}

test(
  "original reporting qualification preserves source amounts, order, exact replay and immutable audit",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { reporting, contextInput } = await qualifyOriginal(f);
        await assert.rejects(
          readEmployeeCanadianOpeningReportingSource(db, contextInput),
          /current Canadian original reporting source is missing/,
        );
        const saved = await qualifyCanadianOpeningReportingSource(reporting);
        assert.deepEqual(await qualifyCanadianOpeningReportingSource(reporting), saved);
        const read = await readEmployeeCanadianOpeningReportingSource(db, contextInput);
        assert.equal(read.authority?.id, saved.id);
        assert.deepEqual(
          read.allocations.map((row) => row.sourceOrdinal),
          [1, 2],
        );
        assert.equal(
          read.allocations[0]!.filingAccountId,
          reporting.allocations[1]!.filingAccountId,
        );
        assert.equal(read.annualAmounts?.taxable_ytd, "12000.0001");
        assert.equal(read.children?.programBases[0]?.insurable_ytd, "5000.0000");
        const slips = await t4Slips(f.orgId, 2026);
        assert.equal(slips.length, 2);
        assert.equal(
          slips.find((slip) => slip.province === "QC")?.box14EmploymentIncome,
          "5000.0000",
        );
        assert.equal(
          slips.find((slip) => slip.province === "ON")?.filingAccountId,
          reporting.allocations[0]!.filingAccountId,
        );
        assert.equal(slips.find((slip) => slip.province === "QC")?.box56QpipInsurable, "5000.0000");
        const originalSlips = structuredClone(slips);
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set province='BC',filing_account_id=${reporting.allocations[0]!.filingAccountId}
      where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.deepEqual(await t4Slips(f.orgId, 2026), originalSlips);
        const quebec = await rl1Return(f.orgId, 2026);
        assert.equal(quebec.slips.length, 1);
        assert.equal(quebec.slips[0]!.boxA, "5000.0000");
        assert.equal(quebec.slips[0]!.boxI, "5000.0000");
        const audits = await db.execute<{ changes: { after: { id: string }; reason: string } }>(
          sql`select changes from audit_log
      where org_id=${f.orgId} and table_name='payroll_ca_opening_reporting_authorities' and row_id=${saved.id}`,
          "objects",
        );
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.changes.after.id, saved.id);
        assert.equal(audits[0]!.changes.reason, reporting.reason);
        await assert.rejects(
          qualifyCanadianOpeningReportingSource({ ...reporting, reason: "Changed evidence" }),
          /already preserves different evidence/,
        );
        await assert.rejects(
          qualifyCanadianOpeningReportingSource({ ...reporting, allowedSubsidiaryIds: new Set() }),
          /outside your payroll authority/,
        );
        await assert.rejects(
          qualifyCanadianOpeningReportingSource({
            ...reporting,
            expectedOpeningChildrenSha256: "f".repeat(64),
          }),
          /child snapshot changed/,
        );
        await assert.rejects(
          db.transaction(async (tx) => {
            await tx.execute(
              sql`update payroll_ca_opening_reporting_authorities set change_reason='Changed' where org_id=${f.orgId} and id=${saved.id}`,
            );
          }),
          (error) => errorChainMatches(error, /only be sealed once/),
        );
        await assert.rejects(
          db.transaction(async (tx) => {
            await tx.execute(
              sql`delete from payroll_ca_opening_reporting_allocations where org_id=${f.orgId} and authority_id=${saved.id}`,
            );
          }),
          (error) => errorChainMatches(error, /slices are immutable/),
        );
        await assert.rejects(
          db.transaction(async (tx) => {
            await tx.execute(
              sql`update payroll_filing_accounts set account_number='123456789RP0099' where org_id=${f.orgId} and id=${reporting.allocations[0]!.filingAccountId}`,
            );
          }),
          (error) => errorChainMatches(error, /preserves its RP account/),
        );
        await assert.rejects(
          db.transaction(async (tx) => {
            await tx.execute(
              sql`update payroll_filing_accounts set subsidiary_id=null where org_id=${f.orgId} and id=${reporting.allocations[0]!.filingAccountId}`,
            );
          }),
          (error) => errorChainMatches(error, /preserves its RP account/),
        );
        await withOrgContext(randomUUID(), async () => {
          assert.equal(
            (
              await db.execute(
                sql`select id from payroll_ca_opening_reporting_authorities where id=${saved.id}`,
                "objects",
              )
            ).length,
            0,
          );
          assert.equal(
            (
              await db.execute(
                sql`select id from payroll_ca_opening_reporting_allocations where authority_id=${saved.id}`,
                "objects",
              )
            ).length,
            0,
          );
        });
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "a replaced levy certificate invalidates original reporting selection while retaining predecessor evidence",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { packet, original, reporting, contextInput } = await qualifyOriginal(f);
        const saved = await qualifyCanadianOpeningReportingSource(reporting);
        const retained = (
          await db.execute<{ snapshot: unknown }>(
            sql`select to_jsonb(h) as snapshot from payroll_ca_opening_reporting_authorities h where org_id=${f.orgId} and id=${saved.id}`,
            "objects",
          )
        )[0]!.snapshot;
        const successor = await correctOpeningLevySourceAuthority({
          ...packet,
          ...(await retainFile(f, "Reviewed source reference")),
          expectedAuthorityId: original.id,
          expectedAllocationSha256: original.allocationSha256,
          requestId: randomUUID(),
          reason: "Correct the original source reference",
        });
        await assert.rejects(
          readEmployeeCanadianOpeningReportingSource(db, contextInput),
          /current Canadian original reporting source is missing/,
        );
        await assert.rejects(
          qualifyCanadianOpeningReportingSource(reporting),
          /exact current Canadian CAD original levy certificate/,
        );
        assert.deepEqual(
          (
            await db.execute<{ snapshot: unknown }>(
              sql`select to_jsonb(h) as snapshot from payroll_ca_opening_reporting_authorities h where org_id=${f.orgId} and id=${saved.id}`,
              "objects",
            )
          )[0]!.snapshot,
          retained,
        );
        const replacement = await qualifyCanadianOpeningReportingSource({
          ...reporting,
          requestId: randomUUID(),
          expectedLevyAuthorityId: successor.id,
          expectedLevyAllocationSha256: successor.allocationSha256,
        });
        assert.notEqual(replacement.id, saved.id);
        assert.equal(
          (await readEmployeeCanadianOpeningReportingSource(db, contextInput)).authority?.id,
          replacement.id,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "concurrent original reporting qualifications cannot create conflicting certificates for one current levy",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { reporting } = await qualifyOriginal(f);
        const outcomes = await Promise.allSettled([
          qualifyCanadianOpeningReportingSource(reporting),
          qualifyCanadianOpeningReportingSource({
            ...reporting,
            requestId: randomUUID(),
            reason: "Another qualification request",
          }),
        ]);
        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_ca_opening_reporting_authorities
      where org_id=${f.orgId} and levy_authority_id=${reporting.expectedLevyAuthorityId}`,
              "objects",
            )
          ).length,
          1,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "original reporting enforces feature, permission, entity, source access and expected current upload version without partial certificates",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { reporting } = await qualifyOriginal(f);
        await assert.rejects(
          qualifyCanadianOpeningReportingSource({ ...reporting, allowedSubsidiaryIds: new Set() }),
          /outside your payroll authority/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update user_permission_overrides set effect='deny'
      where org_id=${f.orgId} and user_id=${f.actorId} and permission='payroll.run' returning user_id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          qualifyCanadianOpeningReportingSource(reporting),
          /Payroll run permission/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update user_permission_overrides set effect='grant'
      where org_id=${f.orgId} and user_id=${f.actorId} and permission='payroll.run' returning user_id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedPayrollSettings(f.orgId, { features: { payroll: false } });
        await assert.rejects(
          qualifyCanadianOpeningReportingSource(reporting),
          /Payroll feature is disabled/,
        );
        await seedPayrollSettings(f.orgId, { features: { payroll: true } });
        const newVersion = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
      values (${newVersion},${reporting.sourceFileId},2,1,'application/json',${"a".repeat(64)},${f.actorId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update files set current_version_id=${newVersion}
      where org_id=${f.orgId} and id=${reporting.sourceFileId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          qualifyCanadianOpeningReportingSource(reporting),
          /current exact original Cabinet version uploaded/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update folders set owner_id=null where org_id=${f.orgId}
      and id=(select folder_id from files where org_id=${f.orgId} and id=${reporting.sourceFileId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(qualifyCanadianOpeningReportingSource(reporting), (error) =>
          errorChainMatches(error, /Source file is unavailable to this operator/),
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_ca_opening_reporting_authorities where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_ca_opening_reporting_allocations where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
