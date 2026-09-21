import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { mulDecimal } from "../money/money.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";
import { decideGate } from "../flows/gates.ts";
import {
  createJobFamily,
  createJobLevel,
} from "./compensation/architecture.ts";
import { createPayBand } from "./compensation/bands.ts";
import {
  approveLine,
  createCycle,
  cyclePacing,
  getCycle,
  listCycleLines,
  openCycle,
  proposeLine,
  pushCycle,
  reopenLine,
  submitCycleForApproval,
} from "./compensation/index.ts";

/**
 * F02 + F03 + F11 DB coverage (integration partition): cycle budget
 * pacing normalises every decided line to annual envelope currency with
 * exact money math, from evidence frozen at open (0243) — never
 * re-resolved live.
 *
 * - hourly deltas annualise through the wage row's own annual-hours;
 * - foreign-currency increases convert at the oriented laborFxQuote
 *   factor frozen at open (direct-or-inverse, direct wins ties);
 * - same-date FX rewrites, wage annual-hours mutations, late-arriving
 *   pre-effective rows and supersessions cannot reprice decided lines;
 * - budget null is absence, budget 0 is a real envelope (positive
 *   increase is over with no percentage to name — never 'undefined%');
 * - exact comparison decides over-budget; floats are display only;
 * - legacy (pre-freeze) hourly/cross-currency lines refuse by name as
 *   missing historical budget evidence; annual same-currency legacy
 *   lines resolve their identity factor directly; nothing is
 *   backfilled or fabricated;
 * - proposals derive exact persisted wages at 6dp percent precision
 *   (100.0050 + 1% stores 101.0051), guideline limits assess the exact
 *   ratio, and >6 meaningful places refuse clearly.
 *
 * Proofs are read back from storage, never from return values alone.
 * Dedicated file: the shared compensation.integration suite stays owned
 * by the scope worker (but is run for validation).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  hrId: string;
};

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${org.orgId}`);
  const hrId = await createScratchUser(org.orgId, "Budget HR", "budget_hr");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage", "hrm.compensation.approve"]);
  await linkPerson(org.orgId, hrId);
  return { org, hrId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  if (!DB) return;
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedPositionedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: { workerPartyId?: string; levelId?: string | null },
): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${orgId}, 'person', 'Budget Worker', true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  if (opts.levelId !== undefined) {
    const positionId = randomUUID();
    await db.execute(sql`
      insert into positions (id, org_id, position_code, revision)
      values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 6)}`}, 1)
    `);
    await db.execute(sql`
      insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
        employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
      values (${orgId}, ${positionId}, 1, 'Engineer', null, null,
        ${subsidiaryId}, 1, 'filled', '2020-01-01', ${opts.levelId})
    `);
    const assignmentId = randomUUID();
    await db.execute(sql`
      insert into employment_assignments (id, org_id, employment_id, assignment_key)
      values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
    `);
    await db.execute(sql`
      insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
        job_title, department_id, fte, is_primary, effective_from, position_id)
      values (${orgId}, ${assignmentId}, ${employmentId}, 1,
        'Engineer', null, 1, true, '2020-01-01', ${positionId})
    `);
  }
  return { employmentId, workerPartyId };
}

async function seedWage(
  orgId: string,
  actorId: string,
  workerPartyId: string,
  rate: string,
  opts?: { currency?: string; basis?: "hour" | "year"; annualHours?: string; from?: string },
): Promise<void> {
  const { withOrgTransaction } = await import("../platform/db.ts");
  const { supersedeLaborCostRate } = await import("../projects/labor-cost-rates.ts");
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: workerPartyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: opts?.from ?? "2020-01-01",
      rate,
      currency: opts?.currency ?? "CAD",
      basis: opts?.basis ?? "year",
      annualHours: opts?.annualHours ?? "2080",
      notes: null,
      reason: "budget test wage",
    });
  });
}

async function seedArchitecture(orgId: string, hrId: string) {
  const family = await createJobFamily({ orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const level = await createJobLevel({
    orgId,
    actorId: hrId,
    familyId: family.id,
    code: "IC3",
    name: "Engineer III",
    rank: 3,
    equalValueCriteria: [{ criterion: "skills", weight: "3" }],
  });
  await createPayBand({
    orgId,
    actorId: hrId,
    scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
    currency: "CAD",
    basis: "annual",
    min: "80000",
    target: "100000",
    max: "120000",
    effectiveFrom: "2020-01-01",
    reason: "budget test band",
  });
  await createPayBand({
    orgId,
    actorId: hrId,
    scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
    currency: "CAD",
    basis: "hourly",
    min: "20",
    target: "25",
    max: "30",
    effectiveFrom: "2020-01-01",
    reason: "budget test hourly band",
  });
  return { level };
}

const GUIDELINE = {
  rows: ["meets"],
  cols: ["q1", "q2", "q3", "q4"],
  cells: { meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } } },
  unratedRow: "meets",
};

async function seedFx(orgId: string, from: string, to: string, asOf: string, rate: string, source = "manual"): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}::date, 'spot', ${rate}, ${source})
  `);
}

/** Trigger refusals arrive wrapped: Drizzle carries the pg message on the cause chain. */
function refusalMatches(pattern: RegExp): (e: unknown) => boolean {
  return (e: unknown) => {
    let current: unknown = e;
    for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && pattern.test(message)) return true;
      current = (current as { cause?: unknown }).cause ?? null;
    }
    return false;
  };
}

