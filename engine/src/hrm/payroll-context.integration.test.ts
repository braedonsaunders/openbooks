/**
 * Slice D (0186) — payroll employment context: FKs, coherence trigger,
 * partial unique, stamp backfill, resolver refusals, manager routing, and
 * the party-merge live-schema guard.
 *
 * DB-backed like every suite that asserts storage behavior; self-skips
 * without OPENBOOKS_DB_URL. One scratch org per test; teardown via
 * dropScratchOrgReporting (the governed amend path).
 *
 * On the ambiguous-manager DB case: the 0184 single_line exclusion makes two
 * live reporting lines for one employment unseedable, so the suite asserts
 * the exclusion refuses that seed (the system still refuses ambiguity, at
 * the layer that owns it) while payroll-context.test.ts unit-proves the
 * picker's coded refusal.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Ctx = {
  orgId: string;
  subId: string;
  actorId: string;
  scheduleId: string;
  componentId: string;
  planId: string;
  runId: string;
};

async function setup(): Promise<Ctx> {
  const { db } = await import("../platform/db.ts");
  const { createScratchOrg, createScratchUser } = await import("../testing/fixtures.ts");
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Payroll context actor", "payroll_context_actor");
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${actorId}, 'payroll.run', 'grant')`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-06-28', 3, true,
            ${actorId}, ${actorId})`);
  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                created_by, updated_by)
    values (${componentId}, ${org.orgId}, 'CTXREG', 'CTXREG', 'earning', 'vacation_payout',
            'fixed_amount', true, ${actorId}, ${actorId})`);
  const planId = randomUUID();
  await db.execute(sql`
    insert into entitlement_plans (id, org_id, code, name, accrual_method, cap_behavior, is_active,
                                   created_by, updated_by)
    values (${planId}, ${org.orgId}, 'CTXVAC', 'CTX vacation', 'manual', 'warn', true,
            ${actorId}, ${actorId})`);
  const runId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${runId}, 'pay_run', ${`PAY-${runId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-01', 'CAD', 'approved', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, created_by, updated_by)
    values (${runId}, ${org.orgId}, ${scheduleId}, '2026-06-15', '2026-06-28', '2026-07-01',
            2026, 'calculated', ${actorId}, ${actorId})`);
  return { orgId: org.orgId, subId: org.subsidiaryId, actorId, scheduleId, componentId, planId, runId };
}

async function teardown(orgId: string): Promise<void> {
  const { dropScratchOrgReporting } = await import("../testing/fixtures.ts");
  await dropScratchOrgReporting(orgId);
}

async function mkPerson(ctx: Ctx, name: string, subsidiaryId: string | null = ctx.subId): Promise<string> {
  const { db } = await import("../platform/db.ts");
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name, subsidiary_id, custom)
    values (${ctx.orgId}, 'person', ${name}, ${subsidiaryId}, '{}'::jsonb) returning id`)).rows[0]!.id;
}

async function mkEmployment(ctx: Ctx, workerId: string, subId: string = ctx.subId): Promise<string> {
  const { db } = await import("../platform/db.ts");
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${ctx.orgId}, ${workerId}, ${subId}) returning id`)).rows[0]!.id;
}

async function mkVersion(
  ctx: Ctx,
  employmentId: string,
  opts: { status?: string; from?: string; to?: string | null } = {},
): Promise<void> {
  const { db } = await import("../platform/db.ts");
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to)
    values (${ctx.orgId}, ${employmentId}, 1, ${opts.status ?? "active"},
            ${opts.from ?? "2024-01-01"}::date, ${opts.to ?? null}::date)`);
}

/**
 * One minimal row per 0186 table for a person. employmentId defaults to null
 * (to stamp); pass an id to probe the INSERT path. The ledger is append-only
 * (entitlement_ledger_append_only_guard refuses every UPDATE), so ledger
 * probes must set the link at INSERT — which is also the only path the stamp
 * can never rewrite (see the unstampable report).
 */
