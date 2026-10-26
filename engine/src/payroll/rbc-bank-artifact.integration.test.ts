import { seedApprovedBankAccountFixture } from "../testing/bank-accounts.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { assignEmployeeWorkerCompGroup } from "./employee-worker-comp.ts";
import { recordHistoricalEmployerAssignment } from "./employer-assignment-history.ts";
import { setPackSlotAccount } from "./packs.ts";
import { add, cmp, toUnits } from "../money/money.ts";
import { encryptAccountNumber } from "../payments-core/rail-settings.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  createPaymentBankProfile,
  ensureBuiltInPaymentFormats,
  updatePaymentBankProfile,
} from "../payments/operations.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPayrollEmployeeRole,
  seedPayrollPerson,
  seedPayrollProfile,
  seedPayrollSchedule,
  seedPayrollTime,
  seedPayrollWage,
  seedPostingAccount,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import { seedCanadianPostingAccounts } from "../testing/payroll-posting-fixture.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import {
  generatePayRunBankFile,
  listPayRunBankFiles,
  payRunBankFileAudit,
  releasePayRunBankFile,
} from "./bank-file-artifact.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const NOW = new Date("2026-07-19T12:00:00Z");
const ORIGINATOR = {
  clientNumber: "0123456789",
  originatorLongName: "Boreal-Ridge Builders, Ltd.",
  originatorShortName: "BOREAL-RIDGE",
  transactionCode: "200",
  serviceCurrency: "CAD",
  transmission: "file_transfer_legacy",
  environment: "production",
};

