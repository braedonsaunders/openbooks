import { seedPayrollDocument, seedPayrollStub } from "../testing/fixtures.ts";
import {
  seedPayrollSchedule,
  seedPayrollPerson,
  seedPayrollProfile,
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
  seedPayrollSettings,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
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
  qualifyCanadianOpeningReportingSource,
  readCanadianOpeningReportingSourceContext,
} from "./canada/opening-reporting-authority.ts";
import { readEmployeeCanadianOpeningReportingSource } from "./canada/opening-reporting-reader.ts";
import type { CanadianOpeningReportingAllocation } from "./canada/opening-reporting-source.ts";
import { rl1Return, rl1Slips, rl1Summary } from "./canada/quebec/rl1.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function waitUntilBlockedBy(blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and $1 = any(pg_blocking_pids(pid))
        order by pid limit 1`,
      [blockerPid],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`The native reporting or opening command did not wait for backend ${blockerPid}`);
}

/** Native reporting reads source-qualified Québec allocations and committed payroll together. */
type QcFixture = {
  orgId: string;
  actorId: string;
  qcStubEmployee: string;
  qcOpeningOnlyEmployee: string;
  onOpeningOnlyEmployee: string;
};

const facts = {
  originalCountry: "CA",
  originalCurrency: "CAD",
  coverageStart: "2026-01-01",
  coverageEnd: "2026-06-30",
  coverageComplete: true,
} as const;
const levies: OpeningLevySourceAllocationInput[] = [
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

async function retainOriginalFile(orgId: string, actorId: string, evidence: unknown) {
  const sourceFileId = randomUUID(),
    sourceVersionId = randomUUID(),
    folderId = randomUUID();
  const bytes = Buffer.from(JSON.stringify(evidence));
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
    values (${folderId},${orgId},'Original payroll evidence',true,${actorId},${actorId},${actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
    values (${sourceFileId},${orgId},${folderId},'original-payroll.json','application/json',${bytes.length},${actorId},${actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
    values (${sourceVersionId},${sourceFileId},1,${bytes.length},'application/json',${sourceSha256},${actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes)
    values (${sourceVersionId},${bytes}) returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update files set current_version_id=${sourceVersionId}
    where org_id=${orgId} and id=${sourceFileId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return { sourceFileId, sourceVersionId, sourceSha256 };
}

async function qualifyOpening(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  employeePartyId: string,
  filingAccountId: string,
  province: string,
  taxable: string,
  pensionable: string,
  qpipBase: string,
) {
  await withOrgContext(orgId, async () => {
    const amounts = {
      pensionableYtd: pensionable,
      insurableYtd: "9000",
      cppYtd: "500",
      cpp2Ytd: "50",
      eiYtd: "100",
      qpipYtd: province === "QC" ? "40" : "0",
      taxableYtd: taxable,
      taxYtd: "1500",
      qcTaxYtd: province === "QC" ? "125" : "0",
      unionDuesYtd: "75",
    };
    const programs = province === "QC" ? { qpip: qpipBase } : {};
    const saved = await saveOpeningBalances({
      orgId,
      actorId,
      taxYear: 2026,
      rows: [{ employeePartyId, amounts, programs }],
    });
    assert.deepEqual(saved.errors, []);
    assert.equal(saved.created, 1);
    const file = await retainOriginalFile(orgId, actorId, {
      employeePartyId,
      subsidiaryId,
      taxYear: 2026,
      ...facts,
      amounts,
      programs,
      levies,
    });
    const contextInput = {
      orgId,
      actorId,
      employeePartyId,
      taxYear: 2026,
      allowedSubsidiaryIds: null,
    };
    const employer = await readOpeningEmployerContext({
      ...contextInput,
      sourceFileId: file.sourceFileId,
    });
    const levyContext = await readOpeningLevySourceContext(contextInput);
    assert.ok(employer.record);
    assert.ok(levyContext.record);
    const packet = {
      orgId,
      actorId,
      openingBalanceId: employer.record.id,
      expectedOpeningSha256: employer.record.openingSha256,
      expectedOpeningChildrenSha256: levyContext.record.openingChildrenSha256,
      ...facts,
      ...file,
      allocations: levies,
      sourceReference: "Complete original Canadian payroll report",
      reason: "Retain exact original payroll ownership and statutory coverage",
      allowedSubsidiaryIds: null,
    };
    await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId });
    const levy = await qualifyOpeningLevySourceAuthority(packet);
    const context = await readCanadianOpeningReportingSourceContext(contextInput);
    assert.ok(context.original.children);
    const allocations: CanadianOpeningReportingAllocation[] = [
      {
        sourceOrdinal: 1,
        firstCoveredPayDate: "2026-01-15",
        filingAccountId,
        province,
        annualAmounts: context.original.annualAmounts,
        reportableBases: { ei: "9000", cpp: pensionable, qpip: qpipBase },
        children: context.original.children,
      },
    ];
    const reportingFile = await retainOriginalFile(orgId, actorId, {
      employeePartyId,
      subsidiaryId,
      taxYear: 2026,
      ...facts,
      allocations,
    });
    const reporting = await qualifyCanadianOpeningReportingSource({
      orgId,
      actorId,
      openingBalanceId: packet.openingBalanceId,
      requestId: randomUUID(),
      expectedLevyAuthorityId: levy.id,
      expectedLevyAllocationSha256: levy.allocationSha256,
      expectedOpeningSha256: packet.expectedOpeningSha256,
      expectedOpeningChildrenSha256: packet.expectedOpeningChildrenSha256,
      ...reportingFile,
      sourceReference: "Original RP and province payroll allocation",
      reason: "Preserve exact original reporting amounts and capped bases",
      allocations,
      allowedSubsidiaryIds: null,
    });
    assert.equal(
      (await readEmployeeCanadianOpeningReportingSource(db, contextInput)).authority?.id,
      reporting.id,
    );
  });
}

async function seedQcYear(): Promise<QcFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await seedPayrollSettings(org.orgId, { features: { payroll: true } });
  assert.equal(
    (
      await db.execute(
        sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
    values (${org.orgId},${actorId},'payroll.read','grant'),(${org.orgId},${actorId},'payroll.run','grant') returning user_id`,
        "objects",
      )
    ).length,
    2,
  );
  const filingAccountId = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,country,program_type,account_number,name,subsidiary_id,created_by,updated_by)
    values (${filingAccountId},${org.orgId},'CA','ca_rp','123456789RP0001','Original RP',${org.subsidiaryId},${actorId},${actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );

  // Employee elections reference the scenario's declared vacation program;
  // tax profiles do not provision organization policy implicitly.
  await db.execute(sql`
    insert into entitlement_plans (org_id, code, system_key, name, unit, direction,
                                   accrual_method, accrual_value, cap_behavior, is_active,
                                   created_by, updated_by)
    values (${org.orgId}, 'VAC', 'vacation', 'Vacation', 'money', 'accrue',
            'percent_of_earnings', '4.0000', 'warn', true, ${actorId}, ${actorId})`);

  const earningId = randomUUID();
  const qcTaxId = randomUUID();
  const unionId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, taxable, created_by, updated_by)
    values (${earningId}, ${org.orgId}, 'SAL', 'Salary', 'earning', 'CA', true, ${actorId}, ${actorId}),
           (${qcTaxId}, ${org.orgId}, 'QCTAX', 'Quebec tax', 'deduction', 'CA', false, ${actorId}, ${actorId}),
           (${unionId}, ${org.orgId}, 'DUES', 'Union dues', 'deduction', 'CA', false, ${actorId}, ${actorId})`);
  await db.execute(sql`
    update pay_components set system_key = 'qc_income_tax' where id = ${qcTaxId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    update pay_components set tax_treatment = 'union_dues' where id = ${unionId} and org_id = ${org.orgId}`);

  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: "Biweekly",
    frequency: "biweekly",
    periodsPerYear: 26,
    anchorPeriodEnd: "2026-07-18",
    payDateOffsetDays: 3,
  });

  const qcStubEmployee = randomUUID();
  const qcOpeningOnlyEmployee = randomUUID();
  const onOpeningOnlyEmployee = randomUUID();
  let qcStubEmploymentId = "";
  for (const [id, name, province] of [
    [qcStubEmployee, "Marie Tremblay", "QC"],
    [qcOpeningOnlyEmployee, "Jean Lapointe", "QC"],
    [onOpeningOnlyEmployee, "Oliver Twist", "ON"],
  ] as const) {
    await seedPayrollPerson(org.orgId, id, name, {
      subsidiaryId: org.subsidiaryId,
    });
    const employmentId = await seedWorkerEmployment(org.orgId, id, org.subsidiaryId);
    if (id === qcStubEmployee) qcStubEmploymentId = employmentId;
    await seedPayrollProfile(
      org.orgId,
      id,
      employmentId,
      scheduleId,
      actorId,
      {
        province: province,
        filingAccountId,
        payBasis: "hourly",
        country: "CA",
        federalClaimCode: 1,
        provincialClaimCode: 1,
      },
      { percentFloor: "4", method: "accrue" },
    );
  }

  // All source certificates exist before any committed payroll consumes them.
  for (const [id, province, taxable, pensionable, qpipBase] of [
    [qcStubEmployee, "QC", "10000.0000", "10000.0000", "8000"],
    [qcOpeningOnlyEmployee, "QC", "5000.0000", "5000.0000", "4000"],
    [onOpeningOnlyEmployee, "ON", "7000.0000", "7000.0000", "0"],
  ] as const) {
    await qualifyOpening(
      org.orgId,
      actorId,
      org.subsidiaryId,
      id,
      filingAccountId,
      province,
      taxable,
      pensionable,
      qpipBase,
    );
  }

  const documentId = randomUUID();
  await seedPayrollDocument(org.orgId, documentId, {
    kind: "pay_run",
    documentNumber: `PAY-${documentId.slice(0, 8)}`,
    subsidiaryId: org.subsidiaryId,
    documentDate: "2026-07-21",
    currency: "CAD",
    status: "draft",
    createdBy: actorId,
    updatedBy: actorId,
  });
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
            2026, 'committed', now(), ${actorId}, ${actorId})`);

  const stubId = randomUUID();
  // The stub's QPIP program base DIVERGES from its EI base on purpose:
  // 30,000 EI-insurable but only 22,000 QPIP-insurable (benefits the QPIP
  // program excludes). Box I must follow the program factor, never EI.
  await seedPayrollStub(org.orgId, documentId, qcStubEmployee, qcStubEmploymentId, {
    id: stubId,
    country: "CA",
    countrySource: "calculation",
    filingAccountId,
    filingAccountSource: "insertion",
    province: "QC",
    periodsPerYear: 26,
    payDate: "2026-07-21",
    taxYear: 2026,
    currency: "CAD",
    gross: "30000.0000",
    netPay: "24000.0000",
    pensionableEarnings: "30000.0000",
    insurableEarnings: "30000.0000",
    factors: { C: "1500.00", EI: "390.00", QPIP: "129.00", IE_QPIP: "22000.00" },
    createdBy: actorId,
    updatedBy: actorId,
  });
  await db.execute(sql`
    insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                created_by, updated_by)
    values (${org.orgId}, ${stubId}, ${earningId}, 'earning', 'Salary', '30000.0000',
            ${actorId}, ${actorId}),
           (${org.orgId}, ${stubId}, ${qcTaxId}, 'deduction', 'Quebec tax', '2000.0000',
            ${actorId}, ${actorId}),
           (${org.orgId}, ${stubId}, ${unionId}, 'deduction', 'Union dues', '300.0000',
            ${actorId}, ${actorId})`);

  return {
    orgId: org.orgId,
    actorId,
    qcStubEmployee,
    qcOpeningOnlyEmployee,
    onOpeningOnlyEmployee,
  };
}

