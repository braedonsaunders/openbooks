import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../../testing/fixtures.ts";
import {
  grantPermissions, linkPerson, refusalOf, seedEmployment, seedLevel, seedPayGapWorker,
  seedPositionedEmployment, seedWage, setCompensationSettings, setFeatures, type Refusal,
} from "../../testing/hrm-harness.ts";
import { NOT_VISIBLE, countRows, refusal, refusesLikeUnknown, scopeMatrix, scopeRow, type ScopeWorld } from "../../testing/hrm-scope-matrix.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import {
  CompensationError, approvePlan, approvePlanLine, attachStatementPdf, cancelCycle, closeCycle, closePlan, compaRatioFor,
  computeGapSnapshot, createCycle, createPayBand, createPlan, createPlanLine, fulfilPayInformationRequest, generateStatement,
  latestGapSnapshot, listPayBands, listPlanLines, listPlanLinesForPlans, listPlans, listStatements, proposeLine, refusePayInformationRequest,
  renderStatementPdf, requestPayInformation, submitCycleForApproval, submitPlan,
} from "./index.ts";
import { compensationArchitectureSummary } from './overview.ts';
import { listPayBandVersions } from './bands.ts';
import { listJobFamilies, listJobLevels } from './architecture.ts';

/**
 * Compensation under a legal-entity lens. Salary-bearing reads and writes
 * (bands, placement, headcount lines, merit cycles, statements) stay inside
 * the actor's employer-subsidiary lens and refuse a hidden target exactly
 * like an unknown id; org-wide figures (org-wide bands and rounds, frozen
 * pay-gap snapshots) need an unrestricted actor. Self-service rides the
 * actor's own employment, never a widened HR lens.
 */

const READ = "hrm.compensation.read";
const MANAGE = "hrm.compensation.manage";
const RM = [READ, MANAGE];
const AS_OF = "2024-06-01";
const WHOLE_ORG = /measure the whole organization.*no subsidiary restriction/;
const SELF_REQUEST = { scope: "direct", permissions: ["hrm.self.request"], link: true } as const;
const STRANGER = { scope: "direct", permissions: [], link: true } as const;

/** Seed a state the services only reach through a longer workflow; the update must land. */
async function force(update: SQL): Promise<void> {
  assert.equal((await db.execute(update)).rowCount, 1, "the seeded state change matched no row");
}

/** Point an actor's own role at a lens the matrix has no shorthand for. */
function lens(orgId: string, userId: string, restriction: { mode: "list"; subsidiaryIds: string[] } | { mode: "subtree"; subsidiaryId: string }) {
  return force(sql`
    update app_roles r set subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
      from role_assignments ra
     where ra.role_id = r.id and ra.org_id = ${orgId} and ra.user_id = ${userId} and r.org_id = ${orgId}`);
}

/** A hidden target refuses exactly like a missing one, with the expected code. */
async function hiddenLikeMissing(what: string, hidden: () => Promise<unknown>, missing: () => Promise<unknown>, code = "NOT_FOUND"): Promise<Refusal> {
  const seen = await refusesLikeUnknown(hidden, missing);
  assert.equal(seen.code, code, `${what}: expected a ${code} refusal`);
  return seen;
}

/** An actor holding `permissions` in a second organization, dropped afterwards. */
async function inOtherOrg(permissions: readonly string[], prove: (otherOrgId: string, outsider: string) => Promise<void>, link = false) {
  const other = await createScratchOrg();
  try {
    const outsider = await createScratchUser(other.orgId, "Other org", "other_org");
    await grantPermissions(other.orgId, outsider, permissions);
    if (link) await linkPerson(other.orgId, outsider);
    await prove(other.orgId, outsider);
  } finally {
    await dropScratchOrg(other.orgId);
  }
}

/**
 * Start `operation` once another transaction holds `lock`, prove it is still
 * waiting after a pause, run `meanwhile` inside the holder, and return the
 * operation's outcome after the holder commits.
 */
async function waitsOn<T>(orgId: string, lock: SQL, what: string, operation: () => Promise<T>, meanwhile?: SQL): Promise<T> {
  let release!: () => void;
  let settled = "";
  const observed = new Promise<void>((resolve) => { release = resolve; }).then(operation);
  observed.then(() => { settled = "succeeded"; }, (error: unknown) => { settled = `failed: ${String(error)}`; });
  await withOrgTransaction(orgId, async () => {
    await db.execute(lock);
    release();
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(settled, "", `${what} must wait for the held lock, but it already ${settled}`);
    if (meanwhile) await db.execute(meanwhile);
  });
  return observed;
}

const employmentLock = (orgId: string, employmentId: string) =>
  sql`select id from worker_employments where org_id = ${orgId} and id = ${employmentId} for update`;

function payBand(w: ScopeWorld, actorId: string, levelId: string, employerSubsidiaryId: string | null, figures: { min?: string; target?: string; max?: string } = {}) {
  return createPayBand({
    orgId: w.orgId, actorId, scope: { familyId: null, levelId, employerSubsidiaryId, locationId: null },
    currency: "CAD", basis: "annual", min: "80000", target: "100000", max: "120000", ...figures,
    effectiveFrom: "2020-01-01", reason: "scope seed",
  });
}

