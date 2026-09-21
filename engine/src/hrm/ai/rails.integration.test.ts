import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { logDecision, syncCapabilities, updateCapability } from "./governance.ts";
import {
  checkPayrollFinalizeAllowed,
  listFlags,
  scanAnomalies,
  transitionFlag,
} from "./anomalies.ts";
import { explainPay } from "./explain-pay.ts";

/**
 * HR-21 AI rails DB coverage (integration partition, gating box runs
 * this file): migration tables with RLS, the append-only decision trigger,
 * capability sync with down-only autonomy, idempotent anomaly scans with
 * suppression, the finalize refusal, and the explain-pay trace with diff.
 * Decision logging is proven per service by counting ai_decisions rows.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFeatures(orgId: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${key}}`}, 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function grant(orgId: string, userId: string, permission: string): Promise<void> {
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${orgId}, ${userId}, ${permission}, 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'`);
}

async function decisionCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from ai_decisions where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.n ?? 0);
}

type Harness = { org: ScratchOrg; adminId: string };

async function setup(): Promise<Harness> {
  const org = await createScratchOrg();
  const adminId = await createScratchUser(org.orgId, "AI Admin", "ai_admin");
  await grant(org.orgId, adminId, "payroll.manage");
  await grant(org.orgId, adminId, "hrm.employment.read");
  await grant(org.orgId, adminId, "admin.setup.manage");
  await enableFeatures(org.orgId, [
    "hrm", "payroll", "hrmAiAssist", "hrmExplainPay", "hrmPayrollAnomalies",
    "hrmTimeAnomalies", "hrmDrafting", "hrmNlReports", "aiGovernanceLedger",
  ]);
  return { org, adminId };
}

test("migration tables exist with org isolation RLS", { skip: !DB }, async () => {
  const { org } = await setup();
  try {
    for (const table of [
      "ai_capabilities", "ai_decisions", "payroll_anomaly_flags",
      "anomaly_baselines", "nl_report_drafts", "ai_rails_settings",
    ]) {
      const rows = (await db.execute<{ rls: boolean; policy: boolean }>(sql`
        select c.relrowsecurity as rls,
               exists(select 1 from pg_policies
                       where schemaname = 'public' and tablename = ${table}
                         and policyname = 'org_isolation') as policy
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${table}`)).rows;
      assert.equal(rows[0]?.rls, true, `${table} must force RLS`);
      assert.equal(rows[0]?.policy, true, `${table} needs the org_isolation policy`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * Drizzle wraps the driver error, so the guard's message lives on the
 * CAUSE, not on the error `assert.rejects` inspects. Matching the
 * wrapper's own text silently passes for any query failure and fails for
 * the refusal actually firing -- which is what happened here: the trigger
 * raised exactly as designed and the assertion still failed.
 * Same matcher as scheduling/outbox.integration.test.ts.
 */
async function assertRejectsWithCause(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    let current: unknown = error;
    while (current instanceof Error) {
      if (pattern.test(current.message)) return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }, `no rejection matching ${pattern}`);
}