async function storedLine(orgId: string, lineId: string): Promise<Record<string, string | null>> {
  const row = (await db.execute<Record<string, string | null>>(sql`
    select status, proposed_rate::text as proposed_rate, proposed_pct::text as proposed_pct,
           budget_pricing_date::text as budget_pricing_date, budget_cycle_currency,
           budget_envelope::text as budget_envelope,
           budget_annual_hours::text as budget_annual_hours,
           budget_fx_rate::text as budget_fx_rate,
           budget_fx_asof::text as budget_fx_asof, budget_fx_source,
           budget_fx_inverse::text as budget_fx_inverse
      from hrm_comp_cycle_lines where org_id = ${orgId} and id = ${lineId}`)).rows[0];
  return { ...(row as Record<string, string | null>) };
}

test("F02 hourly raises freeze the wage row's annual-hours at open", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    // $25/hr on a 2000-hour row (deliberately not 2080: the pacing must
    // use the frozen row value, never a fabricated default).
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "25", { basis: "hour", annualHours: "2000" });
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "1000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(line!.basis, "hourly");
    assert.equal(line!.currentRate, "25.0000");
    const frozen = await storedLine(org.orgId, line!.id);
    assert.equal(frozen.budget_pricing_date, "2025-04-01");
    assert.equal(frozen.budget_cycle_currency, "CAD");
    assert.equal(frozen.budget_envelope, "1000.0000");
    assert.equal(frozen.budget_annual_hours, "2000.0000");
    assert.equal(frozen.budget_fx_rate, null);
    // +3% is inside the hourly guideline (1–3%) yet $0.75 × 2000h =
    // $1500 against the $1000 envelope: the budget control — not the
    // guideline — must refuse it. The old math paced $0.75/$1000 = 0.1%.
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3 }),
      /over-budget pacing needs a reason/,
    );
    const untouched = await storedLine(org.orgId, line!.id);
    assert.equal(untouched.status, "pending");
    // With a reason the same proposal lands, paced at 150%.
    const proposed = await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3, reason: "hourly merit" });
    assert.equal(proposed.proposedRate, "25.7500");
    assert.equal((await storedLine(org.orgId, line!.id)).proposed_pct, "3.000000");
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(pacing.totalPct !== null && Math.abs(pacing.totalPct - 150) < 1e-9, `expected 150%, got ${pacing.totalPct}`);
    assert.equal(pacing.overBudget, true);
  });
});

