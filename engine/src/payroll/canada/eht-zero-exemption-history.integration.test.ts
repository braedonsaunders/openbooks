import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../../platform/db.ts";
import { parseMoney } from "../../money/brands.ts";
import { cmp } from "../../money/money.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  seedWorkerEmployment,
} from "../../testing/fixtures.ts";
import { seedAdoption } from "../filing-test-fixtures.ts";
import { resolveStoredEmployerFact } from "../employer-fact-store.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { mutatePayRunAdjustment } from "../run-adjustments.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { parsePayRunCalculationErrors } from "../run-calculation-evidence.ts";
import { insertPayStubRow, insertPayStubLineRows, type Line } from "../run-stub-records.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setup(initialAllocation = "0") {
  // Original zero allocation is effective before any retained payroll history.
  const f = await seedAdoption({ initialOntarioEhtExemption: initialAllocation });
  const rate = await db.execute<{ rate: string; exemption: string }>(
    sql`
    select rate_values->>'rate' as rate,rate_values->>'annualExemption' as exemption
    from payroll_statutory_rates where org_id=${f.orgId} and country='CA' and rate_key='ca_eht'
      and region='ON' and tax_year=2026`,
    "objects",
  );
  assert.equal(rate.length, 1);
  assert.equal(cmp(rate[0]!.rate, "1.95"), 0);
  assert.equal(cmp(rate[0]!.exemption, "1000000"), 0);
  await seedPayrollSettings(f.orgId, { features: { payroll: true } });
  assert.equal(
    (
      await db.execute(
        sql`select permission from user_permission_overrides
    where org_id=${f.orgId} and user_id=${f.actorId} and permission in ('payroll.read','payroll.run') and effect='grant'`,
        "objects",
      )
    ).length,
    2,
  );
  const filingAccountId = await filingAccount(f, f.subsidiaryId, "123456789RP0001");
  assert.equal(
    (
      await db.execute(
        sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
        "objects",
      )
    ).length,
    1,
  );
  return { ...f, filingAccountId };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function filingAccount(
  f: { orgId: string; actorId: string },
  subsidiaryId: string,
  number: string,
) {
  const id = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,is_active,created_by,updated_by)
    values(${id},${f.orgId},${subsidiaryId},'CA','ca_rp',${number},'Canadian payroll program',true,${f.actorId},${f.actorId})
    returning id`,
        "objects",
      )
    ).length,
    1,
  );
  return id;
}

type HistoricalState = "committed" | "voided-run" | "voided-document";

/** Retain an original payroll register, including its existing levy charge but no EHT remuneration factor. */
async function retainHistoricalSource(
  f: Fixture,
  input: {
    subsidiaryId?: string;
    employmentId?: string;
    filingAccountId?: string;
    state?: HistoricalState;
  } = {},
) {
  const source = {
    reference: "Original Canadian payroll register for June 2026",
    documentId: randomUUID(),
    stubId: randomUUID() as string,
    subsidiaryId: input.subsidiaryId ?? f.subsidiaryId,
    employmentId: input.employmentId ?? f.employmentId,
    filingAccountId: input.filingAccountId ?? f.filingAccountId,
    periodStart: "2026-06-07",
    periodEnd: "2026-06-20",
    payDate: "2026-06-23",
    country: "CA",
    currency: "CAD",
    province: "ON",
    taxYear: 2026,
    gross: "2400.0000",
    net: "2026.0900",
    employerCost: "2636.3600",
    factors: {
      I: "2400.0000",
      C: "134.7900",
      C2: "0.0000",
      EI: "39.1200",
      EI_ER: "54.7700",
      T: "200.0000",
      B: "0.0000",
      F3: "0.0000",
      F5B: "0.0000",
      QC_CSB: "0.0000",
      QPIP: "0.0000",
      QPIP_ER: "0.0000",
      WCB: "0.0000",
      WCB_EARN: "0.0000",
      EHT: "46.8000",
      HSF: "0.0000",
      HSF_EARN: "0.0000",
      CNT: "0.0000",
      CNT_EARN: "0.0000",
    },
  };
  const components = await db.execute<{ id: string; system_key: string; kind: string }>(
    sql`
    select id,system_key,kind from pay_components where org_id=${f.orgId} and (country is null or country='CA')`,
    "objects",
  );
  const component = (key: string, kind: Line["kind"]) => {
    const selected = components.filter((row) => row.system_key === key && row.kind === kind);
    assert.equal(
      selected.length,
      1,
      `The retained register resolves its native ${key} ${kind} component`,
    );
    return selected[0]!.id;
  };
  // These rows represent already-held original history; no calculated run is promoted past commit controls.
  await db.transaction(async (tx) => {
    assert.equal(
      (
        await tx.execute(
          sql`insert into documents
      (id,org_id,kind,document_number,subsidiary_id,document_date,currency,status,void_reason,voided_at,voided_by,memo,created_by,updated_by)
      values(${source.documentId},${f.orgId},'pay_run',${`PAY-${source.documentId.slice(0, 8)}`},
        ${source.subsidiaryId},${source.payDate},${source.currency},
        ${input.state === "voided-document" ? "voided" : "approved"},${input.state === "voided-document" ? "Original payroll source was voided before adoption" : null},
        ${input.state === "voided-document" ? sql`now()` : sql`null`},${input.state === "voided-document" ? f.actorId : null},
        ${source.reference},${f.actorId},${f.actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await tx.execute(
          sql`insert into pay_runs
      (document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,
        calculated_at,employee_count,gross_total,net_total,employer_cost_total,created_by,updated_by)
      values(${source.documentId},${f.orgId},${f.scheduleId},${source.periodStart},${source.periodEnd},
        ${source.payDate},${source.taxYear},${input.state === "voided-run" ? "voided" : "committed"},
        now(),1,${source.gross},${source.net},${source.employerCost},${f.actorId},${f.actorId}) returning document_id`,
          "objects",
        )
      ).length,
      1,
    );
    source.stubId = await insertPayStubRow(tx, {
      orgId: f.orgId,
      actorId: f.actorId,
      documentId: source.documentId,
      employeePartyId: f.employeeId,
      employmentId: source.employmentId,
      filingAccountId: source.filingAccountId,
      country: source.country,
      currency: source.currency,
      province: source.province,
      periodsPerYear: 26,
      payDate: source.payDate,
      taxYear: source.taxYear,
      federalClaim: "16452",
      provincialClaim: "12989",
      gross: source.gross,
      pensionable: source.gross,
      insurable: source.gross,
      net: source.net,
      employerCost: source.employerCost,
      vacationAccrued: "0",
      factors: source.factors,
      paymentMethod: "cheque",
    });
    const lines: Line[] = [
      {
        componentId: component("base_pay", "earning"),
        kind: "earning",
        description: "Original regular wages",
        amount: parseMoney(source.gross),
        hours: "80",
        rate: "30",
        earnedFrom: source.periodStart,
        earnedTo: source.periodEnd,
        sequence: 10,
      },
      {
        componentId: component("income_tax", "deduction"),
        kind: "deduction",
        description: "Original income tax",
        amount: parseMoney("200"),
        sequence: 110,
      },
      {
        componentId: component("cpp", "deduction"),
        kind: "deduction",
        description: "Original CPP",
        amount: parseMoney(source.factors.C),
        sequence: 120,
      },
      {
        componentId: component("ei", "deduction"),
        kind: "deduction",
        description: "Original EI",
        amount: parseMoney(source.factors.EI),
        sequence: 140,
      },
      {
        componentId: component("cpp", "employer_contribution"),
        kind: "employer_contribution",
        description: "Original employer CPP",
        amount: parseMoney(source.factors.C),
        sequence: 210,
      },
      {
        componentId: component("ei", "employer_contribution"),
        kind: "employer_contribution",
        description: "Original employer EI",
        amount: parseMoney(source.factors.EI_ER),
        sequence: 230,
      },
      {
        componentId: component("eht", "employer_contribution"),
        kind: "employer_contribution",
        description: "Original employer health tax",
        amount: parseMoney(source.factors.EHT),
        sequence: 270,
      },
    ];
    await insertPayStubLineRows(
      tx,
      {
        orgId: f.orgId,
        stubId: source.stubId,
        actorId: f.actorId,
        country: source.country,
        payDate: source.payDate,
      },
      lines,
    );
  });
  const identity = await db.execute(
    sql`select d.subsidiary_id,d.currency,r.run_status,d.status,s.employment_id,
    s.filing_account_id,s.country,s.currency_code,s.province,s.pay_date::text,s.tax_year,s.factors ? 'EHT_EARN' as has_eht_earn
    from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id where s.org_id=${f.orgId} and s.id=${source.stubId}`,
    "objects",
  );
  assert.deepEqual(identity, [
    {
      subsidiary_id: source.subsidiaryId,
      currency: "CAD",
      run_status: input.state === "voided-run" ? "voided" : "committed",
      status: input.state === "voided-document" ? "voided" : "approved",
      employment_id: source.employmentId,
      filing_account_id: source.filingAccountId,
      country: "CA",
      currency_code: "CAD",
      province: "ON",
      pay_date: source.payDate,
      tax_year: 2026,
      has_eht_earn: false,
    },
  ]);
  return source;
}