async function seedPersonRow(
  ctx: Ctx,
  table: string,
  personId: string,
  employmentId: string | null = null,
): Promise<void> {
  const { db } = await import("../platform/db.ts");
  switch (table) {
    case "employee_payroll_profiles":
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id, country, province, created_by, updated_by)
        values (${ctx.orgId}, ${personId}, ${employmentId}, ${ctx.scheduleId}, 'CA', 'BC', ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "employee_pay_components":
      await db.execute(sql`
        insert into employee_pay_components (org_id, employee_party_id, employment_id, component_id, effective_from, created_by, updated_by)
        values (${ctx.orgId}, ${personId}, ${employmentId}, ${ctx.componentId}, '2026-01-01', ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "employee_tax_certificates":
      await db.execute(sql`
        insert into employee_tax_certificates (org_id, employee_party_id, employment_id, country, certificate_key, created_by, updated_by)
        values (${ctx.orgId}, ${personId}, ${employmentId}, 'US', ${`key-${randomUUID().slice(0, 8)}`}, ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "pay_stubs":
      await db.execute(sql`
        insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, employment_id, province, periods_per_year,
                               pay_date, tax_year, currency_code, gross, created_by, updated_by)
        values (${ctx.orgId}, ${ctx.runId}, ${personId}, ${employmentId}, 'BC', 26, '2026-07-01', 2026, 'CAD', '2000.00',
                ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "payroll_opening_balances":
      await db.execute(sql`
        insert into payroll_opening_balances (org_id, employee_party_id, employment_id, tax_year, created_by, updated_by)
        values (${ctx.orgId}, ${personId}, ${employmentId}, 2026, ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "entitlement_ledger":
      await db.execute(sql`
        insert into entitlement_ledger (org_id, plan_id, employee_party_id, employment_id, movement_date, amount, kind,
                                        created_by, updated_by)
        values (${ctx.orgId}, ${ctx.planId}, ${personId}, ${employmentId}, '2026-01-01', '40.00', 'opening',
                ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "entitlement_plan_limits":
      await db.execute(sql`
        insert into entitlement_plan_limits (org_id, plan_id, employee_party_id, employment_id, max_balance, effective_from,
                                             created_by, updated_by)
        values (${ctx.orgId}, ${ctx.planId}, ${personId}, ${employmentId}, '80.00', '2026-01-01', ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "payroll_retro_settlements": {
      const retroId = randomUUID();
      const sourceId = randomUUID();
      for (const [id, status] of [[retroId, "draft"], [sourceId, "approved"]] as const) {
        await db.execute(sql`
          insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                                 currency, status, created_by, updated_by)
          values (${ctx.orgId}, ${id}, 'pay_run', ${`PAY-${id.slice(0, 8)}`},
                  ${ctx.subId}, '2026-07-01', 'CAD', ${status}, ${ctx.actorId}, ${ctx.actorId})`);
      }
      await db.execute(sql`
        insert into payroll_retro_settlements (org_id, retro_pay_run_document_id, employee_party_id, employment_id,
            source_pay_run_document_id, source_period_start, source_period_end, source_pay_date,
            source_tax_year, original_earnings, recomputed_earnings, previously_settled, delta,
            reasons, created_by, updated_by)
        values (${ctx.orgId}, ${retroId}, ${personId}, ${employmentId}, ${sourceId},
            '2026-06-01', '2026-06-14', '2026-06-20', 2026, '1000.00', '1100.00', '0', '100.00',
            '[]'::jsonb, ${ctx.actorId}, ${ctx.actorId})`);
      break;
    }
    case "pay_run_adjustments":
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id, employment_id, adjustment_type,
                                         note, created_by, updated_by)
        values (${ctx.orgId}, ${ctx.runId}, ${personId}, ${employmentId}, 'exclude', 'ctx seed', ${ctx.actorId}, ${ctx.actorId})`);
      break;
    case "pay_run_holiday_assertions":
      await db.execute(sql`
        insert into pay_run_holiday_assertions (org_id, pay_run_document_id, employee_party_id, employment_id, holiday_key,
                                                holiday_date, absent_without_consent, created_by, updated_by)
        values (${ctx.orgId}, ${ctx.runId}, ${personId}, ${employmentId}, 'ctx-day', '2026-07-01', false,
                ${ctx.actorId}, ${ctx.actorId})`);
      break;
    default:
      throw new Error(`unknown 0186 table ${table}`);
  }
}

/** Constraint/trigger names nest in the driver's cause under the query error. */
function refusalText(error: unknown): string {
  const err = error as { message?: unknown; cause?: unknown };
  return String(err.message ?? error) + String(err.cause ?? "");
}

const TABLES = [
  "employee_payroll_profiles",
  "employee_pay_components",
  "employee_tax_certificates",
  "pay_stubs",
  "payroll_opening_balances",
  "entitlement_ledger",
  "entitlement_plan_limits",
  "payroll_retro_settlements",
  "pay_run_adjustments",
  "pay_run_holiday_assertions",
] as const;

async function employmentOf(table: string, orgId: string, personId: string): Promise<string | null> {
  const { db } = await import("../platform/db.ts");
  const rows = (await db.execute<{ employmentId: string | null }>(sql`
    select employment_id as "employmentId" from ${sql.identifier(table)}
     where org_id = ${orgId} and employee_party_id = ${personId}`)).rows;
  assert.equal(rows.length, 1);
  return rows[0]!.employmentId;
}

async function personRowCount(table: string, orgId: string, personId: string): Promise<number> {
  const { db } = await import("../platform/db.ts");
  return Number((await db.execute<{ n: string }>(sql`
    select count(*)::text as n from ${sql.identifier(table)}
     where org_id = ${orgId} and employee_party_id = ${personId}`)).rows[0]!.n);
}

test("every 0186 FK refuses a cross-org employment id", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const other = await setup();
  t.after(() => teardown(other.orgId));
  const foreignWorker = await mkPerson(other, "Foreign worker");
  const foreignEmployment = await mkEmployment(other, foreignWorker);
  for (const table of TABLES) {
    const person = await mkPerson(ctx, `Cross-org ${table}`);
    await assert.rejects(
      seedPersonRow(ctx, table, person, foreignEmployment),
      (error: unknown) => {
        const text = refusalText(error);
        assert.match(text, new RegExp(`${table}_employment_tenant_fkey`),
          `${table}: cross-org refusal must name the tenant FK`);
        return true;
      },
      `${table}: cross-org employment id must be refused`,
    );
    assert.equal(await personRowCount(table, ctx.orgId, person), 0,
      `${table}: the refused INSERT wrote nothing`);
  }
});

test("the coherence trigger refuses a same-org employment of another worker, naming both ids", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const workerA = await mkPerson(ctx, "Worker A");
  const workerB = await mkPerson(ctx, "Worker B");
  const employmentA = await mkEmployment(ctx, workerA);
  for (const table of TABLES) {
    await assert.rejects(
      seedPersonRow(ctx, table, workerB, employmentA),
      (error: unknown) => {
        // PostgreSQL trigger exceptions carry the message, not the function
        // name — the contract phrase plus both ids is the stable assertion.
        const text = refusalText(error);
        assert.match(text, /names an employment of worker/);
        assert.match(text, new RegExp(employmentA), `${table}: refusal must name the employment id`);
        assert.match(text, new RegExp(workerB), `${table}: refusal must name the employee id`);
        return true;
      },
      `${table}: cross-person employment id must be refused`,
    );
    assert.equal(await personRowCount(table, ctx.orgId, workerB), 0,
      `${table}: the refused INSERT wrote nothing`);
  }
});

test("profiles carry a partial unique on employment; the legacy per-person unique stays", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const { db } = await import("../platform/db.ts");
  const worker = await mkPerson(ctx, "Profile worker");
  const employment = await mkEmployment(ctx, worker);
  await seedPersonRow(ctx, "employee_payroll_profiles", worker);
  await db.execute(sql`
    update employee_payroll_profiles set employment_id = ${employment}
     where org_id = ${ctx.orgId} and employee_party_id = ${worker}`);
  // Legacy unique still holds on unstamped rows.
  await assert.rejects(
    db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province, created_by, updated_by)
      values (${ctx.orgId}, ${worker}, ${ctx.scheduleId}, 'CA', 'BC', ${ctx.actorId}, ${ctx.actorId})`),
    (error: unknown) => {
      assert.match(refusalText(error), /employee_payroll_profiles_employee/);
      return true;
    },
    "the legacy per-person unique must stay",
  );
  // Partial unique refuses a second profile on the same employment. The
  // coherence trigger would fire first on a cross-person write (it owns that
  // refusal), so the backstop is proven with the trigger dropped inside a
  // rolled-back transaction — the committed schema is never touched.
  const twin = await mkPerson(ctx, "Twin worker");
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province, created_by, updated_by)
    values (${ctx.orgId}, ${twin}, ${ctx.scheduleId}, 'CA', 'BC', ${ctx.actorId}, ${ctx.actorId})`);
  class ProbeRollback extends Error {}
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        drop trigger employee_payroll_profiles_employment_coherence on employee_payroll_profiles`);
      await assert.rejects(
        tx.execute(sql`
          update employee_payroll_profiles set employment_id = ${employment}
           where org_id = ${ctx.orgId} and employee_party_id = ${twin}`),
        (error: unknown) => {
          assert.match(refusalText(error), /employee_payroll_profiles_employment_unique/);
          return true;
        },
        "two profiles on one employment must be refused",
      );
      throw new ProbeRollback();
    }),
    (error: unknown) => error instanceof ProbeRollback,
    "the backstop probe rolled back",
  );
});