test("F02 mixed hourly/annual bases pace in one annual envelope", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const hourly = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, hourly.workerPartyId, "25", { basis: "hour", annualHours: "2000" });
    const annual = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, annual.workerPartyId, "90000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "5000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const hourlyLine = lines.find((l) => l.employmentId === hourly.employmentId)!;
    const annualLine = lines.find((l) => l.employmentId === annual.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: hourlyLine.id, proposedPct: 4, reason: "hourly merit" });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: annualLine.id, proposedPct: 3, reason: "annual merit" });
    // $1 × 2000h = $2000 plus $2700 = $4700 of a $5000 envelope: 94%.
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(pacing.totalPct !== null && Math.abs(pacing.totalPct - 94) < 1e-9, `expected 94%, got ${pacing.totalPct}`);
    assert.equal(pacing.overBudget, false);
  });
});

test("F02 cross-currency lines freeze the oriented quote at open", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "100000", { currency: "USD" });
    await seedFx(org.orgId, "USD", "CAD", "2025-01-01", "1.35", "bank");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "10000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(line!.currency, "USD");
    const frozen = await storedLine(org.orgId, line!.id);
    assert.equal(frozen.budget_fx_rate, "1.3500000000");
    assert.equal(frozen.budget_fx_asof, "2025-01-01");
    assert.equal(frozen.budget_fx_source, "bank");
    assert.equal(frozen.budget_fx_inverse, "false");
    // +10% = $10000 USD × 1.35 = $13500 CAD of a $10000 envelope: 135%.
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 10, reason: "us merit" });
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(pacing.totalPct !== null && Math.abs(pacing.totalPct - 135) < 1e-9, `expected 135%, got ${pacing.totalPct}`);
    assert.equal(pacing.overBudget, true);
  });
});

