import {
  resolveStatutoryHistoryScope,
  employerScopedStatutoryStubs,
} from "../statutory-history-scope.ts";
import { payRunStaleness } from "../readiness.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { listPeriodSiblings } from "../period-priors.ts";
import {
  canonicalJson,
  parsePayRunCalculationErrors,
  payRunCalculationSourceDigest,
  type PayRunCalculationError,
  type PayRunCalculationSourceSnapshot,
} from "../run-calculation-evidence.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../../platform/db.ts";
import { seedAdoption, calculatedRun } from "../filing-test-fixtures.ts";
import {
  seedVacationTerms,
  seedPayrollSettings,
  seedWorkerEmployment,
  dropScratchOrgReporting,
  grantScratchPermissions,
} from "../../testing/fixtures.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { mutatePayRunAdjustment } from "../run-adjustments.ts";
import { add, cmp } from "../../money/money.ts";
import { employeeYtd } from "./compute-statutory.ts";
import { saveOpeningBalances } from "../opening-balances.ts";
import { upsertPayrollEmployerFact } from "../employer-fact-store.ts";
import {
  qualifyOpeningEmployerAuthority,
  readOpeningEmployerContext,
} from "../opening-employer-authority.ts";
import {
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
} from "../opening-levy-source-authority.ts";
import type { OpeningLevySourceFacts } from "../opening-levy-source-facts.ts";
import {
  employeeOpeningLevyAmount,
  readEmployeeOpeningLevySources,
  requireEmployerOpeningLevySources,
} from "../opening-levy-source-reader.ts";
import { errorChainMatches } from "../../testing/error-chain.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
async function setup() {
  // Associated Ontario employers share one annual EHT exemption, split here
  // equally between the two legal employers.
  const f = await seedAdoption({ initialOntarioEhtExemption: "500000" });
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
  const other = randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
  values(${other},${f.orgId},${f.subsidiaryId},'Second legal employer','CAD','CA')`);
  const employmentB = await seedWorkerEmployment(f.orgId, f.employeeId, other);
  await upsertPayrollEmployerFact({
    orgId: f.orgId,
    actorId: f.actorId,
    subsidiaryId: other,
    country: "CA",
    factKey: "eht_exemption_share_on",
    effectiveFrom: "2026-01-01",
    value: "500000",
    changeReason:
      "Declare the second legal employer share of the associated-employer Ontario exemption",
  });
  // Each legal employer pays from its own schedule; a run's employer is its schedule's owner.
  const scheduleB = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into pay_schedules(id,org_id,subsidiary_id,name,frequency,periods_per_year,
   anchor_period_end,pay_date_offset_days,is_active,created_by,updated_by)
  values(${scheduleB},${f.orgId},${other},'Second employer biweekly','biweekly',26,'2026-07-18',3,true,${f.actorId},${f.actorId})
  returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return { ...f, other, employmentB, scheduleB };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function run(
  f: Fixture,
  owner: string,
  status: "draft" | "committed",
  amount = "0",
  employment = f.employmentId,
  account: string | null = null,
) {
  assert.ok(
    owner === f.subsidiaryId || owner === f.other,
    "Each fixture legal employer pays from its own schedule",
  );
  const schedule = owner === f.other ? f.scheduleB : f.scheduleId;
  const created = await createPayRun({
    orgId: f.orgId,
    actorId: f.actorId,
    payScheduleId: schedule,
    periodStart: "2026-05-31",
    periodEnd: "2026-06-13",
    payDate: "2026-06-15",
    runType: "supplemental",
  });
  const id = created.documentId;
  let calculationWarnings: PayRunCalculationError[] = [];
  assert.equal(
    (
      await db.execute<{ id: string }>(
        sql`select subsidiary_id as id from documents
   where org_id=${f.orgId} and id=${id}`,
        "objects",
      )
    )[0]?.id,
    owner,
    "The run pays from its schedule owner",
  );
  if (status === "committed") {
    assert.ok(account, "A native calculation retains its actual employer filing account");
    assert.equal(
      (
        await db.execute(
          sql`update parties set subsidiary_id=${owner}
   where org_id=${f.orgId} and id=${f.employeeId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update employee_payroll_profiles set employment_id=${employment},filing_account_id=${account},pay_schedule_id=${schedule}
   where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
          "objects",
        )
      ).length,
      1,
    );
    const base = await db.execute<{ id: string }>(
      sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
      "objects",
    );
    assert.equal(base.length, 1);
    await mutatePayRunAdjustment({
      orgId: f.orgId,
      actorId: f.actorId,
      documentId: id,
      reason: "Declared supplemental wage for the selected employment",
      mutation: {
        action: "add",
        employeePartyId: f.employeeId,
        componentId: base[0]!.id,
        amount,
        hours: "100",
        replaceComponent: true,
        earnedFrom: "2026-06-12",
        earnedTo: "2026-06-12",
      },
    });
    const input = { orgId: f.orgId, actorId: f.actorId, documentId: id };
    const calculation = await calculatePayRun(input);
    const parsed = parsePayRunCalculationErrors(calculation.errors);
    assert.ok(parsed, "Native calculation outcomes must be well formed");
    const stored = await db.execute<{ errors: unknown }>(
      sql`select calculation_errors as errors from pay_runs
    where org_id=${f.orgId} and document_id=${id}`,
      "objects",
    );
    assert.equal(stored.length, 1);
    const retainedOutcomes = parsePayRunCalculationErrors(stored[0]!.errors);
    assert.ok(retainedOutcomes);
    assert.equal(
      canonicalJson(retainedOutcomes),
      canonicalJson(parsed),
      "Every native warning remains in retained calculation evidence",
    );
    assert.deepEqual(
      parsed.filter((entry) => entry.kind !== "warning"),
      [],
      "No refusal, out-of-scope or unknown outcome may be waived",
    );
    calculationWarnings = parsed.filter((entry) => entry.kind === "warning");
    await commitPayRun(input);
    const retained = await db.execute<{ employmentId: string; account: string; gross: string }>(
      sql`select employment_id as "employmentId",
    filing_account_id as account,gross::text as gross from pay_stubs where org_id=${f.orgId} and pay_run_document_id=${id}`,
      "objects",
    );
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.employmentId, employment);
    assert.equal(retained[0]!.account, account);
    assert.equal(cmp(retained[0]!.gross, amount), 0);
  }
  return {
    tx: db,
    orgId: f.orgId,
    employeePartyId: f.employeeId,
    taxYear: 2026,
    documentId: id,
    subsidiaryId: owner,
    calculationWarnings,
  };
}
async function source(
  f: Fixture,
  amounts: Record<string, string> = {
    pensionableYtd: "10000",
    insurableYtd: "10000",
    cppYtd: "100",
  },
  subsidiaryId = f.subsidiaryId,
  levyAllocations: readonly unknown[] = [],
  facts: OpeningLevySourceFacts = {
    originalCountry: "CA",
    originalCurrency: "CAD",
    coverageStart: "2026-01-01",
    coverageEnd: "2026-05-30",
    coverageComplete: true,
  },
) {
  const folder = randomUUID(),
    file = randomUUID(),
    version = randomUUID(),
    bytes = Buffer.from(
      JSON.stringify({
        employeePartyId: f.employeeId,
        legalEmployerSubsidiaryId: subsidiaryId,
        taxYear: 2026,
        amounts,
        levyAllocations,
        ...facts,
      }),
    );
  const sha = createHash("sha256").update(bytes).digest("hex");
  await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
  values(${folder},${f.orgId},'Original opening evidence',true,${f.actorId},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
  values(${file},${f.orgId},${folder},'original-opening.txt','text/plain',${bytes.length},${f.actorId},${f.actorId})`);
  await db.execute(sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
  values(${version},${file},1,${bytes.length},'text/plain',${sha},${f.actorId})`);
  await db.execute(sql`insert into file_blobs(version_id,bytes) values(${version},${bytes})`);
  await db.execute(
    sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file}`,
  );
  const expectedOpeningChildrenSha256 = (
    await db.execute<{ sha: string }>(
      sql`select encode(public.digest(public.payroll_opening_source_children(b.org_id,b.id,b.employee_party_id,b.tax_year)::text,'sha256'),'hex') as sha
   from payroll_opening_balances b where b.org_id=${f.orgId} and b.employee_party_id=${f.employeeId} and b.tax_year=2026`,
      "objects",
    )
  )[0]!.sha;
  return {
    ...facts,
    expectedOpeningChildrenSha256,
    sourceFileId: file,
    sourceVersionId: version,
    sourceSha256: sha,
    sourceReference: "Original employer A employee opening report",
    reason: "Qualify original employer ownership",
  };
}
function caLevyAllocations(wcb = "0", eht = "0", cnt = "0") {
  const provinces = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
  const ehtProvinces = ["BC", "MB", "NL", "ON"];
  return [
    ...provinces.map((region) => ({
      programKey: "ca_wcb",
      region,
      federalAccountId: null,
      amount: region === "ON" ? wcb : "0",
    })),
    ...ehtProvinces.map((region) => ({
      programKey: "ca_eht",
      region,
      federalAccountId: null,
      amount: region === "ON" ? eht : "0",
    })),
    { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: cnt },
  ];
}

test(
  "different employers retain independent annual contribution room while same-employer employment and RP changes retain history",
  { skip: !DB },
  async (t) => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const accountA = randomUUID(),
          accountB = randomUUID();
        for (const [id, number] of [
          [accountA, "123456789RP0001"],
          [accountB, "123456789RP0002"],
        ])
          await db.execute(sql`
   insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
   values(${id},${f.orgId},${f.subsidiaryId},'CA','ca_rp',${number},'Payroll program',true)`);
        const first = await run(f, f.subsidiaryId, "committed", "100000", f.employmentId, accountA);
        const rehire = await seedWorkerEmployment(f.orgId, f.employeeId, f.subsidiaryId);
        await seedVacationTerms(f.orgId, rehire, f.actorId);
        const second = await run(f, f.subsidiaryId, "committed", "100000", rehire, accountB);
        const accountOther = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
   values(${accountOther},${f.orgId},${f.other},'CA','ca_rp','987654321RP0001','Second employer payroll',true) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedVacationTerms(f.orgId, f.employmentB, f.actorId);
        const third = await run(f, f.other, "committed", "100000", f.employmentB, accountOther);
        t.diagnostic(
          JSON.stringify(
            [first, second, third].map((run) => ({
              documentId: run.documentId,
              warnings: run.calculationWarnings,
            })),
          ),
        );
        const contributions = async (documentId: string) =>
          (
            await db.execute<{ cpp: string; cpp2: string; ei: string }>(
              sql`
   select factors->>'C' as cpp,factors->>'C2' as cpp2,factors->>'EI' as ei from pay_stubs
   where org_id=${f.orgId} and pay_run_document_id=${documentId}`,
              "objects",
            )
          )[0]!;
        const original = await contributions(first.documentId),
          rehired = await contributions(second.documentId),
          other = await contributions(third.documentId);
        for (const key of ["cpp", "cpp2", "ei"] as const) {
          assert.ok(
            cmp(original[key], "0") > 0,
            "The first native wage consumes each annual contribution limit",
          );
          assert.equal(
            cmp(rehired[key], "0"),
            0,
            "Same employer rehire and RP changes cannot reset annual room",
          );
          assert.equal(
            cmp(other[key], original[key]),
            0,
            "Another employer retains its independent annual room",
          );
        }
        const currentA = await run(f, f.subsidiaryId, "draft");
        const a = await employeeYtd(currentA);
        const currentB = await run(f, f.other, "draft");
        const b = await employeeYtd(currentB);
        const scopeA = await resolveStatutoryHistoryScope(db, { ...currentA, country: "CA" });
        const scopeB = await resolveStatutoryHistoryScope(db, { ...currentB, country: "CA" });
        const history = async (scope: typeof scopeA) =>
          await db.execute<{ id: string; employmentId: string }>(
            sql`select s.id,s.employment_id as "employmentId"
    from ${employerScopedStatutoryStubs(scope, { employeePartyId: f.employeeId })} s order by s.id`,
            "objects",
          );
        const retainedA = await history(scopeA),
          retainedB = await history(scopeB);
        assert.equal(retainedA.length, 2);
        assert.equal(retainedB.length, 1);
        assert.deepEqual(
          new Set(retainedA.map((row) => row.employmentId)),
          new Set([f.employmentId, rehire]),
          "Employer-wide annual room retains same-payer rehires",
        );
        assert.equal(
          retainedB[0]!.employmentId,
          f.employmentB,
          "A current party reassignment cannot reinterpret earlier payer history",
        );
        const employmentOnly = await db.execute<{ employmentId: string }>(
          sql`select s.employment_id as "employmentId"
    from ${employerScopedStatutoryStubs(scopeA, { employeePartyId: f.employeeId, employmentId: rehire })} s`,
          "objects",
        );
        assert.deepEqual(
          employmentOnly,
          [{ employmentId: rehire }],
          "Pack-declared employment priors do not double count a previous spell already certified as prior pay",
        );
        await assert.rejects(
          resolveStatutoryHistoryScope(db, {
            ...currentB,
            country: "CA",
            subsidiaryId: f.subsidiaryId,
          }),
          /actual pay-run legal employer/,
        );
        assert.deepEqual(await history(scopeA), retainedA);
        assert.deepEqual(await history(scopeB), retainedB);
        const identity = (
          await db.execute<{ createdAt: string; documentNumber: string }>(
            sql`select r.created_at::text as "createdAt",d.document_number as "documentNumber"
    from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id where r.org_id=${f.orgId} and r.document_id=${currentB.documentId}`,
            "objects",
          )
        )[0]!;
        const siblings = await listPeriodSiblings(db, f.orgId, {
          documentId: currentB.documentId,
          ...identity,
          payScheduleId: f.scheduleB,
          periodStart: "2026-05-31",
          periodEnd: "2026-06-13",
          payDate: "2026-06-15",
          runType: "supplemental",
        });
        assert.equal(
          siblings.length,
          2,
          "another employer cannot share period exemptions or sequencing",
        );
        const ownerRows = await db.execute<{ subsidiaryId: string }>(
          sql`select subsidiary_id as "subsidiaryId" from documents
    where org_id=${f.orgId} and id=any(${`{${siblings.map((sibling) => sibling.document_id).join(",")}}`}::uuid[])`,
          "objects",
        );
        assert.ok(ownerRows.every((row) => row.subsidiaryId === f.other));
        for (const key of ["cpp", "cpp2", "ei"] as const) {
          assert.equal(cmp(a[key], add(original[key], rehired[key])), 0);
          assert.equal(cmp(b[key], other[key]), 0);
        }
        assert.deepEqual(
          await contributions(first.documentId),
          original,
          "Later employment and employer assignments preserve earlier committed factors",
        );
        const originalRegion = (
          await db.execute<{ province: string }>(
            sql`select province from pay_stubs
    where org_id=${f.orgId} and pay_run_document_id=${first.documentId} and employee_party_id=${f.employeeId}`,
            "objects",
          )
        )[0]!.province;
        const byOriginalRegion = async () =>
          await db.execute<{ documentId: string }>(
            sql`
    select s.pay_run_document_id as "documentId"
      from ${employerScopedStatutoryStubs(scopeA, { employeePartyId: f.employeeId, region: originalRegion })} s
     order by s.pay_run_document_id`,
            "objects",
          );
        assert.equal(
          (await byOriginalRegion()).length,
          2,
          "Levy history follows each retained assessment province",
        );
        const changedCurrentRegion = originalRegion === "BC" ? "ON" : "BC";
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set province=${changedCurrentRegion}
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (await byOriginalRegion()).length,
          2,
          "A current province change cannot relabel original levy assessments",
        );
        assert.equal(
          (
            await db.execute(
              sql`update pay_runs set run_status='voided'
    where org_id=${f.orgId} and document_id=${first.documentId} returning document_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.deepEqual(
          await byOriginalRegion(),
          [{ documentId: second.documentId }],
          "A voided WCB/EHT/CNT assessment releases its original province history",
        );
        await assert.rejects(
          employeeYtd({ ...(await run(f, f.other, "draft")), subsidiaryId: f.subsidiaryId }),
          /actual pay-run legal employer/,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "unqualified opening payer refuses, exact source qualification replays, and another employer cannot consume it",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        await saveOpeningBalances({
          orgId: f.orgId,
          actorId: f.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: f.employeeId,
              amounts: { cppYtd: "100", pensionableYtd: "10000", insurableYtd: "10000" },
            },
          ],
        });
        const current = await run(f, f.subsidiaryId, "draft");
        await assert.rejects(employeeYtd(current), /opening payer is not source-qualified/);
        const before = await db.execute<{ snapshot: string }>(
          sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`,
          "objects",
        );
        const context = await readOpeningEmployerContext({
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          allowedSubsidiaryIds: null,
        });
        assert.ok(context.record);
        const input = {
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          subsidiaryId: f.subsidiaryId,
          expectedOpeningSha256: context.record.openingSha256,
          ...(await source(
            f,
            { cppYtd: "100", pensionableYtd: "10000", insurableYtd: "10000" },
            f.subsidiaryId,
            caLevyAllocations(),
          )),
          allowedSubsidiaryIds: null,
        };
        const unrelated = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${unrelated},${f.orgId},${f.subsidiaryId},'Unrelated legal employer','CAD','CA')`);
        await assert.rejects(
          qualifyOpeningEmployerAuthority({ ...input, subsidiaryId: unrelated }),
          /retained native employment/,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_opening_employer_authorities where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        const packetFolder = (
          await db.execute<{ id: string }>(
            sql`select folder_id as id from files where org_id=${f.orgId} and id=${input.sourceFileId}`,
            "objects",
          )
        )[0]!.id;
        assert.equal(
          (
            await db.execute(
              sql`update folders set owner_id=null where org_id=${f.orgId} and id=${packetFolder} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(qualifyOpeningEmployerAuthority(input), (error) =>
          errorChainMatches(error, /Source file is unavailable to this operator/),
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_opening_employer_authorities where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
          "Uploading a source version does not bypass its current Cabinet privacy boundary",
        );
        assert.equal(
          (
            await db.execute(
              sql`update folders set owner_id=${f.actorId} where org_id=${f.orgId} and id=${packetFolder} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          qualifyOpeningEmployerAuthority({ ...input, expectedOpeningSha256: "f".repeat(64) }),
          /source changed/,
        );
        const qualified = await qualifyOpeningEmployerAuthority(input);
        assert.deepEqual(await qualifyOpeningEmployerAuthority(input), qualified);
        await assert.rejects(employeeYtd(current), /no complete statutory levy source allocation/);
        await qualifyOpeningLevySourceAuthority({ ...input, allocations: caLevyAllocations() });
        assert.equal((await employeeYtd(current)).cpp, "100.0000");
        assert.equal((await employeeYtd(await run(f, f.other, "draft"))).cpp, "0.0000");
        await assert.rejects(
          qualifyOpeningEmployerAuthority({ ...input, subsidiaryId: f.other }),
          /different source evidence/,
        );
        await assert.rejects(
          qualifyOpeningEmployerAuthority({ ...input, allowedSubsidiaryIds: new Set([f.other]) }),
          /outside your payroll authority/,
        );
        await assert.rejects(
          db.execute(sql`update payroll_opening_balances set cpp_ytd=0 where org_id=${f.orgId}`),
          (error) => errorChainMatches(error, /Source-qualified opening amounts must be preserved/),
        );
        assert.deepEqual(
          await db.execute<{ snapshot: string }>(
            sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`,
            "objects",
          ),
          before,
        );
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from audit_log where org_id=${f.orgId} and table_name='payroll_opening_employer_authorities'`,
              "objects",
            )
          )[0]!.n,
          1,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "Canadian openings retain exact board, province, CNT, payer and sealed source allocations",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        await saveOpeningBalances({
          orgId: f.orgId,
          actorId: f.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: f.employeeId,
              amounts: { wcbAssessableYtd: "123.45", ehtRemunerationYtd: "234.56" },
            },
          ],
        });
        const context = await readOpeningEmployerContext({
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          allowedSubsidiaryIds: null,
        });
        assert.ok(context.record);
        const sourceEvidence = await source(
          f,
          { wcbAssessableYtd: "123.45", ehtRemunerationYtd: "234.56" },
          f.subsidiaryId,
          caLevyAllocations("123.45", "234.56", "15.00"),
        );
        await qualifyOpeningEmployerAuthority({
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          subsidiaryId: f.subsidiaryId,
          expectedOpeningSha256: context.record.openingSha256,
          ...sourceEvidence,
          allowedSubsidiaryIds: null,
        });
        const packetFolder = (
          await db.execute<{ id: string }>(
            sql`select folder_id as id from files where org_id=${f.orgId} and id=${sourceEvidence.sourceFileId}`,
            "objects",
          )
        )[0]!.id;
        assert.equal(
          (
            await db.execute(
              sql`update folders set owner_id=null where org_id=${f.orgId} and id=${packetFolder} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...sourceEvidence,
            orgId: f.orgId,
            actorId: f.actorId,
            openingBalanceId: context.record.id,
            expectedOpeningSha256: context.record.openingSha256,
            allocations: caLevyAllocations("123.45", "234.56", "15.00"),
            reason: "Retain the exact Canadian levy allocation",
            allowedSubsidiaryIds: null,
          }),
          (error) => errorChainMatches(error, /Source file is unavailable to this operator/),
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from payroll_opening_levy_source_authorities where org_id=${f.orgId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await db.execute(
              sql`update folders set owner_id=${f.actorId} where org_id=${f.orgId} and id=${packetFolder} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const allocations = caLevyAllocations("123.45", "234.56", "15.00");
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...sourceEvidence,
            orgId: f.orgId,
            actorId: f.actorId,
            openingBalanceId: context.record.id,
            expectedOpeningSha256: context.record.openingSha256,
            allocations: allocations.filter(
              (row) => !(row.programKey === "ca_wcb" && row.region === "PE"),
            ),
            reason: "Retain a complete original Canadian levy allocation",
            allowedSubsidiaryIds: null,
          }),
          /original WCB\/WSIB opening for PE/,
        );
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...sourceEvidence,
            orgId: f.orgId,
            actorId: f.actorId,
            openingBalanceId: context.record.id,
            expectedOpeningSha256: context.record.openingSha256,
            allocations: caLevyAllocations("123.46", "234.56", "15.00"),
            reason: "Retain a complete original Canadian levy allocation",
            allowedSubsidiaryIds: null,
          }),
          /must equal the original workers/,
        );
        const qualified = await qualifyOpeningLevySourceAuthority({
          ...sourceEvidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          expectedOpeningSha256: context.record.openingSha256,
          allocations,
          reason: "Retain the complete original Canadian levy allocation",
          allowedSubsidiaryIds: null,
        });
        const sourceRows = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          subsidiaryId: f.subsidiaryId,
        });
        assert.equal(
          employeeOpeningLevyAmount(sourceRows, { programKey: "ca_wcb", region: "ON" }),
          "123.4500",
        );
        assert.equal(
          employeeOpeningLevyAmount(sourceRows, { programKey: "ca_wcb", region: "BC" }),
          "0.0000",
        );
        assert.equal(
          employeeOpeningLevyAmount(sourceRows, { programKey: "ca_cnt", region: "QC" }),
          "15.0000",
        );
        assert.equal(
          (
            await readEmployeeOpeningLevySources(db, {
              orgId: f.orgId,
              employeePartyId: f.employeeId,
              taxYear: 2026,
              subsidiaryId: f.other,
            })
          ).hasOpening,
          false,
        );
        assert.equal(
          await requireEmployerOpeningLevySources(db, {
            orgId: f.orgId,
            subsidiaryId: f.subsidiaryId,
            taxYear: 2026,
            programKey: "ca_eht",
            region: "ON",
          }),
          "234.5600",
        );
        assert.equal(
          await requireEmployerOpeningLevySources(db, {
            orgId: f.orgId,
            subsidiaryId: f.other,
            taxYear: 2026,
            programKey: "ca_eht",
            region: "ON",
          }),
          "0",
          "Another legal employer with no opening history carries no prior EHT remuneration",
        );
        const audit = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from audit_log
   where org_id=${f.orgId} and table_name='payroll_opening_levy_source_authorities' and row_id=${qualified.id}`,
            "objects",
          )
        )[0]!.n;
        assert.equal(
          audit,
          1,
          "the source qualification and complete allocation snapshot have one native audit record",
        );
        const allocationId = (
          await db.execute<{ id: string }>(
            sql`select id from payroll_opening_levy_source_allocations
   where org_id=${f.orgId} and authority_id=${qualified.id} limit 1`,
            "objects",
          )
        )[0]!.id;
        await assert.rejects(
          db.execute(sql`update payroll_opening_levy_source_allocations set amount=0
   where org_id=${f.orgId} and id=${allocationId}`),
          (error) => errorChainMatches(error, /Payroll opening levy allocation rows are immutable/),
        );
        await assert.rejects(
          db.execute(sql`delete from payroll_opening_levy_source_authorities
   where org_id=${f.orgId} and id=${qualified.id}`),
          (error) => errorChainMatches(error, /preserves its original allocation/),
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "US openings retain original EIN and state scope after the account becomes inactive",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const usEmployer = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${usEmployer},${f.orgId},${f.subsidiaryId},'US legal employer','USD','US') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedWorkerEmployment(f.orgId, f.employeeId, usEmployer);
        const einA = randomUUID();
        for (const [id, number, name] of [[einA, "33-3333333", "US employer original EIN"]]) {
          assert.equal(
            (
              await db.execute(
                sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,is_default,is_active,created_by,updated_by)
    values(${id},${f.orgId},${usEmployer},'US','us_ein',${number},${name},false,true,${f.actorId},${f.actorId}) returning id`,
                "objects",
              )
            ).length,
            1,
          );
        }
        await saveOpeningBalances({
          orgId: f.orgId,
          actorId: f.actorId,
          taxYear: 2026,
          rows: [{ employeePartyId: f.employeeId, amounts: { insurableYtd: "10000" } }],
        });
        const context = await readOpeningEmployerContext({
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          allowedSubsidiaryIds: null,
        });
        assert.ok(context.record);
        const allocations = [
          {
            programKey: "us_futa",
            region: "US",
            filingAccountId: einA,
            federalAccountId: einA,
            amount: "10000",
          },
          {
            programKey: "us_sui",
            region: "NY",
            filingAccountId: null,
            federalAccountId: einA,
            amount: "4000",
          },
          {
            programKey: "us_sui",
            region: "PA",
            filingAccountId: null,
            federalAccountId: einA,
            amount: "2000",
          },
          {
            programKey: "us_pa_lst",
            region: "PA",
            subRegion: "123456",
            filingAccountId: null,
            federalAccountId: einA,
            amount: "0",
          },
        ];
        const sourceEvidence = await source(f, { insurableYtd: "10000" }, usEmployer, allocations, {
          originalCountry: "US",
          originalCurrency: "USD",
          coverageStart: "2026-01-01",
          coverageEnd: "2026-05-30",
          coverageComplete: true,
        });
        await qualifyOpeningEmployerAuthority({
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          subsidiaryId: usEmployer,
          expectedOpeningSha256: context.record.openingSha256,
          ...sourceEvidence,
          allowedSubsidiaryIds: null,
        });
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...sourceEvidence,
            orgId: f.orgId,
            actorId: f.actorId,
            openingBalanceId: context.record.id,
            expectedOpeningSha256: context.record.openingSha256,
            allocations: allocations.filter((row) => row.programKey !== "us_futa"),
            reason: "Retain original US wage bases by EIN and state",
            allowedSubsidiaryIds: null,
          }),
          /Declare FUTA opening wages/,
        );
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...sourceEvidence,
            orgId: f.orgId,
            actorId: f.actorId,
            openingBalanceId: context.record.id,
            expectedOpeningSha256: context.record.openingSha256,
            allocations: allocations.map((row) =>
              row.programKey === "us_futa" && row.filingAccountId === einA
                ? { ...row, amount: "10001" }
                : row,
            ),
            reason: "Retain original US wage bases by EIN and state",
            allowedSubsidiaryIds: null,
          }),
          /equal the original employee-only insurable wage opening/,
        );
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...sourceEvidence,
            orgId: f.orgId,
            actorId: f.actorId,
            openingBalanceId: context.record.id,
            expectedOpeningSha256: context.record.openingSha256,
            allocations: allocations.filter((row) => row.programKey !== "us_sui"),
            reason: "Retain original US wage bases by EIN and state",
            allowedSubsidiaryIds: null,
          }),
          /SUI jurisdiction allocations/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update payroll_filing_accounts set is_active=false where org_id=${f.orgId} and id=${einA} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const qualified = await qualifyOpeningLevySourceAuthority({
          ...sourceEvidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          expectedOpeningSha256: context.record.openingSha256,
          allocations,
          reason: "Retain original US wage bases by EIN and state",
          allowedSubsidiaryIds: null,
        });
        const opening = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          subsidiaryId: usEmployer,
        });
        assert.equal(
          employeeOpeningLevyAmount(opening, {
            programKey: "us_futa",
            region: "US",
            filingAccountId: einA,
          }),
          "10000.0000",
        );
        assert.equal(
          employeeOpeningLevyAmount(opening, {
            programKey: "us_sui",
            region: "NY",
            federalAccountId: einA,
          }),
          "4000.0000",
        );
        assert.equal(
          employeeOpeningLevyAmount(opening, {
            programKey: "us_pa_lst",
            region: "PA",
            subRegion: "123456",
            federalAccountId: einA,
          }),
          "0.0000",
        );
        assert.throws(
          () => employeeOpeningLevyAmount(opening, { programKey: "us_sui", region: "CA" }),
          /no explicit us_sui/,
        );
        assert.throws(
          () =>
            employeeOpeningLevyAmount(opening, {
              programKey: "us_pa_lst",
              region: "PA",
              subRegion: "654321",
            }),
          /no explicit us_pa_lst/,
        );
        assert.throws(
          () =>
            employeeOpeningLevyAmount(opening, {
              programKey: "us_futa",
              region: "US",
              filingAccountId: randomUUID(),
            }),
          /no explicit us_futa/,
        );
        assert.equal(
          (
            await readOpeningLevySourceContext({
              orgId: f.orgId,
              actorId: f.actorId,
              employeePartyId: f.employeeId,
              taxYear: 2026,
              allowedSubsidiaryIds: null,
            })
          ).record?.levyAuthorityId,
          qualified.id,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test(
  "qualifying employer source after calculation makes unchanged opening amounts stale until native recalculation",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const { input } = await calculatedRun(f);
        assert.deepEqual((await payRunStaleness(f.orgId, input.documentId)).reasons, []);
        const amounts = { taxableYtd: "1000", nonPeriodicYtd: "1000" },
          allocations = caLevyAllocations();
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
        assert.ok(
          (await payRunStaleness(f.orgId, input.documentId)).reasons.includes("openingBalances"),
        );
        await assert.rejects(commitPayRun(input), /openingBalances/);
        const calculateSourceRefusal = async () => {
          const refused = await calculatePayRun(input);
          assert.equal(refused.employees, 0);
          assert.equal(refused.errors.length, 1);
          assert.equal(refused.errors[0]!.employeePartyId, f.employeeId);
          assert.equal(refused.errors[0]!.kind, "refusal");
          assert.match(refused.errors[0]!.message, /opening.*(source|legal-employer|qualif)/i);
          assert.equal(
            (
              await db.execute(
                sql`select id from pay_stubs where org_id=${f.orgId}
    and pay_run_document_id=${input.documentId}`,
                "objects",
              )
            ).length,
            0,
            "A source refusal leaves no partial employee stub",
          );
          await assert.rejects(commitPayRun(input), /refused|no calculated stubs/);
        };
        await calculateSourceRefusal();
        const before = await db.execute<{ snapshot: string }>(
          sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`,
          "objects",
        );
        const context = await readOpeningEmployerContext({
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          allowedSubsidiaryIds: null,
        });
        assert.ok(context.record);
        const sourceEvidence = await source(f, amounts, f.subsidiaryId, allocations);
        const qualified = await qualifyOpeningEmployerAuthority({
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          subsidiaryId: f.subsidiaryId,
          expectedOpeningSha256: context.record.openingSha256,
          ...sourceEvidence,
          allowedSubsidiaryIds: null,
        });
        assert.deepEqual(
          await db.execute<{ snapshot: string }>(
            sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`,
            "objects",
          ),
          before,
        );
        assert.ok(
          (await payRunStaleness(f.orgId, input.documentId)).reasons.includes("openingBalances"),
        );
        await assert.rejects(commitPayRun(input), /openingBalances/);
        await calculateSourceRefusal();
        assert.deepEqual((await payRunStaleness(f.orgId, input.documentId)).reasons, []);
        const retained = await db.execute<{
          snapshot: PayRunCalculationSourceSnapshot;
          digest: string;
        }>(
          sql`
    select calculation_source_snapshot as snapshot,calculation_source_digest as digest
    from pay_runs where org_id=${f.orgId} and document_id=${input.documentId}`,
          "objects",
        );
        assert.equal(retained.length, 1);
        assert.equal(payRunCalculationSourceDigest(retained[0]!.snapshot), retained[0]!.digest);
        assert.deepEqual(
          retained[0]!.snapshot.openingEmployerAuthorities,
          [],
          "A refused employee consumes no opening history",
        );
        const levyAuthority = await qualifyOpeningLevySourceAuthority({
          ...sourceEvidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          expectedOpeningSha256: context.record.openingSha256,
          allocations,
          reason: "Retain the complete original Canadian levy allocation",
          allowedSubsidiaryIds: null,
        });
        assert.ok(
          (await payRunStaleness(f.orgId, input.documentId)).reasons.includes("openingBalances"),
        );
        await assert.rejects(commitPayRun(input), /openingBalances/);
        assert.deepEqual((await calculatePayRun(input)).errors, []);
        const calculated = await db.execute<{
          snapshot: PayRunCalculationSourceSnapshot;
          digest: string;
        }>(
          sql`
    select calculation_source_snapshot as snapshot,calculation_source_digest as digest
    from pay_runs where org_id=${f.orgId} and document_id=${input.documentId}`,
          "objects",
        );
        assert.equal(calculated.length, 1);
        const levySnapshot = calculated[0]!.snapshot;
        assert.equal(payRunCalculationSourceDigest(levySnapshot), calculated[0]!.digest);
        assert.deepEqual(levySnapshot.openingEmployerAuthorities, [
          {
            id: qualified.id,
            openingBalanceId: context.record.id,
            employeePartyId: f.employeeId,
            taxYear: 2026,
            subsidiaryId: f.subsidiaryId,
            sourceFileId: sourceEvidence.sourceFileId,
            sourceVersionId: sourceEvidence.sourceVersionId,
            sourceSha256: sourceEvidence.sourceSha256,
            openingSha256: context.record.openingSha256,
          },
        ]);
        assert.equal(levySnapshot.openingLevySourceAuthorities?.length, 1);
        assert.equal(levySnapshot.openingLevySourceAuthorities?.[0]?.id, levyAuthority.id);
        assert.equal(
          levySnapshot.openingLevySourceAuthorities?.[0]?.allocationSha256,
          levyAuthority.allocationSha256,
        );
        assert.equal(levySnapshot.openingLevySourceAuthorities?.[0]?.allocations.length, 18);
        const original = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          subsidiaryId: f.subsidiaryId,
        });
        assert.equal(original.authority?.sourceSha256, sourceEvidence.sourceSha256);
        assert.equal(original.authority?.sourceVersionId, sourceEvidence.sourceVersionId);
        assert.equal(original.openingSnapshot?.non_periodic_ytd, "1000.0000");
        assert.equal(
          (
            await employeeYtd({
              tx: db,
              orgId: f.orgId,
              employeePartyId: f.employeeId,
              taxYear: 2026,
              documentId: input.documentId,
              subsidiaryId: f.subsidiaryId,
            })
          ).non_periodic,
          "1000.0000",
        );
        assert.deepEqual((await payRunStaleness(f.orgId, input.documentId)).reasons, []);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test("a known empty adoption opening consumes no levy history with or without an employer certificate", () => {
  const empty = {
    hasOpening: true,
    hasWageHistory: false,
    hasMaterialHistory: false,
    facts: null,
    allocations: [],
  };
  assert.equal(employeeOpeningLevyAmount(empty, { programKey: "ca_wcb", region: "ON" }), "0");
  assert.equal(
    employeeOpeningLevyAmount(
      {
        ...empty,
        facts: {
          originalCountry: "CA",
          originalCurrency: "CAD",
          coverageStart: "2026-01-01",
          coverageEnd: "2026-01-02",
          coverageComplete: true,
        },
      },
      { programKey: "ca_eht", region: "ON" },
    ),
    "0",
  );
  assert.throws(
    () =>
      employeeOpeningLevyAmount(
        { ...empty, hasMaterialHistory: undefined } as unknown as Parameters<
          typeof employeeOpeningLevyAmount
        >[0],
        { programKey: "ca_wcb", region: "ON" },
      ),
    /Resolve the exact original opening history/,
  );
});