test("plan limits refuse an employment link on non-person scopes", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const { db } = await import("../platform/db.ts");
  const worker = await mkPerson(ctx, "Limit worker");
  const employment = await mkEmployment(ctx, worker);
  await assert.rejects(
    db.execute(sql`
      insert into entitlement_plan_limits (org_id, plan_id, subsidiary_id, employment_id, max_balance,
                                           effective_from, created_by, updated_by)
      values (${ctx.orgId}, ${ctx.planId}, ${ctx.subId}, ${employment}, '80.00', '2026-01-01',
              ${ctx.actorId}, ${ctx.actorId})`),
    (error: unknown) => {
      assert.match(refusalText(error), /entitlement_plan_limits_employment_scope/);
      return true;
    },
    "subsidiary-scope limits must not carry an employment link",
  );
});

test("stamp dry-run writes nothing; the real stamp fills every table and is idempotent", { skip: !DB, timeout: 180_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const mod = await import("./payroll-context.ts");
  const worker = await mkPerson(ctx, "Stamp worker");
  const employment = await mkEmployment(ctx, worker);
  await mkVersion(ctx, employment);
  for (const table of TABLES) await seedPersonRow(ctx, table, worker);
  const dry = await mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.requiresReview, []);
  for (const table of TABLES) {
    if (table === "entitlement_ledger") {
      // Append-only: reported, never written, never refused over.
      assert.equal(dry.stamped[table], 0);
      assert.equal(dry.unstampable[table], 1, "ledger history must be reported as unstampable");
    } else {
      assert.equal(dry.stamped[table], 1, `${table}: dry-run must report one stamp`);
    }
    assert.equal(await employmentOf(table, ctx.orgId, worker), null, `${table}: dry-run wrote nothing`);
  }
  const first = await mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: false });
  assert.equal(first.dryRun, false);
  assert.equal(first.unstampable["entitlement_ledger"], 1);
  for (const table of TABLES) {
    if (table === "entitlement_ledger") continue;
    assert.equal(first.stamped[table], 1, `${table}: real stamp must write one row`);
    assert.equal(await employmentOf(table, ctx.orgId, worker), employment);
  }
  assert.equal(await employmentOf("entitlement_ledger", ctx.orgId, worker), null);
  const second = await mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: false });
  for (const table of TABLES) {
    if (table === "entitlement_ledger") continue;
    assert.equal(second.stamped[table], 0, `${table}: re-stamp must write nothing`);
    assert.equal(second.alreadyStamped[table], 1, `${table}: re-stamp must report the stamped row`);
  }
});