test("F02 frozen evidence survives same-date rewrites, late rows, supersession", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const hourly = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, hourly.workerPartyId, "25", { basis: "hour", annualHours: "2000" });
    const usd = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, usd.workerPartyId, "100000", { currency: "USD" });
    await seedFx(org.orgId, "USD", "CAD", "2025-01-01", "1.35", "bank");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "20000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const hourlyLine = lines.find((l) => l.employmentId === hourly.employmentId)!;
    const usdLine = lines.find((l) => l.employmentId === usd.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: hourlyLine.id, proposedPct: 4, reason: "hourly merit" });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: usdLine.id, proposedPct: 10, reason: "us merit" });
    // $2000 + $13500 = $15500 of $20000: 77.5%.
    const before = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(before.totalPct !== null && Math.abs(before.totalPct - 77.5) < 1e-9, `expected 77.5%, got ${before.totalPct}`);
    // Hostile mutations, each of which would win a live re-resolution:
    // same-as_of FX rewrite, a late-arriving pre-effective row, a direct
    // rewrite of the selected wage row's annual-hours, a superseding
    // wage row, and an org-settings rewrite.
    await db.execute(sql`
      update fx_rates set rate = '1.50', source = 'reimport'
       where org_id = ${org.orgId} and from_currency = 'USD' and to_currency = 'CAD' and as_of = '2025-01-01'::date`);
    await seedFx(org.orgId, "USD", "CAD", "2025-03-01", "1.10", "late");
    await db.execute(sql`
      update labor_cost_rates set annual_hours = '1000'
       where org_id = ${org.orgId} and employee_party_id = ${hourly.workerPartyId} and is_active`);
    await seedWage(org.orgId, h.hrId, hourly.workerPartyId, "30", { basis: "hour", annualHours: "1500", from: "2025-02-01" });
    const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
      select settings from orgs where id = ${org.orgId}`)).rows[0]?.settings ?? {};
    await db.execute(sql`
      update orgs
         set settings = ${JSON.stringify({ ...(current as Record<string, unknown>), laborCosting: { mode: "off", hoursPerDay: 8, annualHours: 1000, components: [] } })}::jsonb
       where id = ${org.orgId}`);
    const after = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(after.totalPct !== null && Math.abs(after.totalPct - 77.5) < 1e-9, `mutations repriced the cycle: ${after.totalPct}`);
    assert.equal(after.overBudget, false);
    // The frozen copies are byte-identical; the live rows moved on.
    const frozenHourly = await storedLine(org.orgId, hourlyLine.id);
    assert.equal(frozenHourly.budget_annual_hours, "2000.0000");
    const frozenUsd = await storedLine(org.orgId, usdLine.id);
    assert.equal(frozenUsd.budget_fx_rate, "1.3500000000");
    assert.equal(frozenUsd.budget_fx_asof, "2025-01-01");
    assert.equal(frozenUsd.budget_fx_source, "bank");
  });
});

test("F02 inverse quotes freeze oriented; unconfigured currency fails the open", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    // Only the USD→CAD direction is quoted; the USD-envelope cycle
    // freezes the exact inverse for its CAD line.
    await seedFx(org.orgId, "USD", "CAD", "2025-01-01", "1.35", "bank");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "10000",
      currency: "USD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const frozen = await storedLine(org.orgId, line!.id);
    assert.equal(frozen.budget_fx_rate, "0.7407407407");
    assert.equal(frozen.budget_fx_inverse, "true");
    assert.equal(frozen.budget_fx_source, "bank");
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3, reason: "cad merit" });
    // $2700 CAD × 0.7407407407 = $2000 USD of a $10000 envelope: 20%.
    // (The oriented factor multiplies once — never inverted again.)
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(pacing.totalPct !== null && Math.abs(pacing.totalPct - 20) < 1e-9, `expected 20%, got ${pacing.totalPct}`);
    assert.equal(pacing.overBudget, false);
    // An enveloped cycle with an unconfigured currency fails the open
    // atomically: the draft survives with no lines for retry, instead
    // of opening a round that can never price.
    const eur = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, eur.workerPartyId, "80000", { currency: "EUR" });
    const eurCycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit EUR", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "10000",
      currency: "USD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await assert.rejects(
      openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: eurCycle.id }),
      /cannot open: no spot rate for EUR→USD on or before 2025-04-01.*open the same draft again/,
    );
    const draft = await getCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: eurCycle.id });
    assert.equal(draft.status, "draft");
    const lineCount = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_comp_cycle_lines where org_id = ${org.orgId} and cycle_id = ${eurCycle.id}`)).rows[0];
    assert.equal(lineCount?.n, "0");
    // A null-envelope cycle needs no unused FX to open.
    const freeCycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit free", kind: "merit",
      effectiveOn: "2025-04-01", currency: "USD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    const openedFree = await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: freeCycle.id });
    assert.ok(openedFree.lines >= 2);
  });
});