async function historySnapshot(f: Fixture, documentId: string) {
  return (
    await db.execute<{ body: string }>(
      sql`select jsonb_build_object(
    'document',(select to_jsonb(d) from documents d where d.org_id=${f.orgId} and d.id=${documentId}),
    'run',(select to_jsonb(r) from pay_runs r where r.org_id=${f.orgId} and r.document_id=${documentId}),
    'stubs',(select jsonb_agg(to_jsonb(s) order by s.id) from pay_stubs s where s.org_id=${f.orgId} and s.pay_run_document_id=${documentId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where s.org_id=${f.orgId} and s.pay_run_document_id=${documentId}))::text as body`,
      "objects",
    )
  )[0]!.body;
}

async function currentRun(f: Fixture, secondPeriod = false) {
  const run = await createPayRun({
    orgId: f.orgId,
    actorId: f.actorId,
    payScheduleId: f.scheduleId,
    periodStart: secondPeriod ? "2026-07-19" : "2026-07-05",
    periodEnd: secondPeriod ? "2026-08-01" : "2026-07-18",
    payDate: secondPeriod ? "2026-08-04" : "2026-07-21",
  });
  const command = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
  const base = await db.execute<{ id: string }>(
    sql`select id from pay_components
    where org_id=${f.orgId} and system_key='base_pay' and kind='earning' and (country is null or country='CA')`,
    "objects",
  );
  assert.equal(base.length, 1);
  await mutatePayRunAdjustment({
    ...command,
    reason: "Declared current regular wages",
    mutation: {
      action: "add",
      employeePartyId: f.employeeId,
      componentId: base[0]!.id,
      amount: "2400",
      hours: "80",
      replaceComponent: true,
      earnedFrom: secondPeriod ? "2026-07-20" : "2026-07-06",
      earnedTo: secondPeriod ? "2026-07-31" : "2026-07-17",
    },
  });
  return command;
}

