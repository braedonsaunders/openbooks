import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../../testing/fixtures.ts";
import { seedAdoption, seedUsEinAccount, type AdoptionFixture } from "../filing-test-fixtures.ts";
import {
  readOpeningEmployerContext,
  qualifyOpeningEmployerAuthority,
} from "../opening-employer-authority.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { prepareWithholdingRecordWrite } from "../withholding-record-write.ts";
import { saveOpeningBalances } from "../opening-balances.ts";
import { mutatePayRunAdjustment } from "../run-adjustments.ts";
import {
  readOpeningLevySourceContext,
  qualifyOpeningLevySourceAuthority,
  type OpeningLevySourceAllocationInput,
} from "../opening-levy-source-authority.ts";
import type { OpeningLevySourceFacts } from "../opening-levy-source-facts.ts";

const canadianAllocations: OpeningLevySourceAllocationInput[] = [
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
async function qualifyImportedOpening(
  f: AdoptionFixture,
  employerId = f.subsidiaryId,
  facts: OpeningLevySourceFacts = {
    originalCountry: "CA",
    originalCurrency: "CAD",
    coverageStart: "2026-01-01",
    coverageEnd: "2026-09-29",
    coverageComplete: true,
  },
  allocations: readonly OpeningLevySourceAllocationInput[] = canadianAllocations,
) {
  const original = await db.execute<{ report: string }>(
    sql`select jsonb_build_object(
    'legalEmployerId',${employerId}::text,'originalOpening',to_jsonb(b),
    'originalSourceFacts',${JSON.stringify(facts)}::jsonb,'allocations',${JSON.stringify(allocations)}::jsonb)::text as report
    from payroll_opening_balances b where b.org_id=${f.orgId} and b.employee_party_id=${f.employeeId} and b.tax_year=2026`,
    "objects",
  );
  assert.equal(original.length, 1);
  const bytes = Buffer.from(original[0]!.report),
    sha = createHash("sha256").update(bytes).digest("hex");
  const folder = randomUUID(),
    file = randomUUID(),
    version = randomUUID();
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values(${folder},${f.orgId},'Original averaging reports',true,${f.actorId},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values(${file},${f.orgId},${folder},'original-averaging-opening.json','application/json',${bytes.length},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values(${version},${file},1,${bytes.length},'application/json',${sha},${f.actorId})`);
  await db.execute(sql`insert into file_blobs(version_id,bytes) values(${version},${bytes})`);
  await db.execute(
    sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file}`,
  );
  const contextInput = {
    orgId: f.orgId,
    actorId: f.actorId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    sourceFileId: file,
    allowedSubsidiaryIds: null,
  };
  const context = await readOpeningEmployerContext(contextInput);
  const sourceContext = await readOpeningLevySourceContext(contextInput);
  assert.ok(context.record);
  assert.ok(sourceContext.record);
  assert.equal(context.record.id, sourceContext.record.openingBalanceId);
  await qualifyOpeningEmployerAuthority({
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: context.record.id,
    subsidiaryId: employerId,
    expectedOpeningSha256: context.record.openingSha256,
    sourceFileId: file,
    sourceVersionId: version,
    sourceSha256: sha,
    sourceReference: "Original employer income and withholding report",
    reason: "Qualify imported employer averaging history",
    allowedSubsidiaryIds: null,
  });
  await qualifyOpeningLevySourceAuthority({
    ...facts,
    allocations,
    orgId: f.orgId,
    actorId: f.actorId,
    openingBalanceId: context.record.id,
    expectedOpeningSha256: context.record.openingSha256,
    expectedOpeningChildrenSha256: sourceContext.record.openingChildrenSha256,
    sourceFileId: file,
    sourceVersionId: version,
    sourceSha256: sha,
    sourceReference: "Original employer income and withholding report",
    reason: "Qualify imported employer averaging history",
    allowedSubsidiaryIds: null,
  });
}

test(
  "elected cumulative withholding consumes committed history and scheduled periods while resets preserve annual contribution ceilings",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    const { orgId, actorId, employeeId, scheduleId } = fixture;
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update pay_schedules set frequency='monthly',periods_per_year=12,anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${orgId} and id=${scheduleId}`,
        );
        await db.execute(
          sql`update employee_payroll_profiles set additional_tax_per_period=10 where org_id=${orgId} and employee_party_id=${employeeId}`,
        );
        await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${orgId},${employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay"}'::jsonb,'2026-01-01',${actorId},${actorId})`);
      });
      await withOrgContext(orgId, async () => {
        const components = await db.execute<{ id: string; system_key: string }>(
          sql`select id,system_key from pay_components where org_id=${orgId} and system_key in ('base_pay','bonus')`,
          "objects",
        );
        const run = async (
          start: string,
          end: string,
          amount: string,
          type: "regular" | "bonus" = "regular",
        ) => {
          const created = await createPayRun({
            orgId,
            actorId,
            payScheduleId: scheduleId,
            periodStart: start,
            periodEnd: end,
            payDate: end,
            runType: type,
          });
          const input = { orgId, actorId, documentId: created.documentId };
          await mutatePayRunAdjustment({
            ...input,
            mutation: {
              action: "add",
              employeePartyId: employeeId,
              componentId: components.find(
                (row) => row.system_key === (type === "bonus" ? "bonus" : "base_pay"),
              )!.id,
              amount,
              idempotencyKey: randomUUID(),
            },
          });
          const result = await calculatePayRun(input);
          assert.deepEqual(result.errors, []);
          const factors = (
            await db.execute<{ factors: Record<string, string> }>(
              sql`select factors from pay_stubs where org_id=${orgId} and pay_run_document_id=${created.documentId}`,
              "objects",
            )
          )[0]!.factors;
          await commitPayRun(input);
          return factors;
        };
        const first = await run("2026-01-01", "2026-01-31", "100000");
        assert.equal(first.S1_DEN, "1.0000");
        assert.equal(first.C, "4230.4500");
        assert.equal(first.EI, "1123.0700");
        const second = await run("2026-02-01", "2026-02-28", "1000");
        assert.equal(second.S1_DEN, "2.0000");
        assert.equal(second.T, "10.0000");
        assert.equal(second.M, first.CA_T_BASE);
        assert.equal(second.C, "0.0000");
        assert.equal(second.C2, "0.0000");
        assert.equal(second.EI, "0.0000");
        const bonus = await run("2026-03-01", "2026-03-15", "1000", "bonus");
        assert.equal(bonus.S1_DEN, "2.0000");
        assert.equal(bonus.M, first.CA_T_BASE);
        assert.equal(bonus.C, "0.0000");
        assert.equal(bonus.EI, "0.0000");
        const third = await run("2026-03-16", "2026-03-31", "1000");
        assert.equal(third.S1_DEN, "3.0000");
        assert.equal(third.M1, bonus.TB);
        assert.equal(third.M, first.CA_T_BASE);
        // The effective election resets income tax only. It cannot reopen CPP/EI
        // room already consumed and actually committed earlier in this year.
        await assert.rejects(
          withOrgTransaction(orgId, () =>
            prepareWithholdingRecordWrite({
              orgId,
              actorId,
              employeePartyId: employeeId,
              effectiveFrom: "2026-01-01",
              protectCommittedHistory: true,
            }),
          ),
          /already committed.*effective after/,
        );
        const retired = await db.execute(
          sql`update employee_tax_certificates set superseded_on='2026-04-01',updated_by=${actorId},updated_at=now() where org_id=${orgId} and employee_party_id=${employeeId} and certificate_key='ca_t4127_method' and superseded_on is null returning id`,
          "objects",
        );
        assert.equal(retired.length, 1);
        await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${orgId},${employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay"}'::jsonb,'2026-04-01' ,${actorId},${actorId})`);
        const reset = await run("2026-04-01", "2026-04-30", "1000");
        assert.equal(reset.S1_DEN, "1.0000");
        assert.equal(reset.M, "0.0000");
        assert.equal(reset.M1, "0.0000");
        assert.equal(reset.C, "0.0000");
        assert.equal(reset.EI, "0.0000");
        const draft = await createPayRun({
          orgId,
          actorId,
          payScheduleId: scheduleId,
          periodStart: "2026-05-01",
          periodEnd: "2026-05-31",
          payDate: "2026-05-31",
        });
        const command = { orgId, actorId, documentId: draft.documentId };
        await mutatePayRunAdjustment({
          ...command,
          mutation: {
            action: "add",
            employeePartyId: employeeId,
            componentId: components.find((row) => row.system_key === "base_pay")!.id,
            amount: "1000",
          },
        });
        assert.deepEqual((await calculatePayRun(command)).errors, []);
        await withOrgTransaction(orgId, async () => {
          await prepareWithholdingRecordWrite({
            orgId,
            actorId,
            employeePartyId: employeeId,
            effectiveFrom: "2026-05-01",
            protectCommittedHistory: true,
          });
          await db.execute(
            sql`update employee_tax_certificates set superseded_on='2026-05-01',updated_at=clock_timestamp() where org_id=${orgId} and employee_party_id=${employeeId} and certificate_key='ca_t4127_method' and superseded_on is null`,
          );
          await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
          values(${orgId},${employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay"}'::jsonb,'2026-05-01',${actorId},${actorId})`);
        });
        await assert.rejects(commitPayRun(command), /recalculate/i);
        assert.deepEqual((await calculatePayRun(command)).errors, []);
        await commitPayRun(command);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(orgId));
    }
    const imported = await withBypassContext(() => seedAdoption());
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true where org_id=${imported.orgId} and employee_party_id=${imported.employeeId}`,
        );
        await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${imported.orgId},${imported.employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay","window_start":"2026-01-01","opening_history_through":"2026-09-29","opening_history_complete":"true"}'::jsonb,'2026-10-01',${imported.actorId},${imported.actorId})`);
      });
      await withOrgContext(imported.orgId, async () => {
        const saved = await saveOpeningBalances({
          orgId: imported.orgId,
          actorId: imported.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: imported.employeeId,
              amounts: {
                taxableYtd: "20000",
                taxYtd: "1390",
                caAvgIncome: "20000",
                caAvgTaxM: "1390",
              },
            },
          ],
        });
        assert.deepEqual(saved.errors, []);
        assert.equal(saved.created, 1);
        const created = await createPayRun({
          orgId: imported.orgId,
          actorId: imported.actorId,
          payScheduleId: imported.scheduleId,
          periodStart: "2026-09-27",
          periodEnd: "2026-10-10",
          payDate: "2026-10-13",
        });
        const command = {
          orgId: imported.orgId,
          actorId: imported.actorId,
          documentId: created.documentId,
        };
        const component = (
          await db.execute<{ id: string }>(
            sql`select id from pay_components where org_id=${imported.orgId} and system_key='base_pay'`,
            "objects",
          )
        )[0]!;
        await mutatePayRunAdjustment({
          ...command,
          mutation: {
            action: "add",
            employeePartyId: imported.employeeId,
            componentId: component.id,
            amount: "500",
          },
        });
        const missingSource = await calculatePayRun(command);
        assert.equal(missingSource.errors.length, 1);
        assert.match(missingSource.errors[0]!.message, /original opening|source-qualified/);
        await qualifyImportedOpening(imported);
        assert.deepEqual((await calculatePayRun(command)).errors, []);
        const factors = (
          await db.execute<{ factors: Record<string, string> }>(
            sql`select factors from pay_stubs where org_id=${imported.orgId} and pay_run_document_id=${created.documentId}`,
            "objects",
          )
        )[0]!.factors;
        // CRA's 20,000 + 500 at 26/21 gives A=25,380.95 (exactly 25,380.952381,
        // traced at ledger precision). Actual 2026 Ontario tax is 1,965.71;
        // 21/26 gives 1,587.69, less M=1,390.
        assert.equal(factors.S1_DEN, "21.0000");
        assert.equal(factors.A, "25380.9524");
        assert.equal(factors.M, "1390.0000");
        assert.equal(factors.T, "197.6900");
        await commitPayRun(command);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(imported.orgId));
    }
  },
);