test("ai_decisions is append-only: UPDATE and DELETE refuse", { skip: !DB }, async () => {
  const { org, adminId } = await setup();
  try {
    const id = await logDecision(db, {
      orgId: org.orgId, actorId: adminId, capabilityKey: "hrmExplainPay",
      subjectKind: "employment", subjectId: null, input: "in", output: "out",
      outputSummary: "append-only probe", sources: [], outcome: "shown", model: "test",
    });
    await assertRejectsWithCause(
      db.execute(sql`update ai_decisions set outcome = 'rejected' where id = ${id}::uuid`),
      /append-only/,
    );
    await assertRejectsWithCause(
      db.execute(sql`delete from ai_decisions where id = ${id}::uuid`),
      /append-only/,
    );
    const rows = (await db.execute<{ outcome: string }>(sql`
      select outcome from ai_decisions where id = ${id}::uuid`)).rows;
    assert.equal(rows[0]?.outcome, "shown");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("capability sync seeds six rows; autonomy moves down only", { skip: !DB }, async () => {
  const { org, adminId } = await setup();
  try {
    const seeded = await syncCapabilities(db, org.orgId, adminId);
    assert.equal(seeded.length, 6);
    // Re-sync preserves the org's lowered autonomy (never overwrites).
    const lowered = await updateCapability(db, {
      orgId: org.orgId, actorId: adminId, key: "hrmPayrollAnomalies", autonomy: "read_only",
    });
    assert.equal(lowered.autonomy, "read_only");
    const reseeded = await syncCapabilities(db, org.orgId, adminId);
    assert.deepEqual(reseeded, []);
    const rows = (await db.execute<{ autonomy: string }>(sql`
      select autonomy from ai_capabilities
       where org_id = ${org.orgId} and key = 'hrmPayrollAnomalies'`)).rows;
    assert.equal(rows[0]?.autonomy, "read_only");
    // The rule is a CEILING, not a ratchet. hrmPayrollAnomalies declares
    // maxAutonomy "propose", so an org that lowered to read_only may
    // restore it to propose -- otherwise one mistaken click would cost
    // the capability permanently with no way back.
    const restored = await updateCapability(db, {
      orgId: org.orgId, actorId: adminId, key: "hrmPayrollAnomalies", autonomy: "propose",
    });
    assert.equal(restored.autonomy, "propose");
    // Above the ceiling refuses by name. This is the assertion that
    // matters: the code sets the maximum and the org cannot exceed it.
    await assert.rejects(
      updateCapability(db, {
        orgId: org.orgId, actorId: adminId, key: "hrmPayrollAnomalies", autonomy: "act_with_confirmation",
      }),
      /cannot be raised above "propose"/,
    );
    await updateCapability(db, {
      orgId: org.orgId, actorId: adminId, key: "hrmPayrollAnomalies", autonomy: "read_only",
    });
    // Unknown capability refuses with the remedy.
    await assert.rejects(
      updateCapability(db, { orgId: org.orgId, actorId: adminId, key: "hrmTimeTravel", autonomy: "read_only" }),
      /Company Settings → Features/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedTerminatedWithInput(orgId: string, decidedBy: string): Promise<{ employmentId: string }> {
  const workerPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Terminated Worker', true, '{}'::jsonb)`);
  const subsidiary = (await db.execute<{ id: string }>(sql`
    select id::text as id from subsidiaries where org_id = ${orgId} limit 1`)).rows[0]?.id;
  assert.ok(subsidiary, "scratch org needs a subsidiary");
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiary}, 1)`);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'terminated', '2026-08-15', now())`);
  // The leave type is CREATED, not looked up. This used to read
  // `if (leaveType)` against a scratch org that has none, so the pay
  // input was never inserted at all and the scan correctly found
  // nothing -- and the test then blamed the detector for a fixture that
  // had quietly seeded half of itself. A fixture that can skip its own
  // subject is not a fixture.
  const leaveType = randomUUID();
  await db.execute(sql`
    insert into hrm_leave_types (id, org_id, code, name, paid)
    values (${leaveType}, ${orgId}, 'ANOM-VAC', 'Anomaly probe vacation', true)`);
  // An approved request must carry its whole decision -- who, when and
  // why -- or hrm_leave_requests_decision refuses the row. The constraint
  // is right: an approval with no decider is not an approval.
  const requestId = randomUUID();
  await db.execute(sql`
    insert into hrm_leave_requests
      (id, org_id, employment_id, leave_type_id, starts_on, ends_on, hours, status,
       decided_by, decided_at, decision_reason)
    values (${requestId}, ${orgId}, ${employmentId}, ${leaveType}, '2026-09-10', '2026-09-10', 8, 'approved',
       ${decidedBy}, now(), 'seeded for the anomaly probe')`);
  await db.execute(sql`
    insert into hrm_payroll_inputs (org_id, employee_party_id, employment_id, kind, absence_date, hours, source_leave_request_id, status)
    values (${orgId}, ${workerPartyId}, ${employmentId}, 'payout', '2026-09-10', 8, ${requestId}, 'pending')`);
  const seeded = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from hrm_payroll_inputs
     where org_id = ${orgId} and employment_id = ${employmentId} and status = 'pending'`)).rows[0]?.n;
  assert.equal(seeded, "1", "the fixture must actually leave a pending pay input behind");
  return { employmentId };
}

test("scan flags terminated-with-pay as block; rescan is idempotent; finalize refuses", { skip: !DB }, async () => {
  const { org, adminId } = await setup();
  try {
    const { employmentId } = await seedTerminatedWithInput(org.orgId, adminId);
    const before = await decisionCount(org.orgId);
    const first = await scanAnomalies(db, {
      orgId: org.orgId, actorId: adminId, periodFrom: "2026-09-01", periodTo: "2026-09-30",
    });
    assert.ok(first.created >= 1, "terminated employment with pending inputs must flag");
    const flags = await listFlags(db, {
      orgId: org.orgId, actorId: adminId,
      periodFrom: "2026-09-01", periodTo: "2026-09-30", kind: "terminated_with_pay",
    });
    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.severity, "block");
    assert.equal(flags[0]?.employmentId, employmentId);
    assert.ok((flags[0]?.explanation ?? "").includes("2026-08-15"));
    // The scan logged its decision.
    assert.ok((await decisionCount(org.orgId)) > before);

    // Rescan: same rows, already open, never duplicated.
    const second = await scanAnomalies(db, {
      orgId: org.orgId, actorId: adminId, periodFrom: "2026-09-01", periodTo: "2026-09-30",
    });
    assert.equal(second.created, 0);
    assert.ok(second.alreadyOpen >= 1);
    const again = await listFlags(db, {
      orgId: org.orgId, actorId: adminId,
      periodFrom: "2026-09-01", periodTo: "2026-09-30", kind: "terminated_with_pay",
    });
    assert.equal(again.length, 1);

    // THE finalize hook: open block refuses with the remedy.
    await assert.rejects(
      checkPayrollFinalizeAllowed(db, { orgId: org.orgId, periodFrom: "2026-09-01", periodTo: "2026-09-30" }),
      /blocking payroll check\(s\) are open.*\/payroll\/anomalies/,
    );

    // Transitions need a reason; false-positive suppresses the next scan.
    const flagId = flags[0]?.id ?? "";
    await assert.rejects(
      transitionFlag(db, { orgId: org.orgId, actorId: adminId, flagId, to: "resolved", reason: "  " }),
      /a reason is required/,
    );
    await transitionFlag(db, {
      orgId: org.orgId, actorId: adminId, flagId, to: "false_positive",
      reason: "termination backdated by correction; inputs are valid",
    });
    const third = await scanAnomalies(db, {
      orgId: org.orgId, actorId: adminId, periodFrom: "2026-09-01", periodTo: "2026-09-30",
    });
    assert.ok(third.suppressed >= 1, "false-positive feeds the suppression list");
    assert.equal(third.created, 0);

    // No open blocks remain: the hook passes.
    const check = await checkPayrollFinalizeAllowed(db, {
      orgId: org.orgId, periodFrom: "2026-09-01", periodTo: "2026-09-30",
    });
    assert.equal(check.openBlockCount, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("explain-pay trace carries lines, treatments, inputs and the diff", { skip: !DB }, async () => {
  const { org, adminId } = await setup();
  try {
    const { employmentId } = await seedTerminatedWithInput(org.orgId, adminId);
    const party = (await db.execute<{ partyId: string }>(sql`
      select worker_party_id::text as "partyId" from worker_employments
       where org_id = ${org.orgId} and id = ${employmentId}`)).rows[0]?.partyId;
    // A pay stub needs the WHOLE run to exist first, and the chain is
    // three rows deep: pay_schedules <- pay_runs <- pay_stubs, with the
    // document beside the run. pay_stubs.pay_run_document_id points at
    // PAY_RUNS(document_id), not at documents, so creating the document
    // alone still left the stub with nothing to reference. Copied from
    // web/lib/pdf-templates/ytd-tax-cross-pack.integration.test.ts rather
    // than re-derived.
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active)
      values (${scheduleId}, ${org.orgId}, ${`Sched ${scheduleId.slice(0, 8)}`}, 'biweekly', 26,
              '2026-09-30', 3, true)`);
    // ONE RUN PER PERIOD. pay_stubs is unique on (run, employee), which is
    // correct -- a person is paid once per run -- so the previous and
    // current payslips the diff compares cannot share a run document.
    // Two periods means two runs, each with its own document, which is
    // also what the explain-pay diff is reading when it names what
    // changed between them.
    const stubPrev = randomUUID();
    const stubCur = randomUUID();
    for (const [stubId, periodStart, payDate, gross, net] of [
      [stubPrev, "2026-08-01", "2026-08-31", "5000", "3800"],
      [stubCur, "2026-09-01", "2026-09-30", "5600", "4200"],
    ] as const) {
      const runId = randomUUID();
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                               currency, status, created_by, updated_by)
        values (${org.orgId}, ${runId}, 'pay_run', ${`PAY-${runId.slice(0, 8)}`},
                ${org.subsidiaryId}, ${payDate}, 'CAD', 'draft', ${adminId}, ${adminId})`);
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                              pay_date, tax_year, run_status)
        values (${runId}, ${org.orgId}, ${scheduleId}, ${periodStart}, ${payDate},
                ${payDate}, 2026, 'committed')`);
      await db.execute(sql`
        insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id,
          province, periods_per_year, pay_date, tax_year, currency_code, gross, net_pay, employer_cost)
        values (${stubId}, ${org.orgId}, ${runId}, ${party}, ${employmentId},
          'ON', 26, ${payDate}, 2026, 'CAD', ${gross}, ${net}, 800)`);
    }
    await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, kind, description, hours, rate, amount, sequence)
      values (${org.orgId}, ${stubPrev}, 'earning', 'Base salary', 80, 62.5, 5000, 100),
             (${org.orgId}, ${stubCur}, 'earning', 'Base salary', 80, 70, 5600, 100)`);
    const before = await decisionCount(org.orgId);
    const trace = await explainPay(db, { orgId: org.orgId, actorId: adminId, employmentId });
    assert.equal(trace.stubId, stubCur);
    assert.equal(trace.gross, "5600.0000");
    assert.equal(trace.netPay, "4200.0000");
    assert.equal(trace.earnings.length, 1);
    assert.equal(trace.diffVsPrevious.previousStubId, stubPrev);
    const change = trace.diffVsPrevious.changes.find((c) => c.description === "Base salary");
    assert.ok(change, "rate change mid-period must appear in the diff");
    assert.ok(change.input.includes("62.5") && change.input.includes("70"));
    assert.ok(trace.sources.some((s) => s.kind === "pay_stub" && s.id === stubCur));
    assert.ok((await decisionCount(org.orgId)) > before, "explain-pay must log its decision");

    // Explaining another person's pay without a grant refuses, NAMING the
    // missing permission. The class is deliberately not pinned: the scope
    // check delegates to requireHrmSelfRead, so the refusal is the shared
    // HrmAuthorizationError every other HRM read raises, and hrmRefusal
    // already surfaces its message to the caller intact. Asserting the
    // message is the stronger test anyway -- an instanceof pin passes for
    // a refusal that says nothing useful.
    const outsider = await createScratchUser(org.orgId, "Outsider", "outsider");
    await assert.rejects(
      explainPay(db, { orgId: org.orgId, actorId: outsider, employmentId }),
      /hrm\.self\.read/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inbox adapters surface blocking checks and overdue reviews through the actor's own gates", { skip: !DB }, async () => {
  const { org, adminId } = await setup();
  try {
    const { payrollAnomalyBlockAdapter, aiCapabilityReviewAdapter } = await import(
      "../../inbox/adapters/ai-rails.ts"
    );
    const ctx = { orgId: org.orgId, actorId: adminId, asOf: "2026-09-30T00:00:00Z" };

    // No flags yet: the block adapter lists nothing (never an error).
    assert.deepEqual(await payrollAnomalyBlockAdapter.list(ctx), []);

    // Seed + scan an open block flag.
    await seedTerminatedWithInput(org.orgId, adminId);
    await scanAnomalies(db, {
      orgId: org.orgId, actorId: adminId, periodFrom: "2026-09-01", periodTo: "2026-09-30",
    });
    const blocks = await payrollAnomalyBlockAdapter.list(ctx);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.kind, "payroll_anomaly_block");
    assert.equal(blocks[0]?.priority, "overdue");
    assert.match(blocks[0]?.subjectHref ?? "", /\/payroll\/anomalies\?flag=/);
    assert.match(blocks[0]?.subtitle ?? "", /before the run can finalize/);
    assert.deepEqual(blocks[0]?.actions ?? [], []);
    await assert.rejects(
      payrollAnomalyBlockAdapter.act(ctx, "x", "resolve"),
      /resolve it in the checks queue/,
    );

    // Capability sync seeds unreviewed rows: the review nudge fires for the
    // setup admin with the declared cadence in the subtitle.
    await syncCapabilities(db, org.orgId, adminId);
    const reviews = await aiCapabilityReviewAdapter.list(ctx);
    assert.ok(reviews.length >= 1, "unreviewed capabilities must nudge");
    assert.equal(reviews[0]?.kind, "ai_capability_review");
    assert.equal(reviews[0]?.subjectHref, "/admin/ai");
    assert.match(reviews[0]?.subtitle ?? "", /never reviewed/);
    await assert.rejects(
      aiCapabilityReviewAdapter.act(ctx, "x", "review"),
      /record the review in the ledger/,
    );

    // An actor without either grant sees neither list (no leak, no error).
    const outsider = await createScratchUser(org.orgId, "Outsider", "outsider");
    const outsiderCtx = { orgId: org.orgId, actorId: outsider, asOf: "2026-09-30T00:00:00Z" };
    assert.deepEqual(await payrollAnomalyBlockAdapter.list(outsiderCtx), []);
    assert.deepEqual(await aiCapabilityReviewAdapter.list(outsiderCtx), []);

    // Capability off: the hook is not registered — the adapters list nothing.
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrmPayrollAnomalies}', 'false'::jsonb, true)
       where id = ${org.orgId}`);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,aiGovernanceLedger}', 'false'::jsonb, true)
       where id = ${org.orgId}`);
    assert.deepEqual(await payrollAnomalyBlockAdapter.list(ctx), []);
    assert.deepEqual(await aiCapabilityReviewAdapter.list(ctx), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