/** A job level priced by an org-wide 80k/100k/120k CAD band. */
async function bandedLevel(w: ScopeWorld): Promise<string> {
  const levelId = await seedLevel(w.orgId, w.admin);
  await payBand(w, w.admin, levelId, null);
  return levelId;
}

const newPlan = (w: ScopeWorld, name: string) =>
  createPlan({ orgId: w.orgId, actorId: w.admin, name, fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31" });

const scopePlanTo = (w: ScopeWorld, planId: string, subsidiaryId: string) => force(sql`
  update hrm_headcount_plans set scope = ${JSON.stringify({ employer_subsidiary_id: subsidiaryId })}::jsonb
   where org_id = ${w.orgId} and id = ${planId}`);

/** A headcount plan costed at band target with no burden, and a line writer for it. */
async function headcountPlan(w: ScopeWorld) {
  const levelId = await bandedLevel(w);
  await setCompensationSettings(w.orgId, { burdenRate: "0" });
  const plan = await newPlan(w, "FY26 plan");
  const line = (actorId: string, employerSubsidiaryId: string, title: string, plannedFte = "1", planId = plan.id) => createPlanLine({
    orgId: w.orgId, actorId, planId, kind: "create", title, employerSubsidiaryId, jobLevelId: levelId,
    plannedFte, startOn: "2026-03-01", currency: "CAD", reason: "growth",
  });
  return { plan, line };
}

const HEADCOUNT_READERS = {
  admin: { scope: "all", permissions: RM }, readerA: { scope: "A" }, readerB: { scope: "B" }, subtree: { scope: "A" }, none: { scope: "A" },
} as const;

async function headcountReaders(w: ScopeWorld<keyof typeof HEADCOUNT_READERS>) {
  await lens(w.orgId, w.subtree, { mode: "subtree", subsidiaryId: w.subA });
  await lens(w.orgId, w.none, { mode: "list", subsidiaryIds: [] });
  const { plan, line } = await headcountPlan(w);
  return { plan, lineA: await line(w.admin, w.subA, "Engineer III A"), lineB: await line(w.admin, w.subB, "Engineer III B", "0.5") };
}

async function cycle(w: ScopeWorld, actorId: string, name: string, employerSubsidiaryId: string | null, status?: "open" | "pushed") {
  const created = await createCycle({
    orgId: w.orgId, actorId, name, kind: "merit", effectiveOn: "2026-04-01", currency: "CAD",
    guidelineKind: "matrix", guideline: {}, scope: { employerSubsidiaryId, departmentId: null },
  });
  if (status) await force(sql`update hrm_comp_cycles set status = ${status} where org_id = ${w.orgId} and id = ${created.id}`);
  return created;
}

const cycleWorker = async (w: ScopeWorld, subsidiaryId: string) =>
  (await seedEmployment(w.orgId, subsidiaryId, { displayName: "Cycle Worker", withVersion: false })).employmentId;

async function cycleLine(orgId: string, cycleId: string, employmentId: string, status: "pending" | "approved"): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_comp_cycle_lines (org_id, cycle_id, employment_id, current_rate, currency, basis, status, approver_party_id, decided_at)
    select ${orgId}, ${cycleId}, e.id, '90000.0000', 'CAD', 'annual', ${status},
           case when ${status} = 'approved' then e.worker_party_id end, case when ${status} = 'approved' then now() end
      from worker_employments e where e.org_id = ${orgId} and e.id = ${employmentId}
    returning id`)).rows[0]!.id;
}

/** G1 in A and G2 in B, so both comparison sides are priced across entities. */
async function payGapWorld(w: ScopeWorld): Promise<string> {
  await setCompensationSettings(w.orgId, { comparisonAttributeKey: "eeo_group", gapThresholdPct: "5", responseDays: 30 });
  const levelId = await seedLevel(w.orgId, w.admin);
  await seedPayGapWorker(w.orgId, w.admin, w.subA, levelId, "G1");
  await seedPayGapWorker(w.orgId, w.admin, w.subB, levelId, "G2");
  return levelId;
}

const snapshot = (w: ScopeWorld, actorId: string) =>
  computeGapSnapshot({ orgId: w.orgId, actorId, asOf: AS_OF, groupA: "G1", groupB: "G2" });

const STATEMENT_ACTORS = {
  admin: { scope: "all", link: true },
  readerA: { scope: "A", permissions: [READ] },
  none: { scope: "A", permissions: [READ] },
  scoped: { scope: "A" },
  owner: { scope: "direct", permissions: ["hrm.self.read"], link: true },
  mixed: { scope: "A", link: true },
  stranger: STRANGER,
} as const;

/** Statements for a 90k A worker and a 100k B worker, plus own B employments for the self-service actors. */
async function statementsWorld(w: ScopeWorld<keyof typeof STATEMENT_ACTORS>) {
  await lens(w.orgId, w.none, { mode: "list", subsidiaryIds: [] });
  await grantPermissions(w.orgId, w.mixed, ["hrm.self.read"]);
  const worker = async (subsidiaryId: string, rate: string) => {
    const seeded = await seedEmployment(w.orgId, subsidiaryId, { displayName: "Stmt Worker" });
    await seedWage(w.orgId, w.admin, seeded.workerPartyId, rate);
    return seeded.employmentId;
  };
  const empA = await worker(w.subA, "90000");
  const empB = await worker(w.subB, "100000");
  const own = async (partyId: string) => (await seedEmployment(w.orgId, w.subB, { workerPartyId: partyId })).employmentId;
  return {
    empA, empB, statementA: (await gen(w.orgId, w.admin, empA)).id, statementB: (await gen(w.orgId, w.admin, empB)).id,
    ownB: await own(w.party.owner), mixedOwn: await own(w.party.mixed),
  };
}

const gen = (orgId: string, actorId: string, employmentId: string) =>
  generateStatement({ orgId, actorId, employmentId, periodFrom: "2025-01-01", periodTo: "2025-12-31" });
const render = (orgId: string, actorId: string, statementId: string) => renderStatementPdf({ orgId, actorId, statementId, orgName: "Scratch" });
const attach = (orgId: string, actorId: string, statementId: string) =>
  attachStatementPdf({ orgId, actorId, statementId, filename: "statement.pdf", bytes: Buffer.from("%PDF-1.4 probe") });
const list = (orgId: string, actorId: string, employmentId: string) => listStatements({ orgId, actorId, employmentId });

scopeMatrix([
  scopeRow({
    name: "band reads show a scoped reader its own entity's bands and the shared org-wide bands",
    permissions: RM,
    features: ['hrmCompensation'],
    seed: async (w) => {
      const levelId = await seedLevel(w.orgId, w.admin);
      const band = async (sub: string | null, min: string) => (await payBand(w, w.admin, levelId, sub, { min })).id;
      return { a: await band(w.subA, "80000"), b: await band(w.subB, "81000"), shared: await band(null, "82000") };
    },
    read: async (w, { a, b, shared }) => {
      const ids = async (actorId: string) => (await listPayBands({ orgId: w.orgId, actorId, asOf: AS_OF })).map((band) => band.id).sort();
      assert.deepEqual(await ids(w.admin), [a, b, shared].sort(), "the unrestricted reader sees every band");
      assert.deepEqual(await ids(w.scoped), [a, shared].sort(), "B's band and its figures never reach an A-scoped reader");
      for (const actorId of [w.admin, w.scoped]) {
        const query = { orgId: w.orgId, actorId };
        const [families, levels, bands, versions] = await Promise.all([
          listJobFamilies(query), listJobLevels(query), listPayBands({ ...query, asOf: AS_OF }), listPayBandVersions(query),
        ]);
        assert.deepEqual(await compensationArchitectureSummary({ ...query, asOf: AS_OF }), {
          families: families.length, levels: levels.length, bands: bands.length, bandVersions: versions.length,
        }, 'architecture counts preserve the native active and employer-scope population');
        assert.equal((await compensationArchitectureSummary({ ...query, asOf: '2019-12-31' })).bands, 0,
          'future bands contribute to version history but not current totals');
      }
      await lens(w.orgId, w.scoped, { mode: 'list', subsidiaryIds: [] });
      assert.equal((await compensationArchitectureSummary({ orgId: w.orgId, actorId: w.scoped, asOf: AS_OF })).bands, 1,
        'an empty lens still sees shared architecture but no employer-anchored band');
      await inOtherOrg([READ], async (_, outsider) => {
        await assert.rejects(compensationArchitectureSummary({ orgId: w.orgId, actorId: outsider, asOf: AS_OF }), /hrm\.compensation\.read/);
      });
      await setFeatures(w.orgId, { hrmCompensation: false });
      await assert.rejects(compensationArchitectureSummary({ orgId: w.orgId, actorId: w.admin, asOf: AS_OF }), /Enable Compensation/,
        'a later read rechecks the organization feature instead of reusing an earlier admission');
    },
  }),
  scopeRow({
    name: "band writes accept only an employer anchor inside the writer's lens",
    permissions: RM,
    actors: { admin: { scope: "all" }, scoped: { scope: "A", permissions: [MANAGE] } },
    write: async (w) => {
      const levelId = await seedLevel(w.orgId, w.admin);
      const attempt = (sub: string | null) => () => payBand(w, w.scoped, levelId, sub);
      const foreign = await refusesLikeUnknown(attempt(w.subB), attempt(randomUUID()));
      assert.match(foreign.message, /not visible in this organization and legal-entity scope/);
      // An org-wide band prices every entity at once: the refusal names the org-wide remedy.
      const orgWide = await refusal(attempt(null)(), HrmAuthorizationError, /across legal entities/);
      assert.match(orgWide.message, /organization-wide scope/);
      assert.equal(await countRows(sql`from hrm_pay_bands where org_id = ${w.orgId}`), 0, "no refused band was stored");
      assert.equal((await attempt(w.subA)()).employerSubsidiaryId, w.subA);
    },
  }),
  scopeRow({
    name: "an unordered band is refused by name even when floats cannot tell the figures apart",
    permissions: RM,
    write: async (w) => {
      // Both figures round to the same double; only the exact decimal comparison sees min > target.
      const levelId = await seedLevel(w.orgId, w.admin);
      const [hi, lo] = ["999999999999999.9999", "999999999999999.9998"];
      const error = await refusal(payBand(w, w.admin, levelId, null, { min: hi, target: lo, max: hi }), CompensationError, /not ordered min <= target <= max/);
      assert.equal(error.code, "REFUSED");
      assert.ok((await payBand(w, w.admin, levelId, null, { min: lo, target: hi, max: hi })).id, "an exactly ordered band still stores");
    },
  }),
  scopeRow({
    name: "band placement follows the compensation lens and falls through to the actor's own employment",
    permissions: [READ],
    actors: {
      admin: { scope: "all", permissions: RM, link: true }, analyst: { scope: "direct", link: true }, readerA: { scope: "A", link: true },
      none: { scope: "A", link: true }, owner: { scope: "direct", permissions: ["hrm.self.read"], link: true }, mixed: { scope: "A", link: true },
      stranger: STRANGER,
    },
    seed: async (w) => {
      await lens(w.orgId, w.none, { mode: "list", subsidiaryIds: [] });
      await grantPermissions(w.orgId, w.mixed, ["hrm.self.read"]);
      const levelId = await bandedLevel(w);
      const placed = async (subsidiaryId: string, rate: string, workerPartyId?: string) => (await seedPositionedEmployment(w.orgId, subsidiaryId, {
        levelId, workerPartyId, displayName: "Placed Worker", wage: { actorId: w.admin, rate },
      })).employmentId;
      return {
        empA: await placed(w.subA, "90000"), empB: await placed(w.subB, "100000"),
        ownB: await placed(w.subB, "95000", w.party.owner), mixedOwn: await placed(w.subB, "96000", w.party.mixed),
      };
    },
    read: async (w, e) => {
      const place = (actorId: string, employmentId: string, orgId = w.orgId) => compaRatioFor(orgId, actorId, employmentId, AS_OF);
      assert.equal((await place(w.analyst, e.empA)).currentRate, "90000.0000", "an unrestricted analyst reads placement without the employment grant");
      const cases: [who: string, actorId: string, visible: Record<string, string>, hidden: string[], code: string][] = [
        ["unrestricted analyst", w.analyst, { [e.empA]: "0.9000000000" }, [], "NOT_FOUND"],
        ["A reader", w.readerA, { [e.empA]: "0.9000000000" }, [e.empB], "NOT_FOUND"],
        ["empty lens", w.none, {}, [e.empA, e.empB], "NOT_FOUND"],
        ["no-grant stranger", w.stranger, {}, [e.empA], "REFUSED"],
        ["self-service owner", w.owner, { [e.ownB]: "0.9500000000" }, [e.empA], "REFUSED"],
        ["A-scoped HR with self-service", w.mixed, { [e.mixedOwn]: "0.9600000000", [e.empA]: "0.9000000000" }, [e.empB], "NOT_FOUND"],
      ];
      for (const [who, actorId, visible, hidden, code] of cases) {
        for (const [employmentId, ratio] of Object.entries(visible)) {
          const placed = await place(actorId, employmentId);
          assert.deepEqual([placed.compaRatio, placed.placement], [ratio, "in_range"], `${who} reads the placement`);
        }
        const missing = await refusalOf(place(actorId, randomUUID()));
        assert.equal(missing.code, code, `${who}: an unknown employment refuses with ${code}`);
        if (code === "NOT_FOUND") assert.match(missing.message, NOT_VISIBLE, `${who}: the uniform not-found wording`);
        for (const employmentId of hidden) {
          assert.deepEqual(await refusalOf(place(actorId, employmentId)), missing, `${who}: a real hidden employment refuses exactly like an unknown one`);
        }
        assert.ok(!/90000|100000/.test(missing.message), `${who}: the refusal carries no wage`);
      }
      assert.match((await refusalOf(place(w.stranger, e.empA))).message, /hrm\.compensation\.read/, "the stranger is told the grant that exists");
      await inOtherOrg([READ], async (otherOrgId, outsider) => {
        // Another org's grant is meaningless here: real and fabricated ids refuse identically.
        const foreign = await hiddenLikeMissing("cross-org", () => place(outsider, e.empA), () => place(outsider, randomUUID()), "REFUSED");
        assert.ok(!foreign.message.includes("90000"));
        await assert.rejects(place(outsider, e.empA, otherOrgId), NOT_VISIBLE);
      }, true);
    },
  }),
  scopeRow({
    name: "headcount plan lines show each reader only the salaries inside their lens",
    permissions: [READ],
    actors: HEADCOUNT_READERS,
    seed: headcountReaders,
    read: async (w, { plan, lineA, lineB }) => {
      const view = async (actorId: string) => (await listPlanLines({ orgId: w.orgId, actorId, planId: plan.id }))
        .map((line) => `${line.id} ${line.employerSubsidiaryId} ${line.estAnnualCost} ${(line.costBasis as { basis?: string }).basis}`).sort();
      const A = `${lineA.id} ${w.subA} 100000.0000 band_target`;
      const B = `${lineB.id} ${w.subB} 50000.0000 band_target`;
      const cases = [["unrestricted HR", w.admin, [A, B]], ["A reader", w.readerA, [A]], ["B reader", w.readerB, [B]], ["subtree rooted at A", w.subtree, [A, B]], ["empty lens", w.none, []]] as const;
      for (const [who, actorId, expected] of cases) assert.deepEqual(await view(actorId), [...expected].sort(), `${who} sees exactly the lines inside their lens`);
      const second = await newPlan(w, 'Second register plan');
      const secondA = await createPlanLine({
        orgId: w.orgId, actorId: w.admin, planId: second.id, kind: 'create', title: 'Second A',
        employerSubsidiaryId: w.subA, jobLevelId: lineA.jobLevelId, plannedFte: '1',
        startOn: '2026-03-01', currency: 'CAD', reason: 'growth',
      });
      for (const [who, actorId, expected] of cases) {
        const batch = await listPlanLinesForPlans({ orgId: w.orgId, actorId, planIds: [plan.id, second.id, plan.id, randomUUID()] });
        assert.deepEqual(batch.filter((row) => row.planId === plan.id).map((row) => `${row.id} ${row.employerSubsidiaryId} ${row.estAnnualCost} ${(row.costBasis as { basis?: string }).basis}`).sort(),
          [...expected].sort(), `${who}: the batch preserves the single-plan salary population`);
        assert.deepEqual(batch.filter((row) => row.planId === second.id).map((row) => row.id),
          actorId === w.readerB || actorId === w.none ? [] : [secondA.id], `${who}: each plan keeps its own visible lines`);
      }
      await lens(w.orgId, w.readerA, { mode: 'list', subsidiaryIds: [] });
      assert.deepEqual(await listPlanLinesForPlans({ orgId: w.orgId, actorId: w.readerA, planIds: [plan.id, second.id] }), [],
        'a later batch resolves the changed legal-entity scope afresh');
      await lens(w.orgId, w.readerA, { mode: 'list', subsidiaryIds: [w.subA] });
      const forged = await listPlanLines({
        orgId: w.orgId, actorId: w.readerA, planId: plan.id, ...({ allowedSubsidiaryIds: [w.subB] } as Record<string, unknown>),
      } as { orgId: string; actorId: string; planId: string });
      assert.deepEqual(forged.map((line) => line.id), [lineA.id], "a caller-supplied allowlist never widens the lens");
    },
  }),
  scopeRow({
    name: "plan discovery hides entity-scoped plans but keeps pay-free mixed plan headers discoverable",
    permissions: [READ],
    actors: HEADCOUNT_READERS,
    seed: headcountReaders,
    read: async (w, { plan }) => {
      const planB = await newPlan(w, "B-only plan");
      await scopePlanTo(w, planB.id, w.subB);
      const cases = [["A reader", w.readerA, false], ["B reader", w.readerB, true], ["empty lens", w.none, false], ["unrestricted HR", w.admin, true]] as const;
      for (const [who, actorId, seesB] of cases) {
        const ids = (await listPlans({ orgId: w.orgId, actorId })).map((listed) => listed.id);
        assert.ok(ids.includes(plan.id), `${who}: the mixed plan header carries no pay and stays discoverable`);
        assert.equal(ids.includes(planB.id), seesB, `${who}: a B-scoped plan lists only to readers whose lens covers B`);
      }
      await inOtherOrg([READ], async (_, outsider) => {
        await assert.rejects(listPlans({ orgId: w.orgId, actorId: outsider }), /hrm\.compensation\.read/);
        await assert.rejects(listPlanLines({ orgId: w.orgId, actorId: outsider, planId: plan.id }), /hrm\.compensation\.read/);
      });
    },
  }),
  scopeRow({
    name: "headcount lines, approvals and plan transitions stay inside the manager's lens",
    features: ["hrmRecruiting"],
    permissions: [...RM, "hrm.recruiting.manage"],
    actors: { admin: { scope: "all" }, scoped: { scope: "A", permissions: [MANAGE, "hrm.recruiting.manage"] } },
    write: async (w) => {
      const orgId = w.orgId;
      const { plan, line } = await headcountPlan(w);
      await hiddenLikeMissing("B line", () => line(w.scoped, w.subB, "Engineer III B"), () => line(w.scoped, randomUUID(), "Engineer III X"));
      const lineA = await line(w.scoped, w.subA, "Engineer III A");
      const lineB = await line(w.admin, w.subB, "Engineer III B");
      // Approving a line opens a requisition, so a refused approval must open none into B.
      const approve = (actorId: string, lineId: string) => () => approvePlanLine({ orgId, actorId, lineId });
      await hiddenLikeMissing("approve B line", approve(w.scoped, lineB.id), approve(w.scoped, randomUUID()));
      const requisitions = sql`from hrm_requisitions where org_id = ${orgId}`;
      assert.equal(await countRows(requisitions), 0, "the refused approval opened no requisition");
      const approvedB = await approve(w.admin, lineB.id)();
      assert.equal(approvedB.status, "opened");
      assert.ok(approvedB.requisitionId);
      assert.equal(await countRows(requisitions), 1);
      assert.equal((await approve(w.scoped, lineA.id)()).status, "opened");

      const planB = await newPlan(w, "B-only plan");
      await scopePlanTo(w, planB.id, w.subB);
      const submitB = await refusal(submitPlan({ orgId, actorId: w.scoped, planId: planB.id }), CompensationError, NOT_VISIBLE);
      assert.equal(submitB.code, "NOT_FOUND");
      assert.equal((await submitPlan({ orgId, actorId: w.admin, planId: planB.id })).status, "submitted");
      const mixed = await refusal(submitPlan({ orgId, actorId: w.scoped, planId: plan.id }), CompensationError);
      assert.equal(mixed.code, "NOT_FOUND", "a plan carrying a B line does not submit for an A-scoped manager");
      const planA = await newPlan(w, "A-only plan");
      await line(w.scoped, w.subA, "Engineer III A2", "1", planA.id);
      for (const [move, status] of [[submitPlan, "submitted"], [approvePlan, "approved"], [closePlan, "closed"]] as const) {
        assert.equal((await move({ orgId, actorId: w.scoped, planId: planA.id })).status, status);
      }
    },
  }),
  scopeRow({
    name: "a merit cycle is created only for an entity inside the manager's lens",
    permissions: [MANAGE],
    write: async (w) => {
      const attempt = (sub: string | null) => () => cycle(w, w.scoped, "Round", sub);
      const foreign = await refusesLikeUnknown(attempt(w.subB), attempt(randomUUID()));
      assert.match(foreign.message, /not visible in this organization and legal-entity scope/);
      await refusal(attempt(null)(), HrmAuthorizationError, /across legal entities/);
      assert.equal(await countRows(sql`from hrm_comp_cycles where org_id = ${w.orgId}`), 0, "no refused round was stored");
      assert.ok((await attempt(w.subA)()).id);
    },
  }),
  scopeRow({
    name: "merit-cycle cancel, submit, propose and close recheck every line's entity",
    permissions: [MANAGE, "hrm.compensation.approve"],
    seed: async (w) => ({ empA: await cycleWorker(w, w.subA), empB: await cycleWorker(w, w.subB) }),
    write: async (w, { empA, empB }) => {
      const orgId = w.orgId;
      const cancel = (cycleId: string) => () => cancelCycle({ orgId, actorId: w.scoped, cycleId, reason: "probe" });
      await hiddenLikeMissing("cancel B round", cancel((await cycle(w, w.admin, "B round", w.subB)).id), cancel(randomUUID()));
      // An A round carrying a B line: the unrestricted admin passes scope and reaches the approval-flow gate.
      const mixed = await cycle(w, w.admin, "Mixed round", w.subA, "open");
      for (const employmentId of [empA, empB]) await cycleLine(orgId, mixed.id, employmentId, "approved");
      const submit = (actorId: string) => refusalOf(submitCycleForApproval({ orgId, actorId, cycleId: mixed.id }));
      const hidden = await submit(w.scoped);
      assert.equal(hidden.code, "NOT_FOUND");
      assert.match(hidden.message, NOT_VISIBLE);
      assert.match((await submit(w.admin)).message, /approval flow/, "unrestricted passes scope and reaches Flows");

      const proposals = await cycle(w, w.admin, "Proposal round", w.subA, "open");
      const propose = (lineId: string) => () => proposeLine({ orgId, actorId: w.scoped, lineId, proposedRate: "95000.0000", reason: "merit" });
      const pendingB = await cycleLine(orgId, proposals.id, empB, "pending");
      await hiddenLikeMissing("propose B line", propose(pendingB), propose(randomUUID()));
      assert.equal(await countRows(sql`from hrm_comp_cycle_lines where org_id = ${orgId} and id = ${pendingB} and status = 'pending'`), 1, "the refused proposal left the line pending");
      const stored = await propose(await cycleLine(orgId, proposals.id, empA, "pending"))();
      assert.deepEqual([stored.status, stored.proposedRate], ["proposed", "95000.0000"]);

      const close = (cycleId: string) => () => closeCycle({ orgId, actorId: w.scoped, cycleId });
      await hiddenLikeMissing("close B round", close((await cycle(w, w.admin, "Pushed B round", w.subB, "pushed")).id), close(randomUUID()));
      assert.equal((await close((await cycle(w, w.admin, "Pushed A round", w.subA, "pushed")).id)()).status, "closed");
    },
  }),
  scopeRow({
    name: "a line proposal waits for the employment lock before checking its entity",
    permissions: [MANAGE],
    write: async (w) => {
      const employmentId = await cycleWorker(w, w.subA);
      const round = await cycle(w, w.admin, "Locked proposal", w.subA, "open");
      const lineId = await cycleLine(w.orgId, round.id, employmentId, "pending");
      const proposed = await waitsOn(w.orgId, employmentLock(w.orgId, employmentId), "the proposal", () =>
        proposeLine({ orgId: w.orgId, actorId: w.scoped, lineId, proposedRate: "95000.0000", reason: "scope lock probe" }));
      assert.equal(proposed.status, "proposed");
    },
  }),
  scopeRow({
    name: "org-wide pay-gap snapshots compute and read only without a subsidiary restriction",
    permissions: RM,
    actors: { admin: { scope: "all", link: true }, scoped: { scope: "A" }, none: { scope: "A" }, both: { scope: "A" } },
    seed: async (w) => {
      await payGapWorld(w);
      await lens(w.orgId, w.none, { mode: "list", subsidiaryIds: [] });
      await lens(w.orgId, w.both, { mode: "list", subsidiaryIds: [w.subA, w.subB] });
    },
    write: async (w) => {
      // Frozen aggregates cannot be post-filtered, so even a list naming every entity today is refused.
      const restricted = [w.scoped, w.none, w.both];
      for (const actorId of restricted) await refusal(snapshot(w, actorId), CompensationError, WHOLE_ORG);
      assert.equal(await countRows(sql`from hrm_pay_gap_snapshots where org_id = ${w.orgId}`), 0, "refused computes wrote no snapshot");
      const stored = await snapshot(w, w.admin);
      assert.equal((await latestGapSnapshot({ orgId: w.orgId, actorId: w.admin }))?.id, stored.id);
      for (const actorId of restricted) await refusal(latestGapSnapshot({ orgId: w.orgId, actorId }), CompensationError, WHOLE_ORG);
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${randomUUID()}, ${w.orgId}, ${w.subA}, 'Third entity', 'CAD', 'CA')`);
      await refusal(latestGapSnapshot({ orgId: w.orgId, actorId: w.both }), CompensationError, WHOLE_ORG);
      await inOtherOrg(RM, async (_, outsider) => {
        await assert.rejects(snapshot(w, outsider), /hrm\.compensation\.manage|not visible|not established/);
        await assert.rejects(latestGapSnapshot({ orgId: w.orgId, actorId: outsider }), /hrm\.compensation\.read|not visible|not established/);
      });
    },
  }),
  scopeRow({
    name: "workers request their own pay information and a scoped HR lens cannot answer from org-wide figures",
    permissions: RM,
    actors: { admin: { scope: "all", link: true }, scoped: { scope: "A" }, worker: SELF_REQUEST, workerB: SELF_REQUEST, unentitled: STRANGER, stranger: STRANGER },
    seed: async (w) => {
      const levelId = await payGapWorld(w);
      const own = async (subsidiaryId: string, group: string, workerPartyId: string) =>
        (await seedPayGapWorker(w.orgId, w.admin, subsidiaryId, levelId, group, { workerPartyId })).employmentId;
      return { mine: await own(w.subA, "G1", w.party.worker), unentitled: await own(w.subA, "G1", w.party.unentitled), inB: await own(w.subB, "G2", w.party.workerB) };
    },
    write: async (w, e) => {
      const orgId = w.orgId;
      const file = (actorId: string, employmentId: string) => requestPayInformation({ orgId, actorId, employmentId });
      const status = async (id: string) => (await db.execute<{ status: string }>(sql`
        select status from hrm_pay_information_requests where org_id = ${orgId} and id = ${id}`)).rows[0]?.status;
      const reqA = await file(w.worker, e.mine);
      assert.equal(reqA.status, "open");
      assert.equal(await status(reqA.id), "open");
      await refusal(file(w.unentitled, e.unentitled), HrmAuthorizationError, /hrm\.self\.request/);
      await refusal(file(w.stranger, e.mine), CompensationError, /your own employment/);
      await snapshot(w, w.admin);
      // Fulfilment copies org-wide frozen averages, so an in-lens request still refuses a restricted lens by name.
      await refusal(fulfilPayInformationRequest({ orgId, actorId: w.scoped, requestId: reqA.id }), CompensationError, /measure the whole organization/);
      assert.equal(await status(reqA.id), "open", "the refused fulfil wrote nothing");
      const reqB = await file(w.workerB, e.inB);
      const fulfil = (actorId: string, requestId: string) => fulfilPayInformationRequest({ orgId, actorId, requestId });
      const refuse = (actorId: string, requestId: string) => refusePayInformationRequest({ orgId, actorId, requestId, reason: "no grounds" });
      for (const [what, move] of [["fulfil", fulfil], ["refuse", refuse]] as const) {
        await hiddenLikeMissing(`${what} B request`, () => move(w.scoped, reqB.id), () => move(w.scoped, randomUUID()));
      }
      assert.equal(await status(reqB.id), "open", "refused mutations wrote nothing");
      const done = await fulfil(w.admin, reqA.id);
      assert.equal(done.status, "fulfilled");
      assert.ok(done.categoryAverages, "the worker's own category answer stays available");
      assert.equal(await status(reqA.id), "fulfilled");
      assert.equal((await fulfil(w.admin, reqB.id)).status, "fulfilled");
      assert.equal((await refuse(w.admin, (await file(w.worker, e.mine)).id)).status, "refused");
    },
  }),
  scopeRow({
    name: "statement list, render, generate and attach stay inside the HR lens",
    permissions: RM,
    actors: STATEMENT_ACTORS,
    seed: statementsWorld,
    read: async (w, s) => {
      const seen = await list(w.orgId, w.readerA, s.empA);
      assert.deepEqual(seen.map((statement) => (statement.payload.currentRate as { rate: string }).rate), ["90000.0000"]);
      for (const [who, actorId, employmentId] of [["A reader", w.readerA, s.empB], ["empty lens", w.none, s.empA], ["empty lens", w.none, s.empB]] as const) {
        assert.deepEqual(await list(w.orgId, actorId, employmentId), [], `${who}: an out-of-lens employment lists no statements`);
      }
      assert.ok((await render(w.orgId, w.readerA, s.statementA)).length > 0);
      const hidden = await hiddenLikeMissing("render", () => render(w.orgId, w.readerA, s.statementB), () => render(w.orgId, w.readerA, randomUUID()));
      assert.match(hidden.message, NOT_VISIBLE);
      assert.ok(!hidden.message.includes("100000"), "the refusal carries no salary");
    },
    write: async (w, s) => {
      const counts = async () => [await countRows(sql`from hrm_comp_statements where org_id = ${w.orgId}`), await countRows(sql`from files where org_id = ${w.orgId}`)];
      const before = await counts();
      const generated = await hiddenLikeMissing("generate", () => gen(w.orgId, w.scoped, s.empB), () => gen(w.orgId, w.scoped, randomUUID()));
      assert.ok(!generated.message.includes("100000"), "the refusal carries no salary");
      const attached = await hiddenLikeMissing("attach", () => attach(w.orgId, w.scoped, s.statementB), () => attach(w.orgId, w.scoped, randomUUID()));
      assert.deepEqual(attached, await refusalOf(render(w.orgId, w.readerA, randomUUID())), "attach refuses exactly like an unknown statement");
      assert.deepEqual(await counts(), before, "refused generate and attach stored no statement or file");
    },
  }),
  scopeRow({
    name: "statement self-service reaches only the actor's own employment",
    permissions: RM,
    actors: STATEMENT_ACTORS,
    seed: statementsWorld,
    write: async (w, s) => {
      const selfService = [["self-service owner", w.owner, s.ownB, s.empA, s.statementA], ["A-scoped HR", w.mixed, s.mixedOwn, s.empB, s.statementB]] as const;
      for (const [who, actorId, own, otherEmployment, otherStatement] of selfService) {
        assert.ok(Array.isArray(await list(w.orgId, actorId, own)), `${who} lists their own statements outside any HR lens`);
        assert.ok((await render(w.orgId, actorId, (await gen(w.orgId, actorId, own)).id)).length > 0, `${who} renders their own statement`);
        await hiddenLikeMissing(`${who} generate`, () => gen(w.orgId, actorId, otherEmployment), () => gen(w.orgId, actorId, randomUUID()));
        await hiddenLikeMissing(`${who} render`, () => render(w.orgId, actorId, otherStatement), () => render(w.orgId, actorId, randomUUID()));
      }
      assert.deepEqual(await list(w.orgId, w.mixed, s.empB), [], "self-service never widens the A lens to another B employee");
      // Identity alone is not a grant: the list names the remedy, single subjects refuse like a missing id.
      for (const actorId of [w.owner, w.stranger]) await refusal(list(w.orgId, actorId, s.empA), CompensationError, /your own employment/);
      await hiddenLikeMissing("stranger render", () => render(w.orgId, w.stranger, s.statementA), () => render(w.orgId, w.stranger, randomUUID()));
    },
  }),
  scopeRow({
    name: "statement surfaces wait on the employment lock and recheck a revoked self-service link",
    permissions: RM,
    actors: STATEMENT_ACTORS,
    seed: statementsWorld,
    write: async (w, s) => {
      const statements = sql`from hrm_comp_statements where org_id = ${w.orgId}`;
      const lock = employmentLock(w.orgId, s.empA);
      for (const [surface, run] of [
        ["list", () => list(w.orgId, w.readerA, s.empA)],
        ["render", () => render(w.orgId, w.readerA, s.statementA)],
        ["attach", () => attach(w.orgId, w.scoped, s.statementA)],
      ] as [string, () => Promise<unknown>][]) await waitsOn(w.orgId, lock, surface, run);
      const before = await countRows(statements);
      await waitsOn(w.orgId, lock, "generate", () => gen(w.orgId, w.scoped, s.empA));
      assert.equal(await countRows(statements), before + 1, "generation stored its statement once the lock released");

      const unlinked = await countRows(statements);
      for (const [surface, probe, code] of [
        ["list", () => list(w.orgId, w.owner, s.ownB), "REFUSED"],
        ["generate", () => gen(w.orgId, w.owner, s.ownB), "NOT_FOUND"],
        ["render", () => render(w.orgId, w.owner, s.statementB), "NOT_FOUND"],
      ] as const) {
        const seen = await waitsOn(w.orgId, sql`select id from users where org_id = ${w.orgId} and id = ${w.owner} for update`, surface,
          () => refusalOf(probe()), sql`update users set party_id = null where org_id = ${w.orgId} and id = ${w.owner}`);
        await force(sql`update users set party_id = ${w.party.owner} where org_id = ${w.orgId} and id = ${w.owner}`);
        assert.equal(seen.code, code, `${surface} refuses once the self-service link is revoked mid-flight`);
      }
      assert.equal(await countRows(statements), unlinked, "no statement was generated for the unlinked actor");
    },
  }),
  scopeRow({
    name: "unrestricted HR reaches every entity's statements and another org reaches none",
    permissions: RM,
    actors: STATEMENT_ACTORS,
    seed: statementsWorld,
    write: async (w, s) => {
      for (const employmentId of [s.empA, s.empB]) {
        assert.equal((await list(w.orgId, w.admin, employmentId)).length, 1);
        assert.ok((await gen(w.orgId, w.admin, employmentId)).id);
      }
      assert.equal((await render(w.orgId, w.admin, s.statementB)).subarray(0, 4).toString("ascii"), "%PDF");
      const attached = await attach(w.orgId, w.admin, s.statementB);
      assert.ok(attached.fileId);
      assert.ok((await list(w.orgId, w.admin, s.empB)).some((statement) => statement.fileId === attached.fileId), "the attached file reads back");
      await inOtherOrg(RM, async (otherOrgId, outsider) => {
        for (const probe of [() => gen(otherOrgId, outsider, s.empA), () => render(otherOrgId, outsider, s.statementA), () => attach(otherOrgId, outsider, s.statementA)]) {
          await assert.rejects(probe, NOT_VISIBLE);
        }
        assert.deepEqual(await list(otherOrgId, outsider, s.empA), []);
      });
    },
  }),
]);