async function fixture(org: Awaited<ReturnType<typeof createScratchOrg>>) {
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Payroll treasury operator", "payroll_treasury"),
  );
  const workerCompGroupId = randomUUID();
  await withBypassContext(async () => {
    await grantScratchPermissions(org.orgId, actorId, [
      "payroll.run",
      "payroll.manage",
      "parties.manage",
      "admin.setup.manage",
    ]);
    await seedCanadianPostingAccounts(org.orgId);
    await seedPayrollComponents(org.orgId, actorId, "CA");
    await seedOntarioEhtFixture(org.orgId, actorId);
    const workerCompPayable = await seedPostingAccount(
      org.orgId,
      "2330",
      "Workers compensation payable",
      "liability_current",
    );
    await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", workerCompPayable);
    await db.execute(sql`insert into worker_comp_groups
      (id, org_id, code, name, rate_percent, max_assessable, is_active, created_by, updated_by)
      values (${workerCompGroupId}, ${org.orgId}, 'CONSTRUCTION', 'Construction workers', '1.32', '121700', true, ${actorId}, ${actorId})`);
  });
  await withOrgContext(org.orgId, () => ensureBuiltInPaymentFormats(org.orgId, actorId));
  const formatId = (
    await withOrgContext(org.orgId, () =>
      db.execute<{ id: string }>(
        sql`
    select id from payment_formats where org_id = ${org.orgId} and code = 'RBC-STD152'`,
        "objects",
      ),
    )
  )[0]!.id;
  const profile = await withOrgContext(org.orgId, () =>
    createPaymentBankProfile(org.orgId, actorId, {
      name: "Canadian payroll treasury",
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      paymentFormatId: formatId,
      currency: "CAD",
      country: "CA",
      originatorSecrets: ORIGINATOR,
    }),
  );
  await withOrgContext(org.orgId, () =>
    updatePaymentBankProfile(profile.id, org.orgId, actorId, {
      name: "RBC Canadian payroll",
      originatorSecrets: { originatorShortName: "Boreal's Pay" },
    }),
  );
  const scheduleId = randomUUID();
  const employees = [
    {
      id: randomUUID(),
      name: "Ada O'Neil-Smith",
      number: "EMP-0041",
      bank: "000123456789",
      institution: "004",
      transit: "12345",
      method: "eft" as const,
    },
    {
      id: randomUUID(),
      name: "Éli Morrison, Jr.",
      number: "EMP-0042",
      bank: "000987654321",
      institution: "003",
      transit: "00212",
      method: "eft" as const,
    },
    {
      id: randomUUID(),
      name: "Pat Paper",
      number: "EMP-0043",
      bank: "111222333",
      institution: "001",
      transit: "00022",
      method: "cheque" as const,
    },
  ];
  await withBypassContext(async () => {
    await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
      name: "Biweekly Canadian payroll",
      subsidiaryId: org.subsidiaryId,
      frequency: "biweekly",
      periodsPerYear: 26,
      anchorPeriodEnd: "2026-07-18",
      payDateOffsetDays: 3,
    });
    for (const employee of employees) {
      await seedPayrollPerson(org.orgId, employee.id, employee.name, {
        subsidiaryId: org.subsidiaryId,
        paymentMethod: "eft",
      });
      await seedPayrollEmployeeRole(org.orgId, employee.id, {
        id: randomUUID(),
        employeeNumber: employee.number,
      });
      const employmentId = await seedWorkerEmployment(org.orgId, employee.id, org.subsidiaryId);
      await seedPayrollWage(org.orgId, employee.id, actorId, {
        currency: "CAD",
        rate: "30",
        basis: "hour",
        annualHours: "2080",
        effectiveFrom: "2026-01-01",
      });
      await seedPayrollProfile(
        org.orgId,
        employee.id,
        employmentId,
        scheduleId,
        actorId,
        {
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          federalClaimCode: 1,
          provincialClaimCode: 1,
          paymentMethod: employee.method,
        },
        { percentFloor: "4", method: "accrue" },
      );
      await seedApprovedBankAccountFixture({
        orgId: org.orgId,
        actorId,
        partyId: employee.id,
        bankName: "Canadian recipient bank",
        country: "CA",
        currency: "CAD",
        routing: { institution: employee.institution, transit: employee.transit },
        sealedAccount: encryptAccountNumber(employee.bank, { orgId: org.orgId }),
        lastFour: employee.bank.slice(-4),
      });
      for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await seedPayrollTime(org.orgId, employee.id, actorId, {
          workedOn,
          hours: "20",
          status: "approved",
          isBillable: false,
          billingStatus: "unbilled",
          costingBasis: "actual",
        });
      }
    }
  });
  for (const employee of employees) {
    await assignEmployeeWorkerCompGroup({
      orgId: org.orgId,
      actorId,
      employeePartyId: employee.id,
      groupId: workerCompGroupId,
      expectedGroupId: null,
      reason: "Construction workers covered by the employer compensation class",
      dryRun: false,
      allowedSubsidiaryIds: null,
    });
    await withSimClock("2026-07-22", () =>
      recordHistoricalEmployerAssignment({
        orgId: org.orgId,
        actorId,
        employeePartyId: employee.id,
        kind: "worker_comp",
        assignmentId: workerCompGroupId,
        expectedCurrentId: workerCompGroupId,
        effectiveFrom: "2026-07-05",
        effectiveTo: "2026-07-21",
        sourceReference: "Employer compensation coverage for July payroll",
        reason: "Retain the workers compensation class used on the pay date",
        allowedSubsidiaryIds: null,
        dryRun: false,
      }),
    );
  }
  const run = await withOrgContext(org.orgId, () =>
    createPayRun({
      orgId: org.orgId,
      actorId,
      payScheduleId: scheduleId,
      periodStart: "2026-07-05",
      periodEnd: "2026-07-18",
      payDate: "2026-07-21",
    }),
  );
  const calc = await withOrgContext(org.orgId, () =>
    calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId }),
  );
  assert.deepEqual(calc.errors, []);
  const generate = (extra = {}) =>
    withOrgContext(org.orgId, () =>
      generatePayRunBankFile({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
        paymentBankProfileId: profile.id,
        now: NOW,
        ...extra,
      }),
    );
  const release = (id: string, scope: ReadonlySet<string> | null = null) =>
    withOrgContext(org.orgId, () => releasePayRunBankFile(org.orgId, id, actorId, scope));
  return {
    actorId,
    profileId: profile.id,
    employees,
    documentId: run.documentId,
    generate,
    release,
  };
}

async function numbering(orgId: string) {
  return await withOrgContext(orgId, () =>
    db.execute<{ document_kind: string; next_number: number }>(
      sql`
    select document_kind, next_number from number_sequences where org_id = ${orgId}
      and (document_kind like 'rbc_std152:%' or document_kind = 'payroll_bank_file') order by document_kind`,
      "objects",
    ),
  );
}