test("F02 legacy lines without frozen evidence refuse by name, history preserved", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const annualEmp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    const hourlyEmp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    const mkLegacyCycle = async (name: string): Promise<string> => {
      const created = await createCycle({
        orgId: org.orgId, actorId: h.hrId, name, kind: "merit",
        effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "100000",
        currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
      });
      return created.id;
    };
    // Pre-freeze rows, inserted directly with NULL evidence: an annual
    // same-currency line (identity-resolvable) and an hourly line
    // (historical inputs gone).
    const annualCycleId = await mkLegacyCycle("Legacy annual");
    await db.execute(sql`
      insert into hrm_comp_cycle_lines (org_id, cycle_id, employment_id, current_rate, currency, basis,
        status, proposed_rate, proposed_pct, reason, created_by, updated_by)
      values (${org.orgId}, ${annualCycleId}, ${annualEmp.employmentId}, '90000', 'CAD', 'annual',
        'proposed', '92700', '3', 'legacy', ${h.hrId}, ${h.hrId})`);
    const hourlyCycleId = await mkLegacyCycle("Legacy hourly");
    await db.execute(sql`
      insert into hrm_comp_cycle_lines (org_id, cycle_id, employment_id, current_rate, currency, basis,
        status, proposed_rate, proposed_pct, reason, created_by, updated_by)
      values (${org.orgId}, ${hourlyCycleId}, ${hourlyEmp.employmentId}, '25', 'CAD', 'hourly',
        'proposed', '26', '4', 'legacy', ${h.hrId}, ${h.hrId})`);
    // The annual legacy line paces on identity: $2700/$100000 = 2.7%.
    const pacing = await cyclePacing(org.orgId, h.hrId, annualCycleId);
    assert.ok(pacing.totalPct !== null && Math.abs(pacing.totalPct - 2.7) < 1e-9, `expected 2.7%, got ${pacing.totalPct}`);
    assert.equal(pacing.overBudget, false);
    // The hourly legacy line refuses as missing historical evidence —
    // and the row survives untouched.
    const refusal = await cyclePacing(org.orgId, h.hrId, hourlyCycleId).then(
      () => { throw new Error("expected legacy pacing to refuse"); },
      (e: unknown) => String((e as { message?: unknown }).message ?? e),
    );
    assert.match(refusal, /no frozen budget evidence/);
    assert.match(refusal, /new cycle/);
    assert.ok(!/delete/i.test(refusal), `must not imply deleting history: ${refusal}`);
    const rows = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from hrm_comp_cycle_lines where org_id = ${org.orgId} and cycle_id = ${hourlyCycleId}`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "proposed");
  });
});

test("F02 frozen inputs and headers cannot be rewritten; reopen does not reprice", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "25", { basis: "hour", annualHours: "2000" });
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "100000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 4, reason: "hourly merit" });
    // A draft header still corrects freely; the freeze engages at open.
    const draftCycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Draft fix", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "5",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await db.execute(sql`
      update hrm_comp_cycles set budget_total = '6'
       where org_id = ${org.orgId} and id = ${draftCycle.id}`);
    const corrected = await getCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: draftCycle.id });
    assert.equal(corrected.budgetTotal, "6.0000");
    // Direct rewrites of frozen evidence refuse on every path (the
    // trigger message arrives wrapped in the driver error).
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycle_lines set currency = 'USD'
         where org_id = ${org.orgId} and id = ${line!.id}`),
      refusalMatches(/budget evidence is frozen at open/),
    );
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycle_lines set budget_annual_hours = '1000'
         where org_id = ${org.orgId} and id = ${line!.id}`),
      refusalMatches(/budget evidence is frozen at open/),
    );
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycles set budget_total = '1'
         where org_id = ${org.orgId} and id = ${cycle.id}`),
      refusalMatches(/budget header is frozen at open/),
    );
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycles set effective_on = '2025-05-01'::date
         where org_id = ${org.orgId} and id = ${cycle.id}`),
      refusalMatches(/budget header is frozen at open/),
    );
    // Two-step reset: rewinding the opened round to draft refuses, so
    // no follow-up edit can regain draft-edit privileges or NULL out
    // the envelope to disable pacing — the failed write leaves the
    // round exactly as it was.
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycles set status = 'draft'
         where org_id = ${org.orgId} and id = ${cycle.id}`),
      refusalMatches(/lifecycle moves forward only/),
    );
    const stillOpen = await getCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(stillOpen.status, "open");
    assert.equal(stillOpen.budgetTotal, "100000.0000");
    // Line reparenting: a decided line cannot move to a differently
    // priced round (or a different employment) carrying its evidence.
    const other = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Other round", kind: "merit",
      effectiveOn: "2025-06-01", budgetBasis: "combined", budgetTotal: "1",
      currency: "USD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycle_lines set cycle_id = ${other.id}
         where org_id = ${org.orgId} and id = ${line!.id}`),
      refusalMatches(/budget evidence is frozen at open/),
    );
    await assert.rejects(
      db.execute(sql`
        update hrm_comp_cycle_lines set employment_id = ${randomUUID()}
         where org_id = ${org.orgId} and id = ${line!.id}`),
      refusalMatches(/budget evidence is frozen at open/),
    );
    const unmoved = await storedLine(org.orgId, line!.id);
    assert.equal(unmoved.budget_annual_hours, "2000.0000");
    assert.equal(unmoved.budget_envelope, "100000.0000");
    // Ordinary writes still work, and a reopen carries frozen inputs
    // forward untouched: approve (by a second approver — the proposer
    // cannot decide their own line), reopen, same pacing.
    const approver = await createScratchUser(org.orgId, "Guard Approver", "guard_approver");
    await grantPermissions(org.orgId, approver, ["hrm.compensation.approve"]);
    await linkPerson(org.orgId, approver);
    const approved = await approveLine({ orgId: org.orgId, actorId: approver, lineId: line!.id });
    assert.equal(approved.status, "approved");
    const pacingBefore = await cyclePacing(org.orgId, h.hrId, cycle.id);
    const reopened = await reopenLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, reason: "recheck" });
    assert.equal(reopened.status, "proposed");
    const frozen = await storedLine(org.orgId, line!.id);
    assert.equal(frozen.budget_annual_hours, "2000.0000");
    assert.equal(frozen.budget_envelope, "100000.0000");
    const pacingAfter = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.equal(pacingAfter.totalPct, pacingBefore.totalPct);
    assert.equal(pacingAfter.overBudget, pacingBefore.overBudget);
  });
});

test("F03 a zero envelope is real: positive increases are over with no percentage", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "0",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    // No decided lines yet: zero increase is not over.
    const empty = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.equal(empty.totalPct, null);
    assert.equal(empty.overBudget, false);
    // A raise without a reason refuses with a usable numberless remedy.
    const refusal = await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3 }).then(
      () => { throw new Error("expected the zero-envelope proposal to refuse"); },
      (e: unknown) => String((e as { message?: unknown }).message ?? e),
    );
    assert.match(refusal, /takes the cycle over its budget envelope/);
    assert.ok(!/%/.test(refusal), `refusal must carry no percentage: ${refusal}`);
    assert.ok(!/undefined|NaN|null/.test(refusal), `refusal must not leak placeholders: ${refusal}`);
    const rolledBack = await storedLine(org.orgId, line!.id);
    assert.equal(rolledBack.status, "pending");
    // With a reason it lands, paced over with no defined ratio.
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3, reason: "zero-envelope merit" });
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.equal(pacing.totalPct, null);
    assert.equal(pacing.overBudget, true);
  });
});

test("F03 a null envelope is absence: never over, even for large raises", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    // Null-envelope lines acquire no evidence they will never use.
    const frozen = await storedLine(org.orgId, line!.id);
    assert.equal(frozen.budget_pricing_date, "2025-04-01");
    assert.equal(frozen.budget_envelope, null);
    assert.equal(frozen.budget_annual_hours, null);
    assert.equal(frozen.budget_fx_rate, null);
    const proposed = await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 50, reason: "big merit" });
    assert.equal(proposed.status, "proposed");
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.equal(pacing.totalPct, null);
    assert.equal(pacing.overBudget, false);
  });
});

test("F02/F03 exact comparison at large boundary values", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "1000000000000.0000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "50000000000.0000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const line = lines.find((l) => l.employmentId === emp.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line.id, proposedPct: 10, reason: "large merit" });
    const stored = await storedLine(org.orgId, line.id);
    assert.equal(stored.proposed_rate, "1100000000000.0000");
    assert.equal(stored.proposed_pct, "10.000000");
    // +100bn against a 50bn envelope: exactly 200%, decided by exact
    // comparison rather than float division.
    const pacing = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.equal(pacing.overBudget, true);
    assert.ok(pacing.totalPct !== null && Number.isFinite(pacing.totalPct) && Math.abs(pacing.totalPct - 200) < 1e-6, `expected 200%, got ${pacing.totalPct}`);
  });
});

test("F11 six-decimal percents store consistent rate evidence; deeper refuses", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    // 6dp is accepted and the stored rate recomputes from the stored
    // percent through the shared primitive (90000 × 1.03123456).
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3.123456, reason: "fine merit" });
    const stored = await storedLine(org.orgId, line!.id);
    assert.equal(stored.proposed_pct, "3.123456");
    assert.equal(stored.proposed_rate, "92811.1104");
    assert.equal(mulDecimal("90000.0000", "1.03123456"), stored.proposed_rate);
    // 7 meaningful places refuse with a usable remedy, never a silent
    // rounding of one evidence against the other.
    const emp2 = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp2.workerPartyId, "90000");
    const cycle2 = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle2.id });
    const lines2 = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle2.id });
    const line2 = lines2.find((l) => l.employmentId === emp2.employmentId)!;
    const before = await storedLine(org.orgId, line2.id);
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line2.id, proposedPct: 3.1234567, reason: "too fine" }),
      /at most 6 decimal places/,
    );
    const untouched = await storedLine(org.orgId, line2.id);
    assert.equal(untouched.status, before.status);
    assert.equal(untouched.proposed_rate, before.proposed_rate);
  });
});

test("F11 proposal wages round once, exactly, and the push carries them", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const penny = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, penny.workerPartyId, "100.0050");
    const heavy = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, heavy.workerPartyId, "60000.0001");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const pennyLine = lines.find((l) => l.employmentId === penny.employmentId)!;
    const heavyLine = lines.find((l) => l.employmentId === heavy.employmentId)!;
    // 100.0050 × 1.01 = 101.00505 → 101.0051 (float math stored 101.0050).
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: pennyLine.id, proposedPct: 1, reason: "penny merit" });
    const pennyStored = await storedLine(org.orgId, pennyLine.id);
    assert.equal(pennyStored.proposed_rate, "101.0051");
    assert.equal(pennyStored.proposed_pct, "1.000000");
    assert.equal(mulDecimal("100.0050", "1.01000000"), pennyStored.proposed_rate);
    // 60000.0001 × 1.5 = 90000.00015 → 90000.0002 (float math stored …001).
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: heavyLine.id, proposedPct: 50, reason: "heavy merit" });
    const heavyStored = await storedLine(org.orgId, heavyLine.id);
    assert.equal(heavyStored.proposed_rate, "90000.0002");
    assert.equal(heavyStored.proposed_pct, "50.000000");
    assert.equal(mulDecimal("60000.0001", "1.50000000"), heavyStored.proposed_rate);
    // The typed-rate direction derives its percent exactly too.
    const annual = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, annual.workerPartyId, "90000");
    const cycle2 = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle2.id });
    const lines2 = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle2.id });
    const annualLine = lines2.find((l) => l.employmentId === annual.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: annualLine.id, proposedRate: "92700", reason: "typed merit" });
    const annualStored = await storedLine(org.orgId, annualLine.id);
    assert.equal(annualStored.proposed_rate, "92700.0000");
    assert.equal(annualStored.proposed_pct, "3.000000");
    // The push writes the exact decided wage, not the float neighbour.
    const approver = await createScratchUser(org.orgId, "Exact Approver", "exact_approver");
    await grantPermissions(org.orgId, approver, ["hrm.compensation.read", "hrm.compensation.approve"]);
    await linkPerson(org.orgId, approver);
    await seedApprovalFlow(org.orgId, {
      subjectKind: HRM_COMP_CYCLE_SUBJECT_KIND,
      assignees: [{ type: "user", userId: approver }],
      mode: "any",
    });
    await submitCycleForApproval({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const gate = (await db.execute<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${cycle.id} order by created_at`)).rows[0]!;
    await decideGate({ gateId: gate.id, decision: "approved", userId: approver });
    await approveLine({ orgId: org.orgId, actorId: approver, lineId: pennyLine.id });
    await approveLine({ orgId: org.orgId, actorId: approver, lineId: heavyLine.id });
    const pushed = await pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(pushed.pushed, 2);
    const wages = (await db.execute<{ party: string; rate: string }>(sql`
      select employee_party_id as party, rate::text as rate from labor_cost_rates
       where org_id = ${org.orgId}
         and employee_party_id in (${penny.workerPartyId}, ${heavy.workerPartyId})
         and effective_from = '2025-04-01'::date and is_active`)).rows;
    const byParty = new Map(wages.map((w) => [w.party, w.rate]));
    assert.equal(byParty.get(penny.workerPartyId), "101.0051");
    assert.equal(byParty.get(heavy.workerPartyId), "90000.0002");
  });
});

