import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { add } from "../../money/money.ts";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../../platform/db.ts";
import { dropScratchOrgReporting } from "../../testing/fixtures.ts";
import { seedAdoption, type AdoptionFixture } from "../filing-test-fixtures.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { mutatePayRunAdjustment } from "../run-adjustments.ts";
import { prepareWithholdingRecordWrite } from "../withholding-record-write.ts";
import {
  payRunCalculationSourceDigest,
  type PayRunCalculationSourceSnapshot,
} from "../run-calculation-evidence.ts";

async function fixture(option2 = false) {
  const fx = await withBypassContext(() => seedAdoption());
  await withBypassContext(async () => {
    const schedule = await db.execute(
      sql`update pay_schedules set frequency='monthly',periods_per_year=12,
      anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${fx.orgId} and id=${fx.scheduleId} returning id`,
      "objects",
    );
    assert.equal(schedule.length, 1);
    const accountId = randomUUID();
    await db.execute(sql`insert into payroll_filing_accounts
      (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
      values(${accountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Canadian payroll account','regular',true,true,${fx.actorId},${fx.actorId})`);
    const profile = await db.execute(
      sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true,
      additional_tax_per_period=25,filing_account_id=${accountId}
      where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} returning employee_party_id`,
      "objects",
    );
    assert.equal(profile.length, 1);
    if (option2) {
      await db.execute(sql`insert into employee_tax_certificates
        (org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${fx.orgId},${fx.employeeId},'CA','ca_t4127_method',
          '{"method":"option2","reason":"Employer elected cumulative withholding"}'::jsonb,
          '2026-01-01',${fx.actorId},${fx.actorId})`);
    }
  });
  return fx;
}

async function run(
  fx: AdoptionFixture,
  start: string,
  end: string,
  amount: string,
  type: "regular" | "bonus",
) {
  const created = await createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    periodStart: start,
    periodEnd: end,
    payDate: end,
    runType: type,
  });
  const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: created.documentId };
  const components = await db.execute<{ id: string }>(
    sql`select id from pay_components
    where org_id=${fx.orgId} and system_key=${type === "regular" ? "base_pay" : "bonus"}`,
    "objects",
  );
  assert.equal(components.length, 1);
  await mutatePayRunAdjustment({
    ...command,
    mutation: {
      action: "add",
      employeePartyId: fx.employeeId,
      componentId: components[0]!.id,
      amount,
      replaceComponent: true,
      idempotencyKey: randomUUID(),
    },
  });
  const calculated = await calculatePayRun(command);
  assert.deepEqual(calculated.errors, []);
  const stubs = await db.execute<{
    id: string;
    factors: Record<string, string>;
    gross: string;
    net_pay: string;
  }>(
    sql`
    select id,factors,gross::text,net_pay::text from pay_stubs
    where org_id=${fx.orgId} and pay_run_document_id=${created.documentId}`,
    "objects",
  );
  assert.equal(stubs.length, 1);
  const sources = await db.execute<{ snapshot: PayRunCalculationSourceSnapshot; digest: string }>(
    sql`
    select calculation_source_snapshot as snapshot,calculation_source_digest as digest from pay_runs
    where org_id=${fx.orgId} and document_id=${created.documentId}`,
    "objects",
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.digest, payRunCalculationSourceDigest(sources[0]!.snapshot));
  await commitPayRun(command);
  assert.equal(
    (
      await db.execute<{ run_status: string }>(
        sql`select run_status from pay_runs
    where org_id=${fx.orgId} and document_id=${created.documentId}`,
        "objects",
      )
    )[0]!.run_status,
    "committed",
  );
  return { command, stub: stubs[0]!, source: sources[0]! };
}

async function elect(fx: AdoptionFixture, effectiveFrom: string, method: "option1" | "option2") {
  await withOrgTransaction(fx.orgId, async () => {
    await prepareWithholdingRecordWrite({
      orgId: fx.orgId,
      actorId: fx.actorId,
      employeePartyId: fx.employeeId,
      effectiveFrom,
      protectCommittedHistory: true,
    });
    const retired = await db.execute(
      sql`update employee_tax_certificates
      set superseded_on=${effectiveFrom},updated_at=clock_timestamp(),updated_by=${fx.actorId}
      where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}
        and certificate_key='ca_t4127_method' and superseded_on is null returning id`,
      "objects",
    );
    assert.equal(retired.length, 1);
    await db.execute(sql`insert into employee_tax_certificates
      (org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
      values(${fx.orgId},${fx.employeeId},'CA','ca_t4127_method',
        ${JSON.stringify({ method, reason: "Employer changed the withholding method prospectively" })}::jsonb,
        ${effectiveFrom},${fx.actorId},${fx.actorId})`);
  });
}

test(
  "Option 1 regular pay remains unchanged after separate bonuses while native bonus references and tax stay once-only",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await fixture();
    try {
      await withOrgContext(fx.orgId, async () => {
        const first = await run(fx, "2026-01-01", "2026-01-31", "5000", "regular");
        const bonus = await run(fx, "2026-02-01", "2026-02-28", "10000", "bonus");
        const reference = bonus.source.snapshot.bonusIncomeReferences![0]!;
        assert.equal(reference.referenceStubId, first.stub.id);
        assert.equal(reference.referenceRunId, first.command.documentId);
        assert.equal(reference.employmentId, fx.employmentId);
        assert.equal(reference.referenceMethod, "option1");
        assert.equal(bonus.stub.factors.I, "0.0000");
        assert.equal(bonus.stub.factors.B, "10000.0000");
        assert.equal(bonus.stub.factors.A, "70000.0000");
        assert.equal(bonus.stub.factors.A_step2, "60000.0000");
        assert.equal(bonus.stub.factors.A_periodic, "0.0000");
        assert.equal(bonus.stub.factors.T1_periodic, "0.0000");
        assert.equal(bonus.stub.factors.T2_periodic, "0.0000");
        assert.equal(bonus.stub.factors.TB, "2965.0000");
        assert.equal(bonus.stub.factors.T, "25.0000");
        assert.equal(bonus.stub.factors.CA_T_BASE, "0.0000");
        const later = await run(fx, "2026-03-01", "2026-03-31", "5000", "regular");
        assert.equal(later.stub.gross, first.stub.gross);
        assert.equal(later.stub.net_pay, first.stub.net_pay);
        assert.equal(later.stub.factors.A, "60000.0000");
        assert.equal(later.stub.factors.A_periodic, "60000.0000");
        assert.equal(later.stub.factors.A_step2, "70000.0000");
        assert.equal(later.stub.factors.B1, "10000.0000");
        assert.equal(later.stub.factors.TB, "0.0000");
        assert.equal(later.stub.factors.TF, first.stub.factors.TF);
        assert.equal(later.stub.factors.TP, first.stub.factors.TP);
        const second = await run(fx, "2026-04-01", "2026-04-15", "1000", "bonus");
        assert.equal(
          second.source.snapshot.bonusIncomeReferences![0]!.referenceStubId,
          later.stub.id,
        );
        assert.equal(second.stub.factors.I, "0.0000");
        assert.equal(second.stub.factors.B1, "10000.0000");
        assert.equal(second.stub.factors.A_step2, "70000.0000");
        assert.equal(second.stub.factors.A, "71000.0000");
        assert.equal(second.stub.factors.TB, "296.5000");
        assert.equal(second.stub.factors.A_periodic, "0.0000");
        assert.equal(second.stub.factors.CA_T_BASE, "0.0000");
        const after = await run(fx, "2026-05-01", "2026-05-31", "5000", "regular");
        assert.equal(after.stub.factors.B1, "11000.0000");
        assert.equal(after.stub.net_pay, first.stub.net_pay);
        assert.deepEqual(
          (
            await db.execute(
              sql`select id,factors,gross::text,net_pay::text from pay_stubs
        where org_id=${fx.orgId} and id=${first.stub.id}`,
              "objects",
            )
          )[0],
          first.stub,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "Option 2 regular pay retains cumulative bonus income and subtracts paid bonus tax only through M1",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await fixture(true);
    try {
      await withOrgContext(fx.orgId, async () => {
        const first = await run(fx, "2026-01-01", "2026-01-31", "5000", "regular");
        const bonus = await run(fx, "2026-02-01", "2026-02-15", "10000", "bonus");
        assert.equal(bonus.stub.factors.I, "0.0000");
        assert.equal(bonus.stub.factors.S1_DEN, "1.0000");
        assert.equal(bonus.stub.factors.M, first.stub.factors.CA_T_BASE);
        assert.equal(bonus.stub.factors.M1, "0.0000");
        assert.equal(bonus.stub.factors.CA_T_BASE, "0.0000");
        assert.equal(bonus.stub.factors.TB, "2965.0000");
        assert.equal(bonus.source.snapshot.bonusIncomeReferences?.length ?? 0, 0);
        const second = await run(fx, "2026-02-16", "2026-02-28", "5000", "regular");
        assert.equal(second.stub.factors.A_periodic, "70000.0000");
        assert.equal(second.stub.factors.S1_DEN, "2.0000");
        assert.equal(second.stub.factors.M, first.stub.factors.CA_T_BASE);
        assert.equal(second.stub.factors.M1, bonus.stub.factors.TB);
        assert.equal(second.stub.factors.TB, "0.0000");
        assert.equal(second.stub.factors.CA_T_BASE, first.stub.factors.CA_T_BASE);
        const third = await run(fx, "2026-03-01", "2026-03-31", "5000", "regular");
        assert.equal(third.stub.factors.S1_DEN, "3.0000");
        assert.equal(
          third.stub.factors.M,
          add(first.stub.factors.CA_T_BASE!, second.stub.factors.CA_T_BASE!),
        );
        assert.equal(third.stub.factors.M1, bonus.stub.factors.TB);
        assert.equal(third.stub.factors.CA_T_BASE, first.stub.factors.CA_T_BASE);
        assert.equal(third.stub.factors.TB, "0.0000");
        assert.deepEqual(
          (
            await db.execute(
              sql`select id,factors,gross::text,net_pay::text from pay_stubs
        where org_id=${fx.orgId} and id=${bonus.stub.id}`,
              "objects",
            )
          )[0],
          bonus.stub,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "prospective Option 2 and Option 1 transitions preserve original factors and periodic-versus-bonus identities",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await fixture(true);
    try {
      await withOrgContext(fx.orgId, async () => {
        const first = await run(fx, "2026-01-01", "2026-01-31", "5000", "regular");
        await elect(fx, "2026-02-01", "option1");
        const bonus = await run(fx, "2026-02-01", "2026-02-15", "10000", "bonus");
        const reference = bonus.source.snapshot.bonusIncomeReferences![0]!;
        assert.equal(reference.referenceMethod, "option2");
        assert.equal(reference.method.option, "option1");
        assert.equal(reference.method.effectiveFrom, "2026-02-01");
        assert.equal(reference.referenceStubId, first.stub.id);
        assert.equal(bonus.stub.factors.A_periodic, "0.0000");
        assert.equal(bonus.stub.factors.TB, "2965.0000");
        assert.equal(bonus.stub.factors.CA_T_BASE, "0.0000");
        assert.equal(bonus.stub.factors.M, undefined);
        assert.equal(bonus.stub.factors.M1, undefined);
        const second = await run(fx, "2026-03-01", "2026-03-31", "5000", "regular");
        assert.equal(second.stub.factors.A, "60000.0000");
        assert.equal(second.stub.factors.B1, "10000.0000");
        assert.equal(second.stub.factors.T, first.stub.factors.T);
        await elect(fx, "2026-04-01", "option2");
        const reset = await run(fx, "2026-04-01", "2026-04-30", "5000", "regular");
        assert.equal(reset.stub.factors.S1_DEN, "1.0000");
        assert.equal(reset.stub.factors.M, "0.0000");
        assert.equal(reset.stub.factors.M1, "0.0000");
        assert.equal(reset.stub.factors.B1, "0.0000");
        assert.equal(reset.stub.factors.A_periodic, "60000.0000");
        assert.equal(reset.stub.factors.T, first.stub.factors.T);
        assert.deepEqual(
          (
            await db.execute(
              sql`select id,factors,gross::text,net_pay::text from pay_stubs
        where org_id=${fx.orgId} and id=${first.stub.id}`,
              "objects",
            )
          )[0],
          first.stub,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);
