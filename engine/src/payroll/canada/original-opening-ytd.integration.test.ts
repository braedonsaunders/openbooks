import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../../testing/fixtures.ts";
import { seedAdoption, seedUsEinAccount, type AdoptionFixture } from "../filing-test-fixtures.ts";
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
import {
  readEmployeeOpeningLevySources,
  employeeOpeningLevyAmount,
  requireEmployerOpeningLevySources,
} from "../opening-levy-source-reader.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { employeeYtd, type CanadaYtdRow } from "./compute-statutory.ts";
import type { OpeningLevySourceFacts } from "../opening-levy-source-facts.ts";

const skip = !process.env.OPENBOOKS_DB_URL;
const zero: CanadaYtdRow = {
  pensionable: "0.0000",
  insurable: "0.0000",
  cpp: "0.0000",
  cpp2: "0.0000",
  ei: "0.0000",
  qpip: "0.0000",
  qpip_employer: "0.0000",
  non_periodic: "0.0000",
  pension_deductions_bonus: "0.0000",
  f5b: "0.0000",
  qc_csb: "0.0000",
};
const caAllocations: OpeningLevySourceAllocationInput[] = [
  ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
    (region) => ({ programKey: "ca_wcb", region, federalAccountId: null, amount: "0" }),
  ),
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
async function currentRun(f: AdoptionFixture, payDate = "2026-06-15") {
  const created = await createPayRun({
    orgId: f.orgId,
    actorId: f.actorId,
    payScheduleId: f.scheduleId,
    periodStart: "2026-05-31",
    periodEnd: "2026-06-13",
    payDate,
    runType: "supplemental",
  });
  return {
    tx: db,
    orgId: f.orgId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    documentId: created.documentId,
    subsidiaryId: f.subsidiaryId,
  };
}
async function packet(
  f: AdoptionFixture,
  amounts: Record<string, string>,
  facts: OpeningLevySourceFacts,
  allocations: readonly OpeningLevySourceAllocationInput[],
  subsidiaryId = f.subsidiaryId,
) {
  const folderId = randomUUID(),
    sourceFileId = randomUUID(),
    sourceVersionId = randomUUID();
  const bytes = Buffer.from(
    JSON.stringify({
      employeePartyId: f.employeeId,
      subsidiaryId,
      taxYear: 2026,
      amounts,
      ...facts,
      allocations,
    }),
  );
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folderId},${f.orgId},'Original statutory report',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${sourceFileId},${f.orgId},${folderId},'original-opening.json','application/json',${bytes.length},${f.actorId},${f.actorId}) returning id`,
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
        sql`insert into file_blobs(version_id,bytes) values(${sourceVersionId},${bytes}) returning version_id`,
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
  const input = {
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    sourceFileId,
    allowedSubsidiaryIds: null,
  };
  const employer = await readOpeningEmployerContext(input),
    levy = await readOpeningLevySourceContext(input);
  assert.ok(employer.record);
  assert.ok(levy.record);
  assert.equal(employer.record.id, levy.record.openingBalanceId);
  return {
    ...input,
    sourceVersionId,
    sourceSha256,
    subsidiaryId,
    openingBalanceId: employer.record.id,
    expectedOpeningSha256: employer.record.openingSha256,
    expectedOpeningChildrenSha256: levy.record.openingChildrenSha256,
    ...facts,
    allocations,
    sourceReference: "Complete original-country statutory year-to-date report",
    reason: "Certify the original legal payer, country and complete statutory coverage",
  };
}
async function save(f: AdoptionFixture, amounts: Record<string, string>) {
  const result = await saveOpeningBalances({
    orgId: f.orgId,
    actorId: f.actorId,
    taxYear: 2026,
    rows: [{ employeePartyId: f.employeeId, amounts }],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.created, 1);
}

for (const originalCountry of ["CA", "US"] as const) {
  test(
    `native ${originalCountry} original source controls Canadian annual room for the same legal payer`,
    { skip },
    async () => {
      const f = await withBypassContext(setup);
      try {
        await withOrgContext(f.orgId, async () => {
          const amounts = {
            pensionableYtd: "12345.6789",
            insurableYtd: "9876.5432",
            taxableYtd: "13000.0001",
            nonPeriodicYtd: "123.4567",
            ...(originalCountry === "CA"
              ? {
                  cppYtd: "123.4567",
                  cpp2Ytd: "11.0001",
                  eiYtd: "23.4567",
                  qpipYtd: "12.3456",
                  qpipEmployerYtd: "17.0001",
                  nonPeriodicPensionDeductionsYtd: "10.0001",
                  cpp2BonusYtd: "1.0001",
                  qcCsbYtd: "2.0001",
                }
              : {}),
          };
          await save(f, amounts);
          let allocations = caAllocations;
          if (originalCountry === "US") {
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
            // The original US report states its unemployment wages for FUTA and
            // for the state that taxed them.
            allocations = [
              {
                programKey: "us_futa",
                region: "US",
                filingAccountId: ein,
                federalAccountId: ein,
                amount: amounts.insurableYtd,
              },
              {
                programKey: "us_sui",
                region: "TX",
                filingAccountId: null,
                federalAccountId: ein,
                amount: amounts.insurableYtd,
              },
            ];
          }
          const certified = await packet(
            f,
            amounts,
            {
              originalCountry,
              originalCurrency: originalCountry === "CA" ? "CAD" : "USD",
              coverageStart: "2026-01-01",
              coverageEnd: "2026-05-30",
              coverageComplete: true,
            },
            allocations,
          );
          await qualifyOpeningEmployerAuthority(certified);
          await assert.rejects(
            readEmployeeOpeningLevySources(db, {
              orgId: f.orgId,
              employeePartyId: f.employeeId,
              taxYear: 2026,
              subsidiaryId: f.subsidiaryId,
            }),
            /no complete statutory levy source allocation/,
          );
          await qualifyOpeningLevySourceAuthority(certified);
          assert.equal(
            (
              await db.execute(
                sql`update subsidiaries set country='CA',base_currency='CAD'
        where org_id=${f.orgId} and id=${f.subsidiaryId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const current = await currentRun(f);
          const expected =
            originalCountry === "US"
              ? zero
              : {
                  pensionable: "12345.6789",
                  insurable: "9876.5432",
                  cpp: "123.4567",
                  cpp2: "11.0001",
                  ei: "23.4567",
                  qpip: "12.3456",
                  qpip_employer: "17.0001",
                  non_periodic: "123.4567",
                  pension_deductions_bonus: "10.0001",
                  f5b: "1.0001",
                  qc_csb: "2.0001",
                };
          assert.deepEqual(await employeeYtd(current), expected);
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
          assert.deepEqual(
            await employeeYtd(current),
            expected,
            "current country, currency and profile cannot reinterpret the original source",
          );
          await assert.rejects(
            employeeYtd({ ...current, subsidiaryId: randomUUID() }),
            /actual pay-run legal employer/,
          );
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      }
    },
  );
}