test("stamp refuses the org on ambiguity without allowPartial; allowPartial stamps the clean and lists the rest", { skip: !DB, timeout: 180_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const { db } = await import("../platform/db.ts");
  const mod = await import("./payroll-context.ts");
  const clean = await mkPerson(ctx, "Clean worker");
  const cleanEmployment = await mkEmployment(ctx, clean);
  await mkVersion(ctx, cleanEmployment);
  await seedPersonRow(ctx, "employee_payroll_profiles", clean);
  const ambiguous = await mkPerson(ctx, "Ambiguous worker");
  await mkEmployment(ctx, ambiguous);
  await mkEmployment(ctx, ambiguous);
  await seedPersonRow(ctx, "employee_payroll_profiles", ambiguous);
  const sub2 = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, created_by, updated_by)
    values (${sub2}, ${ctx.orgId}, ${ctx.subId}, 'Mismatch sub', 'USD', 'US', ${ctx.actorId}, ${ctx.actorId})`);
  const mismatched = await mkPerson(ctx, "Mismatched worker");
  await mkEmployment(ctx, mismatched, sub2);
  await seedPersonRow(ctx, "employee_payroll_profiles", mismatched);
  const missing = await mkPerson(ctx, "Missing worker");
  await seedPersonRow(ctx, "employee_payroll_profiles", missing);
  await assert.rejects(
    mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: false }),
    (error: unknown) => {
      assert.ok(error instanceof mod.StampRefusedError);
      const reasons = [...error.requiresReview].map((entry) => entry.reason).sort();
      assert.deepEqual(reasons, ["ambiguous_employment", "employer_mismatch", "no_employment"]);
      return true;
    },
    "a dirty org refuses without allowPartial",
  );
  assert.equal(
    await employmentOf("employee_payroll_profiles", ctx.orgId, clean),
    null,
    "the refused org wrote nothing, including the clean person",
  );
  const partial = await mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: false, allowPartial: true });
  assert.equal(await employmentOf("employee_payroll_profiles", ctx.orgId, clean), cleanEmployment);
  assert.deepEqual(
    [...partial.requiresReview].map((entry) => `${entry.partyId}:${entry.reason}`).sort(),
    [ambiguous, mismatched, missing].map((id) => `${id}:${
      id === ambiguous ? "ambiguous_employment" : id === mismatched ? "employer_mismatch" : "no_employment"
    }`).sort(),
  );
});

test("stamp refuses a stamped row that disagrees with the resolver, even under allowPartial", { skip: !DB, timeout: 180_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const mod = await import("./payroll-context.ts");
  const worker = await mkPerson(ctx, "Rehire worker");
  const first = await mkEmployment(ctx, worker);
  await mkVersion(ctx, first);
  await seedPersonRow(ctx, "employee_payroll_profiles", worker);
  await seedPersonRow(ctx, "payroll_opening_balances", worker);
  const stamped = await mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: false });
  assert.equal(stamped.stamped["employee_payroll_profiles"], 1);
  // A later rehire leaves the worker with two employments: the stamped row
  // no longer has an unambiguous resolver answer.
  await mkEmployment(ctx, worker);
  await assert.rejects(
    mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: ctx.actorId, dryRun: false, allowPartial: true }),
    (error: unknown) => {
      assert.ok(error instanceof mod.StampRefusedError);
      assert.match(error.message, new RegExp(first), "refusal must name the stamped employment");
      assert.ok(error.requiresReview.some((entry) => entry.reason === "conflicting_stamp"));
      return true;
    },
    "contradicting history refuses instead of overwriting",
  );
});

test("the stamp writer refuses an actor without payroll.run, dry-run included, writing nothing", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const mod = await import("./payroll-context.ts");
  const { createScratchUser } = await import("../testing/fixtures.ts");
  const worker = await mkPerson(ctx, "Ungranted worker");
  const employment = await mkEmployment(ctx, worker);
  await mkVersion(ctx, employment);
  for (const table of TABLES) await seedPersonRow(ctx, table, worker);
  // No grant: this actor holds no payroll.run duty (setup grants only ctx.actorId).
  const outsider = await createScratchUser(ctx.orgId, "Stamp outsider", "stamp_outsider");
  for (const dryRun of [false, true] as const) {
    await assert.rejects(
      mod.stampEmploymentContext({ orgId: ctx.orgId, actorId: outsider, dryRun }),
      (error: unknown) => {
        assert.ok(error instanceof mod.PayrollContextAuthorizationError);
        assert.match(error.message, /payroll\.run/);
        assert.match(error.message, /\/admin\/roles/);
        return true;
      },
      `unpermitted stamp must refuse (dryRun ${dryRun})`,
    );
  }
  // Asserted against row counts, not the error alone: the refused writer
  // stamped nothing on any of the nine writable tables.
  for (const table of TABLES) {
    if (table === "entitlement_ledger") continue;
    assert.equal(await employmentOf(table, ctx.orgId, worker), null,
      `${table}: the refused stamp wrote nothing`);
  }
});

test("the resolver returns the single employment and refuses the three coded cases", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const { db } = await import("../platform/db.ts");
  const mod = await import("./payroll-context.ts");
  const base = { orgId: ctx.orgId, actorId: ctx.actorId, asOf: "2026-03-01" };
  const worker = await mkPerson(ctx, "Resolved worker");
  const employment = await mkEmployment(ctx, worker);
  await mkVersion(ctx, employment);
  const resolved = await mod.resolveEmploymentForPayroll({ ...base, partyId: worker, subsidiaryId: ctx.subId });
  assert.equal(resolved.employmentId, employment);
  assert.equal(resolved.employerSubsidiaryId, ctx.subId);
  assert.equal(resolved.status, "active");
  assert.equal(resolved.revision, 1);
  const stranger = await mkPerson(ctx, "Stranger");
  await assert.rejects(
    mod.resolveEmploymentForPayroll({ ...base, partyId: stranger, subsidiaryId: ctx.subId }),
    (error: unknown) => {
      assert.ok(error instanceof mod.PayrollContextError);
      assert.equal(error.code, "no_employment");
      assert.match(error.message, /HRM employment change request/);
      assert.match(error.message, /Admin → Users/);
      return true;
    },
  );
  const doubled = await mkPerson(ctx, "Doubled worker");
  const firstDup = await mkEmployment(ctx, doubled);
  const secondDup = await mkEmployment(ctx, doubled);
  await assert.rejects(
    mod.resolveEmploymentForPayroll({ ...base, partyId: doubled, subsidiaryId: ctx.subId }),
    (error: unknown) => {
      assert.ok(error instanceof mod.PayrollContextError);
      assert.equal(error.code, "ambiguous_employment");
      assert.match(error.message, new RegExp(firstDup));
      assert.match(error.message, new RegExp(secondDup));
      return true;
    },
    "two employments never silently pick one",
  );
  const sub2 = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, created_by, updated_by)
    values (${sub2}, ${ctx.orgId}, ${ctx.subId}, 'Other sub', 'USD', 'US', ${ctx.actorId}, ${ctx.actorId})`);
  const transferred = await mkPerson(ctx, "Transferred worker");
  const transferredEmployment = await mkEmployment(ctx, transferred, sub2);
  await assert.rejects(
    mod.resolveEmploymentForPayroll({ ...base, partyId: transferred, subsidiaryId: ctx.subId }),
    (error: unknown) => {
      assert.ok(error instanceof mod.PayrollContextError);
      assert.equal(error.code, "employer_mismatch");
      assert.match(error.message, new RegExp(transferredEmployment));
      assert.match(error.message, new RegExp(ctx.subId));
      return true;
    },
  );
  // An employment with no recorded state covering the date fails closed too.
  const future = await mkPerson(ctx, "Future worker");
  const futureEmployment = await mkEmployment(ctx, future);
  await mkVersion(ctx, futureEmployment, { from: "2026-06-01" });
  await assert.rejects(
    mod.resolveEmploymentForPayroll({ ...base, partyId: future, subsidiaryId: ctx.subId }),
    (error: unknown) => {
      assert.ok(error instanceof mod.PayrollContextError);
      assert.equal(error.code, "no_employment");
      assert.match(error.message, /no recorded state as of 2026-03-01/);
      return true;
    },
  );
  // No payroll.run grant: the boundary refuses before reading.
  const outsider = await (await import("../testing/fixtures.ts")).createScratchUser(
    ctx.orgId, "No grant", "no_grant",
  );
  await assert.rejects(
    mod.resolveEmploymentForPayroll({ ...base, actorId: outsider, partyId: worker, subsidiaryId: ctx.subId }),
    (error: unknown) => {
      assert.ok(error instanceof mod.PayrollContextAuthorizationError);
      assert.match(error.message, /payroll\.run/);
      assert.match(error.message, /\/admin\/roles/);
      return true;
    },
  );
});