async function assertLevy(f: Fixture, documentId: string, amount: string) {
  const stubs = await db.execute<{ gross: string; factors: Record<string, string> }>(
    sql`select gross::text,factors
    from pay_stubs where org_id=${f.orgId} and pay_run_document_id=${documentId} and employee_party_id=${f.employeeId}`,
    "objects",
  );
  assert.equal(stubs.length, 1);
  assert.equal(stubs[0]!.gross, "2400.0000");
  assert.equal(stubs[0]!.factors.EHT_EARN, "2400.0000");
  assert.equal(stubs[0]!.factors.EHT, amount);
  const lines = await db.execute<{ amount: string }>(
    sql`select l.amount::text from pay_stub_lines l
    join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
    join pay_components c on c.org_id=l.org_id and c.id=l.component_id
    where s.org_id=${f.orgId} and s.pay_run_document_id=${documentId} and s.employee_party_id=${f.employeeId}
      and c.system_key='eht' and l.kind='employer_contribution'`,
    "objects",
  );
  assert.deepEqual(lines, [{ amount }]);
}

async function preservedInputs(f: Fixture, documentId: string) {
  return (
    await db.execute<{ body: string }>(
      sql`select jsonb_build_object(
    'adjustments',(select jsonb_agg(to_jsonb(a) order by a.id) from pay_run_adjustments a where a.org_id=${f.orgId} and a.pay_run_document_id=${documentId}),
    'facts',(select jsonb_agg(to_jsonb(e) order by e.id) from payroll_employer_facts e where e.org_id=${f.orgId}),
    'profile',(select to_jsonb(p) from employee_payroll_profiles p where p.org_id=${f.orgId} and p.employee_party_id=${f.employeeId}),
    'time',(select jsonb_agg(to_jsonb(t) order by t.id) from time_entries t where t.org_id=${f.orgId} and t.employee_party_id=${f.employeeId}),
    'entitlements',(select jsonb_agg(to_jsonb(e) order by e.id) from entitlement_ledger e where e.org_id=${f.orgId} and e.employee_party_id=${f.employeeId}))::text as body`,
      "objects",
    )
  )[0]!.body;
}

