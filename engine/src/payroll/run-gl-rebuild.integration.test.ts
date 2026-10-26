import { seedPayrollAccountingConfiguration } from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import { commitPayRun } from "./run-commit.ts";
import { returnDocumentToDraft, submitAndReleaseIfUngated } from "../flows/submit.ts";
import { readPayRunGlProjection, rebuildPayRunGlProjection } from "./run-gl-rebuild.ts";
import {
  seedHourlyPayrollTime,
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
} from "../testing/payroll-hourly-fixture.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { add, cmp } from "../money/money.ts";
import { randomUUID } from "node:crypto";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture, seedVacationTerms } from "./filing-test-fixtures.ts";
import {
  createScratchOrg,
  seedFlowActors,
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function committedRun() {
  const fx = await seedAdoption();
  const { input } = await calculatedRun(fx);
  await commitPayRun(input);
  await returnDocumentToDraft({
    ...input,
    actorId: fx.actorId,
    reason: "Review the committed projection before a new release",
  });
  return { fx, input };
}

async function lines(orgId: string, documentId: string) {
  return await db.execute<{
    account_id: string;
    amount: string;
    party_id: string | null;
    project_id: string | null;
    department_id: string | null;
    custom: Record<string, unknown>;
  }>(
    sql`
    select account_id::text as account_id, amount::text as amount, party_id::text as party_id,
           project_id::text as project_id, department_id::text as department_id, custom
      from document_lines where org_id = ${orgId} and document_id = ${documentId} order by line_number`,
    "objects",
  );
}

async function revision(orgId: string, documentId: string) {
  return (
    await db.execute<{ revision: string }>(
      sql`
    select revision_seq::text as revision from documents where org_id = ${orgId} and id = ${documentId}`,
      "objects",
    )
  )[0]!.revision;
}

async function stubLineSnapshot(orgId: string, documentId: string) {
  return await db.execute(
    sql`
    select to_jsonb(l) - 'updated_at' as row from pay_stub_lines l
      join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
     where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId} order by l.id`,
    "objects",
  );
}

function byAccount(rows: { account_id: string; amount: string }[]) {
  const out = new Map<string, string>();
  for (const row of rows) out.set(row.account_id, add(out.get(row.account_id) ?? "0", row.amount));
  return out;
}

test(
  "rebuilding a committed, never-posted projection keeps every account total and stub, records identity and audits the reason",
  { skip: !DB },
  async () => {
    const { fx, input } = await committedRun();
    try {
      const before = await lines(fx.orgId, input.documentId);
      const stubsBefore = await stubLineSnapshot(fx.orgId, input.documentId);
      const rev = await revision(fx.orgId, input.documentId);
      const result = await rebuildPayRunGlProjection({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        reason: "refine committed line identity before posting",
        expectedRevision: rev,
      });
      const after = await lines(fx.orgId, input.documentId);
      assert.equal(result.linesBefore, before.length);
      assert.equal(result.linesAfter, after.length);
      assert.notEqual(result.revision, rev);
      const totalsBefore = byAccount(before),
        totalsAfter = byAccount(after);
      assert.deepEqual([...totalsAfter.keys()].sort(), [...totalsBefore.keys()].sort());
      for (const [account, amount] of totalsBefore)
        assert.equal(cmp(totalsAfter.get(account)!, amount), 0);
      assert.ok(after.every((line) => typeof line.custom.legKind === "string"));
      assert.ok(
        after
          .filter((line) => line.custom.legKind === "expense")
          .every((line) => line.custom.employeePartyId === fx.employeeId),
      );
      assert.deepEqual(await stubLineSnapshot(fx.orgId, input.documentId), stubsBefore);
      const audit = await db.execute<{ changes: Record<string, unknown> }>(
        sql`
        select changes from audit_log where org_id = ${fx.orgId} and row_id = ${input.documentId}
           and changes->>'operation' = 'rebuild-pay-run-gl-projection'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.changes.reason, "refine committed line identity before posting");
      await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.read"]);
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"payroll":false}'::jsonb)
        where id=${fx.orgId}`);
      await assert.rejects(readPayRunGlProjection(input), /Payroll feature is disabled/);
      assert.deepEqual(await lines(fx.orgId, input.documentId), after);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a rebuild preserves the committed liability and net pay accounts after the live setup changes",
  { skip: !DB },
  async () => {
    const { fx, input } = await committedRun();
    try {
      const before = await lines(fx.orgId, input.documentId);
      const replacement = (
        await db.execute<{ id: string }>(
          sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${fx.orgId}, '2999', 'Replacement payable', 'liability_current_other', false, true, false, false, '{}'::jsonb, '{}'::jsonb, false)
      returning id::text as id`,
          "objects",
        )
      )[0]!.id;
      await db.execute(
        sql`update pay_components set liability_account_id = ${replacement}::uuid where org_id = ${fx.orgId} and liability_account_id is not null`,
      );
      await db.execute(
        sql`update orgs set settings = jsonb_set(settings, '{payroll,netPayAccountId}', to_jsonb(${replacement}::text)) where id = ${fx.orgId}`,
      );
      await rebuildPayRunGlProjection({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        reason: "rebuild after setup changed",
        expectedRevision: await revision(fx.orgId, input.documentId),
      });
      const after = await lines(fx.orgId, input.documentId);
      assert.ok(!after.some((line) => line.account_id === replacement));
      assert.deepEqual(
        [...byAccount(after).entries()].sort(),
        [...byAccount(before).entries()].sort(),
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a stale revision or a posted run refuses without touching the projection",
  { skip: !DB },
  async () => {
    const { fx, input } = await committedRun();
    try {
      const before = await lines(fx.orgId, input.documentId);
      await assert.rejects(
        rebuildPayRunGlProjection({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: fx.actorId,
          reason: "stale view",
          expectedRevision: "1",
        }),
        /changed after you opened it/,
      );
      assert.deepEqual(await lines(fx.orgId, input.documentId), before);

      const accounts = await db.execute<{ id: string; type: string }>(
        sql`select id, type from accounts where org_id = ${fx.orgId}`,
        "objects",
      );
      const account = (type: string) => accounts.find((row) => row.type === type)!.id;
      await submitAndReleaseIfUngated("pay_run", input.documentId, fx.actorId);
      await postDocument(input.documentId, {
        control: {
          ar: account("asset_receivable"),
          ap: account("liability_payable"),
          bank: account("asset_bank"),
        },
      });
      await assert.rejects(
        rebuildPayRunGlProjection({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: fx.actorId,
          reason: "after posting",
          expectedRevision: await revision(fx.orgId, input.documentId),
        }),
        /GL projection is frozen|already reached the books/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an employer-only run with no net pay rebuilds without inventing a net pay account",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await grantScratchPermissions(org.orgId, actorId, ["payroll.manage"]);
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
        },
      });
      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);
      const scheduleId = randomUUID();
      await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true, ${actorId}, ${actorId})`);
      const employeeId = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Robin Crew', true, '{}'::jsonb)`);
      await db.execute(
        sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`,
      );
      await db.execute(sql`insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'CAD', '25', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id, country, province,
                                             pay_basis, federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1, true, ${actorId}, ${actorId})`);
      await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        payDate: "2026-07-21",
        runType: "supplemental",
      });
      const base = {
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
        allowedSubsidiaryIds: null,
      };
      const reason = "Recorded as issued employer-only levy entry";
      await mutatePayRunAdjustment({
        ...base,
        reason,
        mutation: {
          action: "employer_levy_adjustment",
          employeePartyId: employeeId,
          programKey: "ca_eht",
          amount: "26.32",
          sourceKey: "source-row:eht-1",
          reason,
          sourceReference: "issued employer-only row 1",
          idempotencyKey: randomUUID(),
        },
      });
      assert.deepEqual((await calculatePayRun(base)).errors, []);
      await commitPayRun(base);
      await returnDocumentToDraft({
        ...base,
        reason: "Review employer-only coding before a new release",
      });
      const before = await lines(org.orgId, run.documentId);
      assert.ok(
        before.every((line) => line.party_id === null),
        "an employer-only projection carries no net pay leg",
      );
      await rebuildPayRunGlProjection({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
        reason: "employer-only identity rebuild",
        expectedRevision: await revision(org.orgId, run.documentId),
      });
      const after = await lines(org.orgId, run.documentId);
      assert.ok(
        !after.some((line) => line.account_id === netPayable || line.custom.legKind === "net_pay"),
      );
      assert.deepEqual(
        [...byAccount(after).entries()].sort(),
        [...byAccount(before).entries()].sort(),
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a governed correction moves a committed bank draw from expense to the bound plan liability and nothing else",
  { skip: !DB },
  async () => {
    const fx = await seedHourlyPayrollOrg();
    await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.manage", "payroll.read"]);
    try {
      const { partyId } = await seedHourlyPayrollEmployee(
        fx,
        "Committed Draw Employee",
        fx.subsidiaryId,
      );
      const payout = randomUUID();
      await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,expense_account_id,liability_account_id)
      values(${payout},${fx.orgId},'DRAW','Banked pay draw','earning','CA',true,true,true,false,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
      await db.execute(sql`insert into pay_component_statutory_treatments(org_id,pay_component_id,effective_from,program_exclusions,vacationable)
      values(${fx.orgId},${payout},'2026-01-01','{}',false)`);
      // Committed while the bank was still carried off the balance sheet: the
      // draw was stamped to its component's expense account.
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
      cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'DRAWBANK','Banked pay','money','accrue','manual',${payout},'warn',true,${fx.actorId},${fx.actorId})`);
      await db.execute(sql`insert into entitlement_ledger(org_id,plan_id,employee_party_id,movement_date,amount,kind,note,created_by,updated_by)
      values(${fx.orgId},${planId},${partyId},'2026-06-01','500','opening','carried-in balance',${fx.actorId},${fx.actorId})`);
      await seedHourlyPayrollTime(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${payout},'200')`);
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: run.documentId,
          })
        ).errors,
        [],
      );
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      await returnDocumentToDraft({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        reason: "Review entitlement liability coding before a new release",
      });
      const before = await lines(fx.orgId, run.documentId);
      const drawLine = (
        await db.execute<{ id: string }>(
          sql`select l.id::text as id from pay_stub_lines l
      join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.component_id=${payout}`,
          "objects",
        )
      )[0]!.id;
      const movementId = (
        await db.execute<{ id: string }>(
          sql`select id::text as id from entitlement_ledger
      where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} and kind='payout'`,
          "objects",
        )
      )[0]!.id;
      const stubsBefore = await stubLineSnapshot(fx.orgId, run.documentId);

      await db.execute(
        sql`update entitlement_plans set liability_account_id=${fx.accounts.vacationPayable} where org_id=${fx.orgId} and id=${planId}`,
      );
      const reviewed = await readPayRunGlProjection({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
      });
      const request = (overrides: Partial<{ hash: string; account: string }> = {}) => ({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
        reason: "carry the banked pay draw in the plan liability",
        expectedRevision: reviewed.revision,
        entitlementRelief: {
          expectedProjectionHash: overrides.hash ?? reviewed.projectionHash,
          bindings: [
            { planId, liabilityAccountId: overrides.account ?? fx.accounts.vacationPayable },
          ],
        },
      });
      await assert.rejects(
        rebuildPayRunGlProjection(request({ hash: "0".repeat(64) })),
        /changed after you reviewed it/,
      );
      await assert.rejects(
        rebuildPayRunGlProjection(request({ account: fx.accounts.otherPayable })),
        /different liability account than the plan carries/,
      );
      await db.execute(
        sql`update accounts set is_active=false where org_id=${fx.orgId} and id=${fx.accounts.vacationPayable}`,
      );
      await assert.rejects(
        rebuildPayRunGlProjection(request()),
        /not an active, postable liability account/,
      );
      await db.execute(
        sql`update accounts set is_active=true where org_id=${fx.orgId} and id=${fx.accounts.vacationPayable}`,
      );
      assert.deepEqual(
        await lines(fx.orgId, run.documentId),
        before,
        "refusals leave the projection untouched",
      );

      const result = await rebuildPayRunGlProjection(request());
      assert.equal(result.relievedLines, 1);
      const after = await lines(fx.orgId, run.documentId);
      const totalsBefore = byAccount(before),
        totalsAfter = byAccount(after);
      assert.equal(
        cmp(
          totalsAfter.get(fx.accounts.burdenExpense) ?? "0",
          add(totalsBefore.get(fx.accounts.burdenExpense)!, "-200"),
        ),
        0,
      );
      assert.equal(
        cmp(
          totalsAfter.get(fx.accounts.vacationPayable) ?? "0",
          add(totalsBefore.get(fx.accounts.vacationPayable) ?? "0", "200"),
        ),
        0,
      );
      for (const [account, amount] of totalsBefore) {
        if (account === fx.accounts.burdenExpense || account === fx.accounts.vacationPayable)
          continue;
        assert.equal(
          cmp(totalsAfter.get(account) ?? "0", amount),
          0,
          "every other account is unchanged",
        );
      }
      const relief = after.filter((line) => line.custom.legKind === "entitlement_relief");
      assert.deepEqual(
        relief.map((line) => [
          line.account_id,
          line.amount,
          line.custom.payrollExpense,
          line.custom.entitlementReliefBasis,
          line.custom.entitlementPlanId,
          line.custom.entitlementMovementId,
          line.custom.stubLineIds,
        ]),
        [
          [
            fx.accounts.vacationPayable,
            "200.0000",
            false,
            "governed_correction",
            planId,
            movementId,
            [drawLine],
          ],
        ],
      );
      assert.deepEqual(
        await stubLineSnapshot(fx.orgId, run.documentId),
        stubsBefore,
        "the committed stub lines are never changed",
      );
      const audit = await db.execute<{
        changes: {
          projectionHashBefore: string;
          entitlementRelief: { bindings: unknown[]; corrections: Record<string, unknown>[] };
        };
      }>(
        sql`
      select changes from audit_log where org_id = ${fx.orgId} and row_id = ${run.documentId}
         and changes->>'operation' = 'rebuild-pay-run-gl-projection'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.changes.projectionHashBefore, reviewed.projectionHash);
      assert.deepEqual(audit[0]!.changes.entitlementRelief.bindings, [
        { planId, liabilityAccountId: fx.accounts.vacationPayable },
      ]);
      assert.deepEqual(
        audit[0]!.changes.entitlementRelief.corrections.map((row: Record<string, unknown>) => [
          row.stubLineId,
          row.movementId,
          row.movementStubLineId,
          row.linkage,
          row.fromAccountId,
          row.toAccountId,
          row.amount,
        ]),
        [
          [
            drawLine,
            movementId,
            drawLine,
            "linked_component_lines",
            fx.accounts.burdenExpense,
            fx.accounts.vacationPayable,
            "200.0000",
          ],
        ],
      );

      // A later identity rebuild carries the correction; a second correction has nothing left to move.
      const current = await readPayRunGlProjection({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
      });
      assert.equal(current.projectionHash, result.projectionHash);
      await rebuildPayRunGlProjection({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
        reason: "refresh identity",
        expectedRevision: current.revision,
      });
      assert.deepEqual(
        [...byAccount(await lines(fx.orgId, run.documentId)).entries()].sort(),
        [...totalsAfter.entries()].sort(),
      );
      const latest = await readPayRunGlProjection({
        orgId: fx.orgId,
        documentId: run.documentId,
        actorId: fx.actorId,
      });
      await assert.rejects(
        rebuildPayRunGlProjection({
          ...request(),
          expectedRevision: latest.revision,
          entitlementRelief: {
            expectedProjectionHash: latest.projectionHash,
            bindings: [{ planId, liabilityAccountId: fx.accounts.vacationPayable }],
          },
        }),
        /no bank settlement on the bound plans left to correct/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