test("opening levy reads require the exact requested scope and preserve an explicit zero", () => {
  const ein = randomUUID(),
    otherEin = randomUUID(),
    stateAccount = randomUUID();
  const source = {
    hasOpening: true,
    hasWageHistory: true,
    hasMaterialHistory: true,
    facts: {
      originalCountry: "US" as const,
      originalCurrency: "USD" as const,
      coverageStart: "2026-01-01",
      coverageEnd: "2026-05-30",
      coverageComplete: true as const,
    },
    allocations: [
      {
        programKey: "us_futa" as const,
        region: "US",
        subRegion: "",
        filingAccountId: ein,
        federalAccountId: ein,
        amount: "0.0000",
      },
      {
        programKey: "us_sui" as const,
        region: "PA",
        subRegion: "",
        filingAccountId: stateAccount,
        federalAccountId: ein,
        amount: "2500.0000",
      },
      {
        programKey: "us_pa_lst" as const,
        region: "PA",
        subRegion: "123456",
        filingAccountId: null,
        federalAccountId: ein,
        amount: "0.0000",
      },
    ],
  };
  assert.equal(
    employeeOpeningLevyAmount(source, {
      programKey: "us_futa",
      region: "US",
      filingAccountId: ein,
    }),
    "0.0000",
  );
  assert.equal(
    employeeOpeningLevyAmount(source, {
      programKey: "us_sui",
      region: "PA",
      filingAccountId: stateAccount,
      federalAccountId: ein,
    }),
    "2500.0000",
  );
  assert.throws(
    () =>
      employeeOpeningLevyAmount(source, {
        programKey: "us_futa",
        region: "US",
        filingAccountId: otherEin,
      }),
    /no explicit us_futa/,
  );
  assert.throws(
    () => employeeOpeningLevyAmount(source, { programKey: "us_sui", region: "PA" }),
    /no explicit us_sui/,
  );
  assert.throws(
    () =>
      employeeOpeningLevyAmount(source, {
        programKey: "us_pa_lst",
        region: "PA",
        subRegion: "654321",
      }),
    /no explicit us_pa_lst/,
  );
  assert.equal(
    employeeOpeningLevyAmount(
      { ...source, hasWageHistory: false, allocations: [] },
      { programKey: "ca_cnt", region: "QC" },
    ),
    "0",
    "a source-qualified US opening is not a Canadian programme prior",
  );
  assert.equal(
    employeeOpeningLevyAmount(
      { ...source, hasOpening: false, allocations: [] },
      { programKey: "us_futa", region: "US", filingAccountId: ein },
    ),
    "0",
  );
});