test("F11 guideline limits assess the exact ratio, not the display rounding", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "100000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    // 103000.0050 off 100000 is exactly 3.000005% (ratio 1.0 → q3 meets
    // caps at 3%). Float display rounds it to 3 and waves it through;
    // the exact cross-product refuses it without a reason.
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedRate: "103000.0050" }),
      /outside the guideline 1%–3%.*need a reason/,
    );
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedRate: "103000.0050", reason: "hair over" });
    const stored = await storedLine(org.orgId, line!.id);
    assert.equal(stored.proposed_rate, "103000.0050");
    assert.equal(stored.proposed_pct, "3.000005");
  });
});

test("F11 a raise off a zero current rate is explicit, never fabricated", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "0");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const line = lines.find((l) => l.employmentId === emp.employmentId)!;
    assert.equal(line.currentRate, "0.0000");
    // The percent is undefined off zero: without a reason it refuses and
    // names the condition instead of storing a fabricated zero.
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line.id, proposedRate: "100" }),
      /starts from a zero current rate/,
    );
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line.id, proposedRate: "100", reason: "first wage" });
    const stored = await storedLine(org.orgId, line.id);
    assert.equal(stored.proposed_rate, "100.0000");
    assert.equal(stored.proposed_pct, null);
  });
});

test("F02/F03 the public read stays lens-scoped while the write control sees the whole cycle", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    const empB = await seedPositionedEmployment(org.orgId, subB, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, empA.workerPartyId, "90000");
    await seedWage(org.orgId, h.hrId, empB.workerPartyId, "100000");
    const readerA = await createScratchUser(org.orgId, "Budget Reader A", "budget_reader_a");
    await db.execute(sql`
      update app_roles
         set permissions = '["hrm.compensation.read"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'budget_reader_a'`);
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "5000",
      currency: "CAD", guidelineKind: "matrix", guideline: GUIDELINE,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lineA = lines.find((l) => l.employmentId === empA.employmentId)!;
    const lineB = lines.find((l) => l.employmentId === empB.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: lineA.id, proposedPct: 3, reason: "scope test" });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: lineB.id, proposedPct: 3, reason: "scope test" });
    // Whole cycle paces $5700/$5000 = 114% (over); the A-scoped read
    // fences to A's $2700/$5000 = 54% without leaking B's increase.
    const full = await cyclePacing(org.orgId, h.hrId, cycle.id);
    assert.ok(full.totalPct !== null && Math.abs(full.totalPct - 114) < 1e-9, `expected 114%, got ${full.totalPct}`);
    assert.equal(full.overBudget, true);
    const scoped = await cyclePacing(org.orgId, readerA, cycle.id);
    assert.ok(scoped.totalPct !== null && Math.abs(scoped.totalPct - 54) < 1e-9, `expected 54%, got ${scoped.totalPct}`);
    assert.equal(scoped.overBudget, false);
  });
});