for (const allocation of ["0", "1000"] as const) {
  test(
    `original Ontario annual allocation ${allocation} preserves unknown-history controls`,
    { skip: !DB },
    async () => {
      const f = await withBypassContext(() => setup(allocation));
      try {
        await withOrgContext(f.orgId, async () => {
          const original = await resolveStoredEmployerFact({
            tx: db,
            orgId: f.orgId,
            subsidiaryId: f.subsidiaryId,
            country: "CA",
            factKey: "eht_exemption_share_on",
            asOf: "2026-07-21",
          });
          assert.ok(original !== null);
          assert.equal(cmp(original, allocation), 0);
          const source = await retainHistoricalSource(f);
          const history = await historySnapshot(f, source.documentId);
          const command = await currentRun(f);
          const inputs = await preservedInputs(f, command.documentId);
          const result = await calculatePayRun(command);
          if (allocation === "0") {
            assert.equal(result.employees, 1);
            assert.deepEqual(result.errors, []);
            await assertLevy(f, command.documentId, "46.8000");
          } else {
            const errors = parsePayRunCalculationErrors(result.errors);
            assert.ok(errors);
            assert.equal(result.employees, 0);
            assert.equal(errors.length, 1);
            assert.equal(errors[0]!.kind, "refusal");
            assert.equal(errors[0]!.employeePartyId, f.employeeId);
            assert.match(
              errors[0]!.message,
              /Committed statutory history is missing a numeric factor required by this calculation/,
            );
            assert.match(errors[0]!.message, /qualify its original retained source/);
            assert.equal(await preservedInputs(f, command.documentId), inputs);
            assert.deepEqual(
              await db.execute(
                sql`select
          (select count(*)::int from pay_stubs where org_id=${f.orgId} and pay_run_document_id=${command.documentId}) as stubs,
          (select count(*)::int from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
            where s.org_id=${f.orgId} and s.pay_run_document_id=${command.documentId}) as lines,
          (select count(*)::int from entitlement_ledger where org_id=${f.orgId} and pay_run_document_id=${command.documentId}) as entitlements`,
                "objects",
              ),
              [{ stubs: 0, lines: 0, entitlements: 0 }],
            );
            const stored = await db.execute<{
              errors: unknown;
              gross: string;
              net: string;
              cost: string;
            }>(
              sql`
          select calculation_errors as errors,gross_total::text as gross,net_total::text as net,employer_cost_total::text as cost
          from pay_runs where org_id=${f.orgId} and document_id=${command.documentId}`,
              "objects",
            );
            assert.equal(stored.length, 1);
            assert.deepEqual(parsePayRunCalculationErrors(stored[0]!.errors), errors);
            assert.deepEqual(
              [stored[0]!.gross, stored[0]!.net, stored[0]!.cost],
              ["0.0000", "0.0000", "0.0000"],
            );
          }
          assert.equal(await historySnapshot(f, source.documentId), history);
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      }
    },
  );
}

for (const exclusion of ["other-payer", "voided-run", "voided-document"] as const) {
  test(
    `positive Ontario exemption excludes ${exclusion} history missing EHT remuneration`,
    { skip: !DB },
    async () => {
      const f = await withBypassContext(() => setup("1000"));
      try {
        await withOrgContext(f.orgId, async () => {
          let source;
          if (exclusion === "other-payer") {
            const other = randomUUID();
            assert.equal(
              (
                await db.execute(
                  sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${other},${f.orgId},${f.subsidiaryId},'Second Canadian legal employer','CAD','CA') returning id`,
                  "objects",
                )
              ).length,
              1,
            );
            const employmentId = await seedWorkerEmployment(f.orgId, f.employeeId, other);
            const filingAccountId = await filingAccount(f, other, "987654321RP0001");
            source = await retainHistoricalSource(f, {
              subsidiaryId: other,
              employmentId,
              filingAccountId,
            });
          } else {
            source = await retainHistoricalSource(f, { state: exclusion });
          }
          const history = await historySnapshot(f, source.documentId);
          const current = await currentRun(f);
          const result = await calculatePayRun(current);
          assert.equal(result.employees, 1);
          assert.deepEqual(result.errors, []);
          // No qualifying prior consumes the allocation: (2400 - 1000) × 1.95% = 27.30.
          await assertLevy(f, current.documentId, "27.3000");
          assert.equal(await historySnapshot(f, source.documentId), history);
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(f.orgId));
      }
    },
  );
}