test(
  "employer-premium-only history requires original source facts and preserves them when current employer country changes",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const amounts = { qpipEmployerYtd: "12.3456" };
        await saveOpeningBalances({
          orgId: f.orgId,
          actorId: f.actorId,
          taxYear: 2026,
          rows: [{ employeePartyId: f.employeeId, amounts }],
        });
        const read = () =>
          readEmployeeOpeningLevySources(db, {
            orgId: f.orgId,
            employeePartyId: f.employeeId,
            taxYear: 2026,
          });
        await assert.rejects(read(), /opening payer is not source-qualified/);
        const context = await readOpeningEmployerContext({
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          allowedSubsidiaryIds: null,
        });
        assert.ok(context.record);
        const allocations = caLevyAllocations(),
          sourceEvidence = await source(f, amounts, f.subsidiaryId, allocations);
        await qualifyOpeningEmployerAuthority({
          ...sourceEvidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          subsidiaryId: f.subsidiaryId,
          expectedOpeningSha256: context.record.openingSha256,
          allowedSubsidiaryIds: null,
        });
        await assert.rejects(read(), /no complete statutory levy source allocation/);
        const input = {
          ...sourceEvidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          expectedOpeningSha256: context.record.openingSha256,
          allocations,
          allowedSubsidiaryIds: null,
        };
        const sealed = await qualifyOpeningLevySourceAuthority(input);
        assert.deepEqual(
          await qualifyOpeningLevySourceAuthority(input),
          sealed,
          "replay preserves the exact source and authored facts",
        );
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({ ...input, coverageEnd: "2026-05-29" }),
          /different allocation evidence/,
        );
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...input,
            expectedOpeningChildrenSha256: "f".repeat(64),
          }),
          /amounts changed; reload/,
        );
        const before = await read();
        assert.equal(before.hasMaterialHistory, true);
        assert.equal(before.hasWageHistory, false);
        assert.equal(before.openingSnapshot?.qpip_employer_ytd, "12.3456");
        assert.equal(before.facts?.originalCountry, "CA");
        assert.equal(before.facts?.originalCurrency, "CAD");
        assert.equal(
          (
            await db.execute(
              sql`update subsidiaries set country='US',base_currency='USD' where org_id=${f.orgId} and id=${f.subsidiaryId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.deepEqual(
          await read(),
          before,
          "current employer configuration cannot reinterpret source-qualified original country or amounts",
        );
        const other = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          subsidiaryId: f.other,
        });
        assert.equal(other.hasOpening, false);
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);

test("same jurisdiction and original SUI account retains separate exact EIN allocations without guessing", () => {
  const einA = randomUUID(),
    einB = randomUUID(),
    state = randomUUID();
  const source = {
    hasOpening: true,
    hasWageHistory: true,
    hasMaterialHistory: true,
    facts: {
      originalCountry: "US",
      originalCurrency: "USD",
      coverageStart: "2026-01-01",
      coverageEnd: "2026-05-30",
      coverageComplete: true as const,
    },
    allocations: [
      {
        programKey: "us_sui" as const,
        region: "PA",
        subRegion: "",
        filingAccountId: state,
        federalAccountId: einA,
        amount: "1234.5678",
      },
      {
        programKey: "us_sui" as const,
        region: "PA",
        subRegion: "",
        filingAccountId: state,
        federalAccountId: einB,
        amount: "9000.0001",
      },
      {
        programKey: "us_pa_lst" as const,
        region: "PA",
        subRegion: "123456",
        filingAccountId: null,
        federalAccountId: einA,
        amount: "0.0000",
      },
      {
        programKey: "us_pa_lst" as const,
        region: "PA",
        subRegion: "123456",
        filingAccountId: null,
        federalAccountId: einB,
        amount: "26.0000",
      },
    ],
  };
  assert.equal(
    employeeOpeningLevyAmount(source, {
      programKey: "us_sui",
      region: "PA",
      filingAccountId: state,
      federalAccountId: einA,
    }),
    "1234.5678",
  );
  assert.equal(
    employeeOpeningLevyAmount(source, {
      programKey: "us_sui",
      region: "PA",
      filingAccountId: state,
      federalAccountId: einB,
    }),
    "9000.0001",
  );
  assert.equal(
    employeeOpeningLevyAmount(source, {
      programKey: "us_pa_lst",
      region: "PA",
      subRegion: "123456",
      federalAccountId: einA,
    }),
    "0.0000",
  );
  assert.equal(
    employeeOpeningLevyAmount(source, {
      programKey: "us_pa_lst",
      region: "PA",
      subRegion: "123456",
      federalAccountId: einB,
    }),
    "26.0000",
  );
  assert.throws(
    () =>
      employeeOpeningLevyAmount(source, {
        programKey: "us_sui",
        region: "PA",
        filingAccountId: state,
      }),
    /no explicit us_sui/,
  );
});

test(
  "original SUI and PA LST allocations can be explicitly split between multiple EINs under one retained legal employer",
  { skip: !DB },
  async () => {
    const f = await withBypassContext(setup);
    try {
      await withOrgContext(f.orgId, async () => {
        const employer = randomUUID(),
          einA = randomUUID(),
          einB = randomUUID(),
          stateAccount = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${employer},${f.orgId},${f.subsidiaryId},'Original US payer','USD','US') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedWorkerEmployment(f.orgId, f.employeeId, employer);
        for (const [id, number] of [
          [einA, "11-1111111"],
          [einB, "22-2222222"],
        ]) {
          assert.equal(
            (
              await db.execute(
                sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_default,is_active,created_by,updated_by)
    values(${id},${f.orgId},${employer},'US','us_ein',${number},'Original EIN',false,true,${f.actorId},${f.actorId}) returning id`,
                "objects",
              )
            ).length,
            1,
          );
        }
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,state_code,account_number,name,is_default,is_active,created_by,updated_by)
    values(${stateAccount},${f.orgId},${employer},'US','us_state_sui','PA','PA-original','Original Pennsylvania account',false,true,${f.actorId},${f.actorId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const amounts = { insurableYtd: "10000" };
        await saveOpeningBalances({
          orgId: f.orgId,
          actorId: f.actorId,
          taxYear: 2026,
          rows: [{ employeePartyId: f.employeeId, amounts }],
        });
        const context = await readOpeningEmployerContext({
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          allowedSubsidiaryIds: null,
        });
        assert.ok(context.record);
        const allocations = [
          {
            programKey: "us_futa",
            region: "US",
            filingAccountId: einA,
            federalAccountId: einA,
            amount: "4000",
          },
          {
            programKey: "us_futa",
            region: "US",
            filingAccountId: einB,
            federalAccountId: einB,
            amount: "6000",
          },
          {
            programKey: "us_sui",
            region: "PA",
            filingAccountId: stateAccount,
            federalAccountId: einA,
            amount: "4000",
          },
          {
            programKey: "us_sui",
            region: "PA",
            filingAccountId: stateAccount,
            federalAccountId: einB,
            amount: "6000",
          },
          {
            programKey: "us_pa_lst",
            region: "PA",
            subRegion: "123456",
            filingAccountId: null,
            federalAccountId: einA,
            amount: "0",
          },
          {
            programKey: "us_pa_lst",
            region: "PA",
            subRegion: "123456",
            filingAccountId: null,
            federalAccountId: einB,
            amount: "26",
          },
        ];
        const evidence = await source(f, amounts, employer, allocations, {
          originalCountry: "US",
          originalCurrency: "USD",
          coverageStart: "2026-01-01",
          coverageEnd: "2026-05-30",
          coverageComplete: true,
        });
        await qualifyOpeningEmployerAuthority({
          ...evidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          subsidiaryId: employer,
          expectedOpeningSha256: context.record.openingSha256,
          allowedSubsidiaryIds: null,
        });
        const input = {
          ...evidence,
          orgId: f.orgId,
          actorId: f.actorId,
          openingBalanceId: context.record.id,
          expectedOpeningSha256: context.record.openingSha256,
          allocations,
          allowedSubsidiaryIds: null,
        };
        await assert.rejects(
          qualifyOpeningLevySourceAuthority({
            ...input,
            allocations: allocations.map((row) =>
              row.programKey === "us_sui" ? { ...row, federalAccountId: null } : row,
            ),
          }),
          /original federal EIN/,
        );
        await qualifyOpeningLevySourceAuthority(input);
        const retained = await readEmployeeOpeningLevySources(db, {
          orgId: f.orgId,
          employeePartyId: f.employeeId,
          taxYear: 2026,
          subsidiaryId: employer,
        });
        assert.equal(
          employeeOpeningLevyAmount(retained, {
            programKey: "us_sui",
            region: "PA",
            filingAccountId: stateAccount,
            federalAccountId: einA,
          }),
          "4000.0000",
        );
        assert.equal(
          employeeOpeningLevyAmount(retained, {
            programKey: "us_sui",
            region: "PA",
            filingAccountId: stateAccount,
            federalAccountId: einB,
          }),
          "6000.0000",
        );
        assert.equal(
          employeeOpeningLevyAmount(retained, {
            programKey: "us_pa_lst",
            region: "PA",
            subRegion: "123456",
            federalAccountId: einA,
          }),
          "0.0000",
        );
        assert.equal(
          employeeOpeningLevyAmount(retained, {
            programKey: "us_pa_lst",
            region: "PA",
            subRegion: "123456",
            federalAccountId: einB,
          }),
          "26.0000",
        );
        await assert.rejects(
          db.execute(sql`insert into payroll_opening_program_bases(org_id,employee_party_id,tax_year,program_key,insurable_ytd,created_by,updated_by)
   values(${f.orgId},${f.employeeId},2026,'qpip','1',${f.actorId},${f.actorId})`),
          (error) =>
            errorChainMatches(
              error,
              /Source-qualified statutory opening amounts must be preserved/,
            ),
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
