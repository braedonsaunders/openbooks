import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { seedAdoption, seedUsEinAccount, type AdoptionFixture } from "./filing-test-fixtures.ts";
import { saveOpeningBalances } from "./opening-balances.ts";
import {
  qualifyOpeningEmployerAuthority,
  readOpeningEmployerContext,
} from "./opening-employer-authority.ts";
import {
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
  type OpeningLevySourceAllocationInput,
} from "./opening-levy-source-authority.ts";
import {
  readEmployeeOpeningLevySources,
  employeeOpeningLevyAmount,
} from "./opening-levy-source-reader.ts";
import { t4Slips, w2Slips, form941Worksheet } from "./yearend.ts";
import {
  qualifyCanadianOpeningReportingSource,
  readCanadianOpeningReportingSourceContext,
} from "./canada/opening-reporting-authority.ts";
import type { CanadianOpeningReportingAllocation } from "./canada/opening-reporting-source.ts";
import { rl1Slips } from "./canada/quebec/rl1.ts";
import type { OpeningLevySourceFacts } from "./opening-levy-source-facts.ts";
const skip = !process.env.OPENBOOKS_DB_URL;

async function setup() {
  const f = await seedAdoption();
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  return f;
}

const caAllocations: OpeningLevySourceAllocationInput[] = [
  ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
    (region) => ({ programKey: "ca_wcb" as const, region, federalAccountId: null, amount: "0" }),
  ),
  ...["BC", "MB", "NL", "ON"].map((region) => ({
    programKey: "ca_eht" as const,
    region,
    federalAccountId: null,
    amount: "0",
  })),
  { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: "0" },
];

async function retainOriginalFile(f: AdoptionFixture, evidence: unknown) {
  const sourceFileId = randomUUID(),
    sourceVersionId = randomUUID(),
    folderId = randomUUID();
  const bytes = Buffer.from(JSON.stringify(evidence));
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folderId},${f.orgId},'Original payroll report',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${sourceFileId},${f.orgId},${folderId},'original-payroll.json','application/json',${bytes.length},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${sourceVersionId},${sourceFileId},1,${bytes.length},'application/json',${sourceSha256},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes)
    values(${sourceVersionId},${bytes}) returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${sourceVersionId}
    where org_id=${f.orgId} and id=${sourceFileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return { sourceFileId, sourceVersionId, sourceSha256, folderId };
}

/** The Cabinet packet supplies the attested facts; native reads supply optimistic source digests. */
async function openingPacket(
  f: AdoptionFixture,
  amounts: Record<string, string>,
  facts: OpeningLevySourceFacts,
  allocations: readonly OpeningLevySourceAllocationInput[],
) {
  const file = await retainOriginalFile(f, {
    employeePartyId: f.employeeId,
    subsidiaryId: f.subsidiaryId,
    taxYear: 2026,
    amounts,
    ...facts,
    allocations,
  });
  const { sourceFileId, sourceVersionId, sourceSha256, folderId } = file;
  const contextInput = {
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    sourceFileId,
    allowedSubsidiaryIds: null,
  };
  const employer = await readOpeningEmployerContext(contextInput);
  const levy = await readOpeningLevySourceContext(contextInput);
  assert.ok(employer.record);
  assert.ok(levy.record);
  assert.ok(employer.source);
  assert.ok(levy.source);
  assert.equal(employer.record.id, levy.record.openingBalanceId);
  assert.equal(employer.source.sha256, sourceSha256);
  assert.equal(levy.source.versionId, sourceVersionId);
  return {
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: employer.record.id,
    expectedOpeningSha256: employer.record.openingSha256,
    expectedOpeningChildrenSha256: levy.record.openingChildrenSha256,
    sourceFileId,
    sourceVersionId,
    sourceSha256,
    folderId,
    ...facts,
    allocations,
    sourceReference: "Complete original legal-employer statutory year-to-date report",
    reason: "Retain the original country, currency, employer and statutory coverage",
    allowedSubsidiaryIds: null,
  };
}