test(
  "native material tax-only history refuses without original payer and country certification",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        await save(f, { taxableYtd: "125.0001", taxYtd: "12.0001" });
        const current = await currentRun(f);
        await assert.rejects(employeeYtd(current), /opening payer is not source-qualified/);
        const certified = await packet(
          f,
          { taxableYtd: "125.0001", taxYtd: "12.0001" },
          {
            originalCountry: "CA",
            originalCurrency: "CAD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-05-30",
            coverageComplete: true,
          },
          caAllocations,
        );
        await qualifyOpeningEmployerAuthority(certified);
        await assert.rejects(employeeYtd(current), /no complete statutory levy source allocation/);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "native Canadian opening for another original legal payer contributes no current-employer prior",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const other = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${other},${f.orgId},${f.subsidiaryId},'Prior legal payer','CAD','CA') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedWorkerEmployment(f.orgId, f.employeeId, other);
        const amounts = {
          pensionableYtd: "12345.6789",
          insurableYtd: "9876.5432",
          taxableYtd: "13000.0001",
          nonPeriodicYtd: "123.4567",
        };
        await save(f, amounts);
        const certified = await packet(
          f,
          amounts,
          {
            originalCountry: "CA",
            originalCurrency: "CAD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-05-30",
            coverageComplete: true,
          },
          caAllocations,
          other,
        );
        await qualifyOpeningEmployerAuthority(certified);
        await qualifyOpeningLevySourceAuthority(certified);
        assert.deepEqual(await employeeYtd(await currentRun(f)), zero);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "a retained unsigned all-zero native opening is inert for Canadian statutory YTD",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_opening_balances(org_id,employee_party_id,tax_year,created_by,updated_by)
      values(${f.orgId},${f.employeeId},2026,${f.actorId},${f.actorId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const original = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          subsidiaryId: f.subsidiaryId,
          beforeDate: "2026-06-15",
        });
        assert.equal(original.hasOpening, true);
        assert.equal(original.hasMaterialHistory, false);
        assert.equal(original.facts, null);
        assert.equal(
          employeeOpeningLevyAmount(original, { programKey: "ca_wcb", region: "ON" }),
          "0",
        );
        const employer = {
          orgId: f.orgId,
          subsidiaryId: f.subsidiaryId,
          taxYear: 2026,
          beforeDate: "2026-06-15",
          programKey: "ca_eht" as const,
          region: "ON",
        };
        assert.equal(await requireEmployerOpeningLevySources(db, employer), "0");
        const certified = await packet(
          f,
          {},
          {
            originalCountry: "CA",
            originalCurrency: "CAD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-05-30",
            coverageComplete: true,
          },
          caAllocations,
        );
        await qualifyOpeningEmployerAuthority(certified);
        assert.equal(
          await requireEmployerOpeningLevySources(db, employer),
          "0",
          "certifying an empty payer does not require non-existent levy history",
        );
        assert.deepEqual(await employeeYtd(await currentRun(f)), zero);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "Canadian opening coverage must end before the actual persisted run pay date",
  { skip },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const amounts = { pensionableYtd: "123.4567", insurableYtd: "123.4567" };
        await save(f, amounts);
        const certified = await packet(
          f,
          amounts,
          {
            originalCountry: "CA",
            originalCurrency: "CAD",
            coverageStart: "2026-01-01",
            coverageEnd: "2026-06-15",
            coverageComplete: true,
          },
          caAllocations,
        );
        await qualifyOpeningEmployerAuthority(certified);
        await qualifyOpeningLevySourceAuthority(certified);
        await assert.rejects(
          employeeYtd(await currentRun(f)),
          /covers this payroll date or a later date/,
        );
        assert.equal(
          (await employeeYtd(await currentRun(f, "2026-06-16"))).pensionable,
          "123.4567",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