test(
  "native RBC payroll stores exact CAD credits, releases the same bytes and gives its governed replacement a new identity",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const f = await fixture(org);
      await assert.rejects(f.generate(), /commit the pay run/);
      assert.deepEqual(await numbering(org.orgId), []);
      await withOrgContext(org.orgId, () =>
        commitPayRun({ orgId: org.orgId, documentId: f.documentId, actorId: f.actorId }),
      );
      const first = await f.generate();
      assert.equal(first.format, "rbc_std152");
      assert.equal(first.currency, "CAD");
      assert.equal(first.fileCreationNumber, 1);
      assert.equal(first.entryCount, 2);
      assert.equal(first.fileIdModifier, null);
      const released = await f.release(first.id);
      const text = released.bytes.toString("ascii");
      assert.equal(createHash("sha256").update(released.bytes).digest("hex"), first.contentHash);
      assert.equal(Buffer.from(text, "ascii").equals(released.bytes), true);
      assert.equal(text.endsWith("\r\n"), true);
      assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
      const [envelope, header, ...tail] = text.slice(0, -2).split("\r\n");
      assert.equal(envelope, "$$AAPDSTD0152[PROD[NL$$".padEnd(94));
      const records = [header!, ...tail];
      assert.equal(records.length, 4);
      for (const record of records) assert.equal(record.length, 152);
      assert.equal(header!.slice(0, 20), "000001AHDR0123456789");
      assert.equal(header!.slice(20, 50), "BOREAL RIDGE BUILDERS LTD".padEnd(30));
      assert.equal(header!.slice(50, 64), "00012026200CAD");
      const credits = records.slice(1, -1);
      const expectedNames = ["ADA O NEIL SMITH", "ELI MORRISON JR"];
      const stubs = await withOrgContext(org.orgId, () =>
        db.execute<{ employee_party_id: string; net_pay: string }>(
          sql`
      select employee_party_id, net_pay::text as net_pay from pay_stubs
      where org_id = ${org.orgId} and pay_run_document_id = ${f.documentId}`,
          "objects",
        ),
      );
      let cashCents = 0n;
      for (let index = 0; index < 2; index++) {
        const employee = f.employees[index]!;
        const credit = credits.find(
          (record) => record.slice(93, 123).trim() === expectedNames[index],
        )!;
        assert.ok(credit, employee.name);
        assert.equal(credit.slice(6, 10), "C200");
        assert.equal(credit.slice(21, 40), `PAY EMP 004${index + 1}`.padEnd(19));
        assert.equal(credit.slice(43, 51), employee.institution + employee.transit);
        assert.equal(credit.slice(51, 69), employee.bank.padEnd(18));
        assert.equal(credit.slice(86, 93), "2026202");
        assert.equal(credit.slice(125, 140), "BOREAL S PAY".padEnd(15));
        assert.equal(credit.slice(140, 143), "CAD");
        const cents =
          toUnits(stubs.find((stub) => stub.employee_party_id === employee.id)!.net_pay) / 100n;
        assert.equal(BigInt(credit.slice(70, 80)), cents);
        cashCents += cents;
      }
      const trailer = records.at(-1)!;
      assert.equal(trailer.slice(6, 10), "ZTRL");
      assert.equal(trailer.slice(20, 26), "000002");
      assert.equal(BigInt(trailer.slice(26, 40)), cashCents);
      assert.equal(cashCents, toUnits(first.controlTotal) / 100n);
      assert.equal(text.includes("PAT PAPER"), false);
      const total = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ net: string }>(
            sql`
      select net_total::text as net from pay_runs where org_id = ${org.orgId} and document_id = ${f.documentId}`,
            "objects",
          ),
        )
      )[0]!.net;
      assert.equal(cmp(add(first.controlTotal, first.excludedTotal), total), 0);
      const original = await withOrgContext(org.orgId, () =>
        db.execute<{ display_name: string; employee_number: string }>(
          sql`
      select p.display_name, e.employee_number from parties p join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
      where p.org_id=${org.orgId} and p.id in ${f.employees.map((employee) => employee.id)} order by e.employee_number`,
          "objects",
        ),
      );
      assert.deepEqual(
        original,
        f.employees.map((employee) => ({
          display_name: employee.name,
          employee_number: employee.number,
        })),
      );
      const allocated = await numbering(org.orgId);
      assert.deepEqual((await f.release(first.id)).bytes, released.bytes);
      assert.deepEqual(await numbering(org.orgId), allocated);
      await assert.rejects(f.generate(), /reason of at least 5 characters/);
      assert.deepEqual(await numbering(org.orgId), allocated);
      const second = await f.generate({
        supersedeReason: "Replace the original file before bank submission",
      });
      assert.equal(second.fileCreationNumber, 2);
      assert.equal(second.sequenceNumber, 2);
      assert.notEqual(second.fileNumber, first.fileNumber);
      assert.equal(
        (await f.release(second.id)).bytes.toString("ascii").split("\r\n")[1]!.slice(50, 54),
        "0002",
      );
      await assert.rejects(f.release(first.id), /superseded/);
      const files = await withOrgContext(org.orgId, () =>
        listPayRunBankFiles(org.orgId, f.documentId),
      );
      assert.equal(files.length, 2);
      assert.equal(files.find((file) => file.id === first.id)!.status, "superseded");
      const audit = await withOrgContext(org.orgId, () =>
        payRunBankFileAudit(org.orgId, f.documentId),
      );
      assert.equal(
        audit.filter((row) => row.event === "release" && row.artifactId === first.id).length,
        2,
      );
      assert.ok(audit.every((row) => row.actorId === f.actorId));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "RBC payroll refuses revoked duties, live entity scope, disabled payroll and incomplete profiles without releasing or allocating",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const f = await fixture(org);
      await withOrgContext(org.orgId, () =>
        commitPayRun({ orgId: org.orgId, documentId: f.documentId, actorId: f.actorId }),
      );
      const deny = (permission: string) =>
        withBypassContext(() =>
          db.execute(sql`update user_permission_overrides set effect='deny'
      where org_id=${org.orgId} and user_id=${f.actorId} and permission=${permission}`),
        );
      await deny("payroll.run");
      await assert.rejects(f.generate(), ScopeNotFoundError);
      assert.deepEqual(await numbering(org.orgId), []);
      await withBypassContext(() => grantScratchPermissions(org.orgId, f.actorId, ["payroll.run"]));
      await assert.rejects(f.generate({ allowedSubsidiaryIds: new Set() }), /pay run not found/);
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          updatePaymentBankProfile(f.profileId, org.orgId, f.actorId, {
            originatorSecrets: { clientNumber: "" },
          }),
        ),
        /clientNumber/,
      );
      assert.deepEqual(await numbering(org.orgId), []);
      // A complete vendor profile is valid Setup configuration, but its 460
      // transaction code cannot instruct wages or consume a payroll identity.
      await withOrgContext(org.orgId, () =>
        updatePaymentBankProfile(f.profileId, org.orgId, f.actorId, {
          originatorSecrets: { transactionCode: "460" },
        }),
      );
      await assert.rejects(f.generate(), /transactionCode must be 200 for payroll/);
      assert.deepEqual(await numbering(org.orgId), []);
      assert.deepEqual(
        await withOrgContext(org.orgId, () => listPayRunBankFiles(org.orgId, f.documentId)),
        [],
      );
      await withOrgContext(org.orgId, () =>
        updatePaymentBankProfile(f.profileId, org.orgId, f.actorId, {
          originatorSecrets: { transactionCode: "200" },
        }),
      );
      // A native employee number can contain punctuation the bank reference
      // forbids. The render refusal occurs after numbering and must roll back
      // both allocations, leaving a corrected retry as the first artifact.
      await withBypassContext(() =>
        db.execute(sql`update employee_roles set employee_number='EMP&0041'
      where org_id=${org.orgId} and party_id=${f.employees[0]!.id}`),
      );
      await assert.rejects(f.generate(), /customer reference requires letters, digits and spaces/);
      assert.deepEqual(await numbering(org.orgId), []);
      assert.deepEqual(
        await withOrgContext(org.orgId, () => listPayRunBankFiles(org.orgId, f.documentId)),
        [],
      );
      await withBypassContext(() =>
        db.execute(sql`update employee_roles set employee_number=${f.employees[0]!.number}
      where org_id=${org.orgId} and party_id=${f.employees[0]!.id}`),
      );
      const file = await f.generate();
      assert.equal(file.fileCreationNumber, 1);
      const state = await numbering(org.orgId);
      await deny("payroll.run");
      await assert.rejects(f.release(file.id), ScopeNotFoundError);
      await assert.rejects(
        f.generate({ supersedeReason: "Replacement requires current payroll authority" }),
        ScopeNotFoundError,
      );
      await withBypassContext(() => grantScratchPermissions(org.orgId, f.actorId, ["payroll.run"]));
      await withBypassContext(() =>
        db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id=${org.orgId} and key='payroll_treasury'`),
      );
      await assert.rejects(f.release(file.id), /not found/);
      await assert.rejects(
        f.generate({ supersedeReason: "A narrowed role cannot export the prior population" }),
        /not found/,
      );
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='payroll_treasury'`,
        ),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','false'::jsonb) where id=${org.orgId}`,
        ),
      );
      await assert.rejects(f.release(file.id), /Enable Payroll/);
      await assert.rejects(
        f.generate({ supersedeReason: "Payroll must remain enabled during replacement" }),
        /Enable Payroll/,
      );
      assert.deepEqual(await numbering(org.orgId), state);
      assert.equal(
        (await withOrgContext(org.orgId, () => listPayRunBankFiles(org.orgId, f.documentId)))[0]!
          .releaseCount,
        0,
      );
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','true'::jsonb) where id=${org.orgId}`,
        ),
      );
      await deny("admin.setup.manage");
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          updatePaymentBankProfile(f.profileId, org.orgId, f.actorId, {
            name: "Unauthorized edit",
          }),
        ),
        ScopeNotFoundError,
      );
      assert.equal((await f.release(file.id)).artifact.fileCreationNumber, file.fileCreationNumber);
      assert.deepEqual(await numbering(org.orgId), state);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