async function qualifyOriginalReporting(
  f: AdoptionFixture,
  packet: Awaited<ReturnType<typeof openingPacket>>,
  levy: Awaited<ReturnType<typeof qualifyOpeningLevySourceAuthority>>,
) {
  const filingAccountId = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,country,program_type,account_number,name,subsidiary_id,created_by,updated_by)
    values (${filingAccountId},${f.orgId},'CA','ca_rp','123456789RP0001','Original RP',${f.subsidiaryId},${f.actorId},${f.actorId})
    returning id`,
        "objects",
      )
    ).length,
    1,
  );
  const context = await readCanadianOpeningReportingSourceContext({
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    allowedSubsidiaryIds: null,
  });
  assert.ok(context.original.children);
  const allocations: CanadianOpeningReportingAllocation[] = [
    {
      sourceOrdinal: 1,
      firstCoveredPayDate: "2026-01-15",
      filingAccountId,
      province: "ON",
      annualAmounts: context.original.annualAmounts,
      reportableBases: { ei: "0", cpp: "0", qpip: "0" },
      children: context.original.children,
    },
  ];
  const file = await retainOriginalFile(f, {
    employeePartyId: f.employeeId,
    subsidiaryId: f.subsidiaryId,
    taxYear: 2026,
    coverageStart: packet.coverageStart,
    coverageEnd: packet.coverageEnd,
    allocations,
  });
  await qualifyCanadianOpeningReportingSource({
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: packet.openingBalanceId,
    requestId: randomUUID(),
    expectedLevyAuthorityId: levy.id,
    expectedLevyAllocationSha256: levy.allocationSha256,
    expectedOpeningSha256: packet.expectedOpeningSha256,
    expectedOpeningChildrenSha256: packet.expectedOpeningChildrenSha256,
    ...file,
    sourceReference: "Original Ontario RP year-to-date reporting allocation",
    reason: "Retain exact original RP and province independently of current employment",
    allocations,
    allowedSubsidiaryIds: null,
  });
  return filingAccountId;
}

const canadianAmounts: Record<string, string>[] = [
  { taxableYtd: "12000", taxYtd: "125" },
  { taxableYtd: "12000" },
  { employerCppYtd: "75", employerEiYtd: "25" },
];
for (const amounts of canadianAmounts) {
  test(
    `native original Canadian opening retains its amounts after country and owner changes: ${JSON.stringify(amounts)}`,
    { skip },
    async () => {
      const f = await withBypassContext(setup);
      try {
        await withOrgContext(f.orgId, async () => {
          const saved = await saveOpeningBalances({
            orgId: f.orgId,
            actorId: f.actorId,
            taxYear: 2026,
            rows: [{ employeePartyId: f.employeeId, amounts }],
          });
          assert.deepEqual(saved.errors, []);
          for (const read of [t4Slips, w2Slips, form941Worksheet]) {
            await assert.rejects(read(f.orgId, 2026), /original opening source|source-qualified/);
          }
          const facts: OpeningLevySourceFacts = {
            originalCountry: "CA",
            originalCurrency: "CAD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-06-30",
            coverageComplete: true,
          };
          const packet = await openingPacket(f, amounts, facts, caAllocations);
          await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: f.subsidiaryId });
          await assert.rejects(t4Slips(f.orgId, 2026), /statutory levy source allocation/);
          await assert.rejects(
            qualifyOpeningLevySourceAuthority({ ...packet, originalCountry: "" }),
            /original country and statutory currency/,
          );
          await assert.rejects(
            qualifyOpeningLevySourceAuthority({
              ...packet,
              expectedOpeningChildrenSha256: "f".repeat(64),
            }),
            /amounts changed/,
          );
          assert.equal(
            (
              await db.execute(
                sql`update folders set owner_id=null
        where org_id=${f.orgId} and id=${packet.folderId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          await assert.rejects(qualifyOpeningLevySourceAuthority(packet), (error) =>
            errorChainMatches(error, /Source file is unavailable to this operator/),
          );
          assert.equal(
            (
              await db.execute(
                sql`update folders set owner_id=${f.actorId}
        where org_id=${f.orgId} and id=${packet.folderId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const qualified = await qualifyOpeningLevySourceAuthority(packet);
          assert.deepEqual(
            await qualifyOpeningLevySourceAuthority(packet),
            qualified,
            "the exact retained packet replays idempotently",
          );
          const original = await readEmployeeOpeningLevySources(db, {
            orgId: f.orgId,
            employeePartyId: f.employeeId,
            taxYear: 2026,
          });
          assert.deepEqual(original.facts, facts);
          assert.equal(original.authority?.sourceSha256, packet.sourceSha256);
          assert.equal(original.authority?.sourceVersionId, packet.sourceVersionId);
          assert.equal(original.authority?.openingSha256, packet.expectedOpeningSha256);
          await assert.rejects(
            t4Slips(f.orgId, 2026),
            /current Canadian original reporting source is missing/,
          );
          await assert.rejects(
            rl1Slips(f.orgId, 2026),
            /current Canadian original reporting source is missing/,
          );
          const originalRp = await qualifyOriginalReporting(f, packet, qualified);
          const before = await t4Slips(f.orgId, 2026);
          assert.equal(before.length, 1);
          assert.equal(before[0]!.province, "ON");
          assert.equal(before[0]!.filingAccountId, originalRp);
          assert.equal(
            before[0]!.box14EmploymentIncome,
            amounts.taxableYtd ? "12000.0000" : "0.0000",
          );
          assert.equal(before[0]!.box22IncomeTax, amounts.taxYtd ? "125.0000" : "0.0000");
          assert.equal(before[0]!.employerCpp, amounts.employerCppYtd ? "75.0000" : "0.0000");
          assert.equal(before[0]!.employerEi, amounts.employerEiYtd ? "25.0000" : "0.0000");
          const successor = randomUUID();
          assert.equal(
            (
              await db.execute(
                sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${successor},${f.orgId},${f.subsidiaryId},'Successor legal employer','USD','US') returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const employment = await seedWorkerEmployment(f.orgId, f.employeeId, successor);
          assert.equal(
            (
              await db.execute(
                sql`update parties set subsidiary_id=${successor}
        where org_id=${f.orgId} and id=${f.employeeId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          assert.equal(
            (
              await db.execute(
                sql`update employee_payroll_profiles set country='US',province='TX',employment_id=${employment}
        where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
                "objects",
              )
            ).length,
            1,
          );
          assert.deepEqual(await t4Slips(f.orgId, 2026), before);
          assert.deepEqual(
            await rl1Slips(f.orgId, 2026),
            [],
            "the original Ontario source remains outside Québec reporting",
          );
          assert.deepEqual(await w2Slips(f.orgId, 2026), []);
          assert.deepEqual(
            await readEmployeeOpeningLevySources(db, {
              orgId: f.orgId,
              employeePartyId: f.employeeId,
              taxYear: 2026,
            }),
            original,
          );
          assert.equal(
            (
              await db.execute(
                sql`delete from employee_payroll_profiles
        where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
                "objects",
              )
            ).length,
            1,
          );
          assert.deepEqual(await t4Slips(f.orgId, 2026), before);
          await assert.rejects(
            qualifyOpeningLevySourceAuthority({
              ...packet,
              allowedSubsidiaryIds: new Set([successor]),
            }),
            /outside your payroll authority/,
          );
          const audits = await db.execute<{ table_name: string; n: number }>(
            sql`select table_name,count(*)::int as n from audit_log
        where org_id=${f.orgId} and table_name in ('payroll_opening_employer_authorities','payroll_opening_levy_source_authorities')
        group by table_name order by table_name`,
            "objects",
          );
          assert.deepEqual(audits, [
            { table_name: "payroll_opening_employer_authorities", n: 1 },
            { table_name: "payroll_opening_levy_source_authorities", n: 1 },
          ]);
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      }
    },
  );
}

test(
  "native original US opening retains its inactive EIN after a current country and owner move",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        assert.equal(
          (
            await db.execute(
              sql`update subsidiaries set country='US',base_currency='USD'
      where org_id=${f.orgId} and id=${f.subsidiaryId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const ein = await seedUsEinAccount(f.orgId, f.actorId, f.subsidiaryId, "12-3456789");
        const amounts = { taxableYtd: "34000", taxYtd: "1250" };
        assert.deepEqual(
          (
            await saveOpeningBalances({
              orgId: f.orgId,
              actorId: f.actorId,
              taxYear: 2026,
              rows: [{ employeePartyId: f.employeeId, amounts }],
            })
          ).errors,
          [],
        );
        const packet = await openingPacket(
          f,
          amounts,
          {
            originalCountry: "US",
            originalCurrency: "USD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-06-30",
            coverageComplete: true,
          },
          [
            {
              programKey: "us_futa",
              region: "US",
              filingAccountId: ein,
              federalAccountId: ein,
              amount: "0",
            },
          ],
        );
        await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: f.subsidiaryId });
        await qualifyOpeningLevySourceAuthority(packet);
        const before = await w2Slips(f.orgId, 2026);
        assert.equal(before.length, 1);
        assert.equal(before[0]!.filingAccountId, ein);
        assert.equal(before[0]!.box1Wages, "34000.0000");
        assert.equal(before[0]!.box2FederalIncomeTax, "1250.0000");
        const successor = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${successor},${f.orgId},${f.subsidiaryId},'Canadian successor employer','CAD','CA') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const employment = await seedWorkerEmployment(f.orgId, f.employeeId, successor);
        assert.equal(
          (
            await db.execute(
              sql`update parties set subsidiary_id=${successor}
      where org_id=${f.orgId} and id=${f.employeeId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set country='CA',province='QC',employment_id=${employment}
      where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update payroll_filing_accounts set is_active=false
      where org_id=${f.orgId} and id=${ein} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.deepEqual(await w2Slips(f.orgId, 2026), before);
        assert.deepEqual(await t4Slips(f.orgId, 2026), []);
        assert.deepEqual(
          await rl1Slips(f.orgId, 2026),
          [],
          "a current Québec profile cannot turn original US wages into an RL-1 opening",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test("an all-zero unsigned opening is inert for every year-end population", { skip }, async () => {
  const f = await withBypassContext(setup);
  try {
    await withOrgContext(f.orgId, async () => {
      assert.deepEqual(
        (
          await saveOpeningBalances({
            orgId: f.orgId,
            actorId: f.actorId,
            taxYear: 2026,
            rows: [
              {
                employeePartyId: f.employeeId,
                amounts: { taxableYtd: "0", taxYtd: "0", employerCppYtd: "0" },
              },
            ],
          })
        ).errors,
        [],
      );
      for (const read of [t4Slips, w2Slips, form941Worksheet])
        assert.deepEqual(await read(f.orgId, 2026), []);
    });
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(f.orgId));
  }
});

test(
  "a source-qualified CNT carry-in is retained exactly beside the remuneration it was assessed on",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        // CNT is assessed on remuneration the original employer paid, so its
        // carry-in is certified on the opening that records that remuneration.
        // An all-zero carry-in records no opening and so cannot anchor one.
        assert.deepEqual(
          (
            await saveOpeningBalances({
              orgId: f.orgId,
              actorId: f.actorId,
              taxYear: 2026,
              rows: [{ employeePartyId: f.employeeId, amounts: { taxableYtd: "0" } }],
            })
          ).errors,
          [],
        );
        assert.equal(
          (
            await readOpeningEmployerContext({
              orgId: f.orgId,
              actorId: f.actorId,
              employeePartyId: f.employeeId,
              taxYear: 2026,
              allowedSubsidiaryIds: null,
            })
          ).record,
          null,
        );
        const amounts = { taxableYtd: "725.25" };
        assert.deepEqual(
          (
            await saveOpeningBalances({
              orgId: f.orgId,
              actorId: f.actorId,
              taxYear: 2026,
              rows: [{ employeePartyId: f.employeeId, amounts }],
            })
          ).errors,
          [],
        );
        const allocations = caAllocations.map((row) =>
          row.programKey === "ca_cnt" ? { ...row, amount: "725.25" } : row,
        );
        const packet = await openingPacket(
          f,
          amounts,
          {
            originalCountry: "CA",
            originalCurrency: "CAD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-06-30",
            coverageComplete: true,
          },
          allocations,
        );
        await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: f.subsidiaryId });
        await qualifyOpeningLevySourceAuthority(packet);
        const source = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
        });
        assert.equal(source.hasMaterialHistory, true);
        assert.equal(
          employeeOpeningLevyAmount(source, { programKey: "ca_cnt", region: "QC" }),
          "725.2500",
        );
        assert.equal(
          employeeOpeningLevyAmount(source, { programKey: "ca_wcb", region: "QC" }),
          "0.0000",
          "the CNT carry-in is not workers-compensation assessable history",
        );
        assert.equal(
          source.openingSnapshot?.taxable_ytd,
          "725.2500",
          "the levy certificate leaves the retained annual amounts unchanged",
        );
        await assert.rejects(
          t4Slips(f.orgId, 2026),
          /current Canadian original reporting source is missing/,
          "the remuneration stays reportable only through its qualified original RP and province allocation",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