test("manager routing resolves the line, falls back to the supervisor, and reports no one", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const { db } = await import("../platform/db.ts");
  const mod = await import("./payroll-context.ts");
  const base = { orgId: ctx.orgId, actorId: ctx.actorId, asOf: "2026-03-01" };
  const worker = await mkPerson(ctx, "Routed worker");
  const employment = await mkEmployment(ctx, worker);
  const boss = await mkPerson(ctx, "Boss");
  const bossEmployment = await mkEmployment(ctx, boss);
  await db.execute(sql`
    insert into reporting_relationships (org_id, employment_id, manager_employment_id, kind, relationship_id, effective_from)
    values (${ctx.orgId}, ${employment}, ${bossEmployment}, 'line', ${randomUUID()}::uuid, '2024-01-01'::date)`);
  const routed = await mod.resolveManagerForRouting({ ...base, partyId: worker });
  assert.equal(routed.source, "reporting");
  assert.equal(routed.managerEmploymentId, bossEmployment);
  assert.equal(routed.managerPartyId, boss);
  // Supervisor fallback: no reporting relationship at all.
  const legacy = await mkPerson(ctx, "Legacy worker");
  await mkEmployment(ctx, legacy);
  const supervisor = await mkPerson(ctx, "Supervisor");
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, supervisor_id, is_active, created_by, updated_by)
    values (${ctx.orgId}, ${legacy}, ${supervisor}, true, ${ctx.actorId}, ${ctx.actorId})`);
  const fallen = await mod.resolveManagerForRouting({ ...base, partyId: legacy });
  assert.equal(fallen.source, "supervisor");
  assert.equal(fallen.managerPartyId, supervisor);
  assert.equal(fallen.managerEmploymentId, null);
  // Reporting governs with a null answer when history exists but nothing is
  // active: a live-asserted line whose effective window ended before asOf.
  const closed = await mkPerson(ctx, "Closed-line worker");
  const closedEmployment = await mkEmployment(ctx, closed);
  await db.execute(sql`
    insert into reporting_relationships (org_id, employment_id, manager_employment_id, kind, relationship_id,
                                         effective_from, effective_to)
    values (${ctx.orgId}, ${closedEmployment}, ${bossEmployment}, 'line', ${randomUUID()}::uuid,
            '2024-01-01'::date, '2025-01-01'::date)`);
  const none = await mod.resolveManagerForRouting({ ...base, partyId: closed });
  assert.equal(none.source, "reporting");
  assert.equal(none.managerEmploymentId, null);
  assert.equal(none.managerPartyId, null);
});

test("the single_line exclusion keeps two live lines unseedable, so ambiguity cannot persist", { skip: !DB, timeout: 120_000 }, async (t) => {
  const ctx = await setup();
  t.after(() => teardown(ctx.orgId));
  const { db } = await import("../platform/db.ts");
  const worker = await mkPerson(ctx, "Single-line worker");
  const employment = await mkEmployment(ctx, worker);
  const bossA = await mkEmployment(ctx, await mkPerson(ctx, "Boss A"));
  const bossB = await mkEmployment(ctx, await mkPerson(ctx, "Boss B"));
  await db.execute(sql`
    insert into reporting_relationships (org_id, employment_id, manager_employment_id, kind, relationship_id, effective_from)
    values (${ctx.orgId}, ${employment}, ${bossA}, 'line', ${randomUUID()}::uuid, '2024-01-01'::date)`);
  await assert.rejects(
    db.execute(sql`
      insert into reporting_relationships (org_id, employment_id, manager_employment_id, kind, relationship_id, effective_from)
      values (${ctx.orgId}, ${employment}, ${bossB}, 'line', ${randomUUID()}::uuid, '2024-01-01'::date)`),
    (error: unknown) => {
      assert.match(refusalText(error), /reporting_relationships_single_line/);
      return true;
    },
    "storage refuses the second live line; the picker unit test proves the coded refusal",
  );
});

test("the merge catalog needs no new lines: no 0186 FK targets parties(id)", { skip: !DB, timeout: 120_000 }, async () => {
  const { db } = await import("../platform/db.ts");
  const { PARTY_MERGE_REF_COVERAGE } = await import("../sync/party-merges.ts");
  const catalog = (await db.execute<{ tbl: string; col: string }>(sql`
    select distinct tc.table_name as tbl, kcu.column_name as col
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
     where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'parties' and ccu.column_name = 'id'
       and kcu.column_name <> 'org_id'`)).rows;
  const inCatalog = new Set(catalog.map((r) => `${r.tbl}.${r.col}`));
  const covered = new Set(PARTY_MERGE_REF_COVERAGE.map(([tbl, col]) => `${tbl}.${col}`));
  assert.deepEqual([...inCatalog].sort(), [...covered].sort());
});