test(
  "another legal employer’s qualified imported averaging history cannot reduce current-employer withholding",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await withBypassContext(() => seedAdoption()),
      other = randomUUID();
    try {
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${other},${f.orgId},${f.subsidiaryId},'Prior legal employer','CAD','CA')`);
        await seedWorkerEmployment(f.orgId, f.employeeId, other);
        await db.execute(sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true
        where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
        await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${f.orgId},${f.employeeId},'CA','ca_t4127_method',
        '{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay","window_start":"2026-01-01","opening_history_through":"2026-09-29","opening_history_complete":"true"}'::jsonb,
        '2026-10-01',${f.actorId},${f.actorId})`);
      });
      await withOrgContext(f.orgId, async () => {
        const saved = await saveOpeningBalances({
          orgId: f.orgId,
          actorId: f.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: f.employeeId,
              amounts: {
                taxableYtd: "20000",
                taxYtd: "1390",
                caAvgIncome: "20000",
                caAvgTaxM: "1390",
              },
            },
          ],
        });
        assert.deepEqual(saved.errors, []);
        await qualifyImportedOpening(f, other);
        const original = await db.execute<{ snapshot: string }>(
          sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`,
          "objects",
        );
        const created = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          periodStart: "2026-09-27",
          periodEnd: "2026-10-10",
          payDate: "2026-10-13",
        });
        const command = { orgId: f.orgId, actorId: f.actorId, documentId: created.documentId };
        const component = (
          await db.execute<{ id: string }>(
            sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
            "objects",
          )
        )[0]!;
        await mutatePayRunAdjustment({
          ...command,
          mutation: {
            action: "add",
            employeePartyId: f.employeeId,
            componentId: component.id,
            amount: "500",
          },
        });
        const refused = await calculatePayRun(command);
        assert.equal(refused.errors.length, 1);
        assert.match(
          refused.errors[0]!.message,
          /no qualified original opening for this legal employer/,
        );
        await assert.rejects(commitPayRun(command), /refus|calculat/i);
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from pay_runs where org_id=${f.orgId} and run_status='committed'`,
              "objects",
            )
          )[0]!.n,
          0,
        );
        assert.deepEqual(
          await db.execute<{ snapshot: string }>(
            sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`,
            "objects",
          ),
          original,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

for (const sourceCase of ["foreign-country", "coverage-mismatch"] as const) {
  test(
    `explicit imported Canadian averaging refuses a ${sourceCase} original source`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const f = await withBypassContext(() => seedAdoption());
      try {
        await withOrgContext(f.orgId, async () => {
          await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
          const saved = await saveOpeningBalances({
            orgId: f.orgId,
            actorId: f.actorId,
            taxYear: 2026,
            rows: [
              {
                employeePartyId: f.employeeId,
                amounts: {
                  taxableYtd: "20000",
                  taxYtd: "1390",
                  caAvgIncome: "20000",
                  caAvgTaxM: "1390",
                },
              },
            ],
          });
          assert.deepEqual(saved.errors, []);
          assert.equal(saved.created, 1);
          let allocations = canadianAllocations;
          if (sourceCase === "foreign-country") {
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
            allocations = [
              {
                programKey: "us_futa",
                region: "US",
                filingAccountId: ein,
                federalAccountId: ein,
                amount: "0",
              },
            ];
          }
          await qualifyImportedOpening(
            f,
            f.subsidiaryId,
            {
              originalCountry: sourceCase === "foreign-country" ? "US" : "CA",
              originalCurrency: sourceCase === "foreign-country" ? "USD" : "CAD",
              coverageStart: "2026-01-01",
              coverageEnd: sourceCase === "coverage-mismatch" ? "2026-09-28" : "2026-09-29",
              coverageComplete: true,
            },
            allocations,
          );
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
          assert.equal(
            (
              await db.execute(
                sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true
        where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
                "objects",
              )
            ).length,
            1,
          );
          assert.equal(
            (
              await db.execute(
                sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${f.orgId},${f.employeeId},'CA','ca_t4127_method',
          '{"method":"option2","reason":"Employer elected cumulative withholding for uneven pay","window_start":"2026-01-01","opening_history_through":"2026-09-29","opening_history_complete":"true"}'::jsonb,
          '2026-10-01',${f.actorId},${f.actorId}) returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const created = await createPayRun({
            orgId: f.orgId,
            actorId: f.actorId,
            payScheduleId: f.scheduleId,
            periodStart: "2026-09-27",
            periodEnd: "2026-10-10",
            payDate: "2026-10-13",
          });
          const command = { orgId: f.orgId, actorId: f.actorId, documentId: created.documentId };
          const components = await db.execute<{ id: string }>(
            sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
            "objects",
          );
          assert.equal(components.length, 1);
          await mutatePayRunAdjustment({
            ...command,
            mutation: {
              action: "add",
              employeePartyId: f.employeeId,
              componentId: components[0]!.id,
              amount: "500",
            },
          });
          const refused = await calculatePayRun(command);
          assert.equal(refused.errors.length, 1);
          assert.match(
            refused.errors[0]!.message,
            sourceCase === "foreign-country"
              ? /certified original Canadian-dollar source/
              : /must equal.*certified coverage end/,
          );
          await assert.rejects(commitPayRun(command), /refus|calculat/i);
          assert.equal(
            (
              await db.execute<{ n: number }>(
                sql`select count(*)::int as n from pay_runs where org_id=${f.orgId} and run_status='committed'`,
                "objects",
              )
            )[0]!.n,
            0,
          );
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      }
    },
  );
}
