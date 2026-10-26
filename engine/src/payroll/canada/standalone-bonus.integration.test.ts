import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { add } from "../../money/money.ts";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../../platform/db.ts";
import { dropScratchOrgReporting } from "../../testing/fixtures.ts";
import { seedAdoption } from "../filing-test-fixtures.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { mutatePayRunAdjustment } from "../run-adjustments.ts";
import { prepareWithholdingRecordWrite } from "../withholding-record-write.ts";
import {
  payRunCalculationSourceDigest,
  type PayRunCalculationSourceSnapshot,
} from "../run-calculation-evidence.ts";

async function retainedBonusSource(orgId: string, documentId: string) {
  const row = (
    await db.execute<{ snapshot: PayRunCalculationSourceSnapshot; digest: string }>(
      sql`select calculation_source_snapshot as snapshot,calculation_source_digest as digest from pay_runs where org_id=${orgId} and document_id=${documentId}`,
      "objects",
    )
  )[0]!;
  assert.equal(row.digest, payRunCalculationSourceDigest(row.snapshot));
  assert.equal(row.snapshot.bonusIncomeReferences?.length, 1);
  return row.snapshot.bonusIncomeReferences![0]!;
}

test(
  "separate Option 1 bonus references committed regular income without paying or withholding regular pay twice",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await withBypassContext(() => seedAdoption());
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update pay_schedules set frequency='monthly',periods_per_year=12,anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
        );
        const filingAccountId = randomUUID();
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
        values(${filingAccountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Canadian payroll account','regular',true,true,${fx.actorId},${fx.actorId})`);
        const profile = await db.execute(
          sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true,filing_account_id=${filingAccountId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} returning employee_party_id`,
          "objects",
        );
        assert.equal(profile.length, 1);
      });
      await withOrgContext(fx.orgId, async () => {
        const components = await db.execute<{ id: string; system_key: string }>(
          sql`select id,system_key from pay_components where org_id=${fx.orgId} and system_key in ('base_pay','bonus')`,
          "objects",
        );
        const create = async (
          start: string,
          end: string,
          amount: string,
          type: "regular" | "bonus",
        ) => {
          const run = await createPayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            payScheduleId: fx.scheduleId,
            periodStart: start,
            periodEnd: end,
            payDate: end,
            runType: type,
          });
          const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
          await mutatePayRunAdjustment({
            ...command,
            mutation: {
              action: "add",
              employeePartyId: fx.employeeId,
              componentId: components.find(
                (c) => c.system_key === (type === "bonus" ? "bonus" : "base_pay"),
              )!.id,
              amount,
              replaceComponent: true,
              idempotencyKey: randomUUID(),
            },
          });
          return command;
        };
        const bonus = await create("2026-02-01", "2026-02-28", "10000", "bonus");
        const missing = await calculatePayRun(bonus);
        assert.equal(missing.errors.length, 1);
        assert.match(
          missing.errors[0]!.message,
          /no committed regular income.*calculate and commit its regular pay/,
        );
        await assert.rejects(commitPayRun(bonus), /refused at calculation/);
        // An explicit tax exemption does not need regular income to price TB.
        await db.execute(
          sql`update employee_payroll_profiles set tax_exempt=true where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
        );
        assert.deepEqual((await calculatePayRun(bonus)).errors, []);
        const exempt = (
          await db.execute<{ factors: Record<string, string> }>(
            sql`select factors from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`,
            "objects",
          )
        )[0]!.factors;
        assert.equal(exempt.TB, "0.0000");
        assert.equal(exempt.CA_BONUS_I_REFERENCE, undefined);
        await db.execute(
          sql`update employee_payroll_profiles set tax_exempt=false where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
        );
        const regular = await create("2026-01-01", "2026-01-31", "5000", "regular");
        assert.deepEqual((await calculatePayRun(regular)).errors, []);
        await commitPayRun(regular);
        const prior = (
          await db.execute<{
            id: string;
            factors: Record<string, string>;
            gross: string;
            net_pay: string;
          }>(
            sql`select id,factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${regular.documentId}`,
            "objects",
          )
        )[0]!;
        // A newer calculated regular run must not supply unpaid remuneration.
        const draft = await create("2026-02-01", "2026-02-28", "9000", "regular");
        assert.deepEqual((await calculatePayRun(draft)).errors, []);
        assert.deepEqual((await calculatePayRun(bonus)).errors, []);
        const stub = (
          await db.execute<{
            id: string;
            factors: Record<string, string>;
            gross: string;
            net_pay: string;
          }>(
            sql`select id,factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`,
            "objects",
          )
        )[0]!;
        assert.equal(stub.gross, "10000.0000");
        assert.equal(stub.factors.I, "0.0000");
        assert.equal(stub.factors.B, "10000.0000");
        assert.equal(stub.factors.CA_BONUS_I_REFERENCE, "5000.0000");
        const originalSource = await retainedBonusSource(fx.orgId, bonus.documentId);
        assert.equal(originalSource.referenceStubId, prior.id);
        assert.equal(originalSource.referenceRunId, regular.documentId);
        assert.equal(originalSource.employmentId, fx.employmentId);
        assert.equal(originalSource.subsidiaryId, fx.subsidiaryId);
        assert.equal(originalSource.currency, "CAD");
        assert.equal(originalSource.method.origin, "statutory_default");
        assert.equal(originalSource.referenceMethod, "option1");
        assert.ok(Object.values(stub.factors).every((value) => /^-?\d+(?:[.]\d+)?$/.test(value)));
        assert.equal(stub.factors.A, "70000.0000");
        assert.equal(stub.factors.A_step2, "60000.0000");
        // 2026 Ontario: federal 20.5% + provincial 9.15% over this interval;
        // personal credits and the $600 health premium cancel between legs.
        assert.equal(stub.factors.TB, "2965.0000");
        assert.equal(stub.factors.TF, "0.0000");
        assert.equal(stub.factors.TP, "0.0000");
        assert.equal(stub.factors.CA_T_BASE, "0.0000");
        assert.equal(stub.net_pay, "7035.0000");
        assert.equal(stub.factors.C, "0.0000");
        assert.equal(stub.factors.EI, "0.0000");
        await commitPayRun(draft);
        await assert.rejects(commitPayRun(bonus), /recalculate|stale/i);
        assert.deepEqual((await calculatePayRun(bonus)).errors, []);
        const recalculated = (
          await db.execute<{ factors: Record<string, string> }>(
            sql`select factors from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`,
            "objects",
          )
        )[0]!;
        assert.equal(recalculated.factors.CA_BONUS_I_REFERENCE, "9000.0000");
        assert.equal(
          (await retainedBonusSource(fx.orgId, bonus.documentId)).referenceRunId,
          draft.documentId,
        );
        assert.equal(recalculated.factors.I, "0.0000");
        assert.equal(recalculated.factors.B, "10000.0000");
        assert.equal(recalculated.factors.CA_T_BASE, "0.0000");
        await commitPayRun(bonus);
        const retained = (
          await db.execute(
            sql`select id,factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and id=${prior.id}`,
            "objects",
          )
        )[0];
        assert.deepEqual(retained, prior);
        assert.equal(
          (
            await db.execute(
              sql`select count(*)::integer n from pay_stub_lines where org_id=${fx.orgId} and stub_id in (select id from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}) and kind='earning' and amount>0`,
              "objects",
            )
          )[0]?.n,
          1,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "Option 1 bonus uses actual periodic I retained under an earlier cumulative method",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await withBypassContext(() => seedAdoption());
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update pay_schedules set frequency='monthly',periods_per_year=12,anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
        );
        const filingAccountId = randomUUID();
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
        values(${filingAccountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Canadian payroll account','regular',true,true,${fx.actorId},${fx.actorId})`);
        const profile = await db.execute(
          sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true,filing_account_id=${filingAccountId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} returning employee_party_id`,
          "objects",
        );
        assert.equal(profile.length, 1);
        await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
        values(${fx.orgId},${fx.employeeId},'CA','ca_t4127_method','{"method":"option2","reason":"Employer elected cumulative withholding"}'::jsonb,'2026-01-01',${fx.actorId},${fx.actorId})`);
      });
      await withOrgContext(fx.orgId, async () => {
        const create = async (
          start: string,
          end: string,
          amount: string,
          type: "regular" | "bonus",
        ) => {
          const run = await createPayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            payScheduleId: fx.scheduleId,
            periodStart: start,
            periodEnd: end,
            payDate: end,
            runType: type,
          });
          const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
          const component = (
            await db.execute<{ id: string }>(
              sql`select id from pay_components where org_id=${fx.orgId} and system_key=${type === "regular" ? "base_pay" : "bonus"}`,
              "objects",
            )
          )[0]!;
          await mutatePayRunAdjustment({
            ...command,
            mutation: {
              action: "add",
              employeePartyId: fx.employeeId,
              componentId: component.id,
              amount,
              replaceComponent: true,
            },
          });
          return command;
        };
        const regular = await create("2026-01-01", "2026-01-31", "5000", "regular");
        assert.deepEqual((await calculatePayRun(regular)).errors, []);
        await commitPayRun(regular);
        const before = (
          await db.execute<{ id: string; factors: Record<string, string> }>(
            sql`select id,factors from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${regular.documentId}`,
            "objects",
          )
        )[0]!;
        assert.equal(before.factors.I, "5000.0000");
        assert.equal(before.factors.S1_DEN, "1.0000");
        await withOrgTransaction(fx.orgId, async () => {
          await prepareWithholdingRecordWrite({
            orgId: fx.orgId,
            actorId: fx.actorId,
            employeePartyId: fx.employeeId,
            effectiveFrom: "2026-02-01",
            protectCommittedHistory: true,
          });
          const changed = await db.execute(
            sql`update employee_tax_certificates set superseded_on='2026-02-01',updated_at=clock_timestamp(),updated_by=${fx.actorId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} and certificate_key='ca_t4127_method' and superseded_on is null returning id`,
            "objects",
          );
          assert.equal(changed.length, 1);
          await db.execute(sql`insert into employee_tax_certificates(org_id,employee_party_id,country,certificate_key,answers,effective_from,created_by,updated_by)
          values(${fx.orgId},${fx.employeeId},'CA','ca_t4127_method','{"method":"option1","reason":"Employer elected regular withholding prospectively"}'::jsonb,'2026-02-01',${fx.actorId},${fx.actorId})`);
        });
        const bonus = await create("2026-02-01", "2026-02-28", "10000", "bonus");
        assert.deepEqual((await calculatePayRun(bonus)).errors, []);
        const factors = (
          await db.execute<{ factors: Record<string, string> }>(
            sql`select factors from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`,
            "objects",
          )
        )[0]!.factors;
        const source = await retainedBonusSource(fx.orgId, bonus.documentId);
        assert.equal(source.referenceStubId, before.id);
        assert.equal(source.referenceMethod, "option2");
        assert.equal(source.method.origin, "certificate");
        assert.equal(source.method.effectiveFrom, "2026-02-01");
        assert.equal(source.method.option, "option1");
        assert.ok(source.method.certificateId);
        assert.equal(factors.CA_BONUS_I_REFERENCE, "5000.0000");
        assert.equal(factors.I, "0.0000");
        assert.equal(factors.TB, "2965.0000");
        assert.equal(factors.CA_T_BASE, "0.0000");
        assert.equal(factors.S1_DEN, undefined);
        await commitPayRun(bonus);
        assert.deepEqual(
          (
            await db.execute(
              sql`select id,factors from pay_stubs where org_id=${fx.orgId} and id=${before.id}`,
              "objects",
            )
          )[0],
          before,
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "successive supplemental bonuses retain numeric priors and once-only reference tax with protected source identities",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await withBypassContext(() => seedAdoption());
    try {
      await withBypassContext(async () => {
        const filingAccountId = randomUUID();
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
        values(${filingAccountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Canadian payroll account','regular',true,true,${fx.actorId},${fx.actorId})`);
        await db.execute(
          sql`update pay_schedules set frequency='monthly',periods_per_year=12,anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
        );
        const profile = await db.execute(
          sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true,filing_account_id=${filingAccountId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} returning employee_party_id`,
          "objects",
        );
        assert.equal(profile.length, 1);
      });
      await withOrgContext(fx.orgId, async () => {
        const create = async (
          start: string,
          end: string,
          amount: string,
          type: "regular" | "supplemental",
        ) => {
          const run = await createPayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            payScheduleId: fx.scheduleId,
            periodStart: start,
            periodEnd: end,
            payDate: end,
            runType: type,
          });
          const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
          const component = (
            await db.execute<{ id: string }>(
              sql`select id from pay_components where org_id=${fx.orgId} and system_key=${type === "regular" ? "base_pay" : "bonus"}`,
              "objects",
            )
          )[0]!;
          await mutatePayRunAdjustment({
            ...command,
            mutation: {
              action: "add",
              employeePartyId: fx.employeeId,
              componentId: component.id,
              amount,
              replaceComponent: true,
            },
          });
          return command;
        };
        const regular = await create("2026-01-01", "2026-01-31", "5000", "regular");
        assert.deepEqual((await calculatePayRun(regular)).errors, []);
        await commitPayRun(regular);
        let tax = "0.0000";
        for (const [amount, expectedTax] of [
          ["10000", "2965.0000"],
          ["1000", "296.5000"],
          ["1000", "296.5000"],
        ] as const) {
          const bonus = await create("2026-02-01", "2026-02-28", amount, "supplemental");
          assert.deepEqual((await calculatePayRun(bonus)).errors, []);
          const first = (
            await db.execute<{ factors: Record<string, string>; gross: string; net_pay: string }>(
              sql`select factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`,
              "objects",
            )
          )[0]!;
          assert.equal(first.factors.TB, expectedTax);
          assert.equal(first.factors.I, "0.0000");
          assert.equal(first.factors.CA_T_BASE, "0.0000");
          assert.ok(
            Object.values(first.factors).every((value) => /^-?\d+(?:[.]\d+)?$/.test(value)),
          );
          const source = await retainedBonusSource(fx.orgId, bonus.documentId);
          assert.equal(source.referenceRunId, regular.documentId);
          assert.equal(source.income, "5000.0000");
          assert.deepEqual((await calculatePayRun(bonus)).errors, []);
          assert.deepEqual(
            (
              await db.execute(
                sql`select factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`,
                "objects",
              )
            )[0],
            first,
          );
          assert.deepEqual(await retainedBonusSource(fx.orgId, bonus.documentId), source);
          await commitPayRun(bonus);
          tax = add(tax, expectedTax);
        }
        assert.equal(tax, "3558.0000");
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);