test(
  "RL-1 combines source-qualified original Québec amounts and program bases with committed payroll",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(seedQcYear);
    try {
      const slips = await rl1Slips(fx.orgId, 2026);
      const stub = slips.find((slip) => slip.employeePartyId === fx.qcStubEmployee);
      assert.ok(stub, "the QC employee with committed stubs has an RL-1 slip");
      assert.equal(stub.boxA, "40000.0000", "30000 stubs + 10000 opening");
      assert.equal(stub.boxBA, "2000.0000", "1500 QPP + 500 opening");
      assert.equal(stub.boxBB, "50.0000", "0 + 50 opening");
      assert.equal(stub.boxC, "490.0000", "390 EI + 100 opening");
      assert.equal(stub.boxH, "169.0000", "129 QPIP + 40 opening");
      assert.equal(stub.boxG, "40000.0000", "30000 + 10000 pensionable, under the YMPE");
      assert.equal(
        stub.boxI,
        "30000.0000",
        "22000 program base + 8000 carried, never the 30000 EI leg",
      );
      assert.equal(stub.boxE, "2125.0000", "2000 stub Québec tax plus 125 original Québec tax");
      assert.equal(stub.boxF, "375.0000", "300 stub union dues plus 75 original union dues");
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "RL-1 seeds a slip for an opening-only Québec employee, and none for an Ontario one",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(seedQcYear);
    try {
      const slips = await rl1Slips(fx.orgId, 2026);
      const seeded = slips.find((slip) => slip.employeePartyId === fx.qcOpeningOnlyEmployee);
      assert.ok(seeded, "an opening-only QC employee appears on the RL-1");
      assert.equal(seeded.stubCount, 0);
      assert.equal(seeded.boxA, "5000.0000");
      assert.equal(seeded.boxBA, "500.0000");
      assert.equal(seeded.boxBB, "50.0000");
      assert.equal(seeded.boxC, "100.0000");
      assert.equal(seeded.boxH, "40.0000");
      assert.equal(seeded.boxG, "5000.0000");
      assert.equal(seeded.boxE, "125.0000");
      assert.equal(seeded.boxF, "75.0000");
      assert.equal(
        seeded.boxI,
        "4000.0000",
        "the carried program base alone: no stubs, no EI backfill",
      );
      assert.ok(
        !slips.some((slip) => slip.employeePartyId === fx.onOpeningOnlyEmployee),
        "an opening-only ON employee gets no RL-1 slip",
      );
      const summary = await rl1Summary(fx.orgId, 2026);
      assert.equal(summary.slips, 2);
      assert.equal(summary.boxA, "45000.0000");
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "RL-1 snapshot delays a native opening edit and preserves qualified history after its refusal",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(seedQcYear);
    const blocker = await pool.connect();
    let returnPromise: ReturnType<typeof rl1Return> | undefined;
    let editPromise: ReturnType<typeof saveOpeningBalances> | undefined;
    let lockHeld = false;
    try {
      await withBypassContext(() =>
        seedPayrollSettings(fx.orgId, {
          payroll: { rl1Transmitter: { identificationNumber: "RQ-OLD-123" } },
        }),
      );
      const original = await withOrgContext(fx.orgId, () =>
        readEmployeeCanadianOpeningReportingSource(db, {
          orgId: fx.orgId,
          employeePartyId: fx.qcStubEmployee,
          taxYear: 2026,
        }),
      );
      await blocker.query("begin");
      const pidResult = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
      const blockerPid = pidResult.rows[0]!.pid;
      await blocker.query("lock table pay_stubs in access exclusive mode");
      lockHeld = true;

      returnPromise = rl1Return(fx.orgId, 2026);
      const reportingPid = await waitUntilBlockedBy(blockerPid);
      editPromise = withOrgContext(fx.orgId, () =>
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [{ employeePartyId: fx.qcStubEmployee, amounts: { taxableYtd: "20000" } }],
        }),
      );
      await waitUntilBlockedBy(reportingPid);
      await blocker.query("commit");
      lockHeld = false;

      const result = await returnPromise;
      assert.equal(result.identificationNumber, "RQ-OLD-123");
      assert.equal(result.slips.length, 2);
      assert.equal(result.summary.slips, result.slips.length);
      assert.equal(result.summary.boxA, "45000.0000");
      const stub = result.slips.find((slip) => slip.employeePartyId === fx.qcStubEmployee);
      assert.ok(stub);
      assert.equal(stub.boxA, "40000.0000");
      await assert.rejects(editPromise, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /committed|locked|source-qualified/i);
        const refused = (
          error as Error & { result: { created: number; updated: number; errors: unknown[] } }
        ).result;
        assert.equal(refused.created, 0);
        assert.equal(refused.updated, 0);
        assert.equal(refused.errors.length, 1);
        return true;
      });
      const retained = await withOrgContext(fx.orgId, () =>
        readEmployeeCanadianOpeningReportingSource(db, {
          orgId: fx.orgId,
          employeePartyId: fx.qcStubEmployee,
          taxYear: 2026,
        }),
      );
      assert.deepEqual(retained, original);
      assert.deepEqual((await rl1Return(fx.orgId, 2026)).slips, result.slips);
    } finally {
      if (lockHeld) await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await returnPromise?.catch(() => undefined);
      await editPromise?.catch(() => undefined);
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);
