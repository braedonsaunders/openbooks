import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { UnrestrictedScopeError } from "../organization/subsidiary-scope.ts";
import { HrmConstructionError } from "./construction/errors.ts";
import {
  acknowledgeFinding,
  addScheduleLine,
  amendRun,
  approveEntry,
  assignClassification,
  checkDay,
  classify,
  computeForWeek,
  createClassification,
  createCompClass,
  createCompRule,
  createPolicy,
  createRatioRule,
  createSchedule,
  dailySplit,
  downloadRun,
  listEntries,
  listFindings,
  listRuns,
  listSchedules,
  projectComplianceSummary,
  recordFinding,
  resolveFinding,
  resolveWage,
  submitRun,
  updateScheduleScope,
  voidEntry,
} from "./construction/index.ts";

/**
 * H-CONSTRUCTION regression: certified runs, per-diem entries, findings,
 * the wage resolver, ratio/comp checks, and every construction config
 * write ignored the actor's subsidiary lens. An A-scoped actor holding
 * the construction grants could list B's certified filings, submit and
 * amend B's runs, download B's frozen wage file, read B's cockpit,
 * compute/approve/void B's allowance entries, read B's findings and
 * transition them, price B's workers through the resolver, check B's
 * ratio day, split B's comp hours, and author B-targeted (or org-wide)
 * schedules, classifications, comp classes/rules, ratio rules, and
 * per-diem policies.
 *
 * Fences now sit at every entry: runs/entries/findings filter or refuse
 * by the anchored subsidiary (missing and out-of-scope refuse
 * identically), resolver and check entries fence by lens without
 * demanding a grant (the approval-time hook resolves grant-less),
 * targeted config validates its anchors inside the write transaction,
 * and org-wide config needs unrestricted scope with the named remedy.
 * Every proof below fails on the pre-fix code (B's rows visible, B's
 * writes succeeding) and every refusal is asserted by name AND message
 * against a realistic second entity — never a synthetic collision.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = [
  "hrm",
  "payroll",
  "projects",
  "timeTracking",
  "hrmConstructionCompliance",
  "hrmPrevailingWage",
  "hrmCertifiedPayroll",
  "hrmWorkersCompClasses",
  "hrmApprenticeRatios",
  "hrmPerDiem",
];

async function enableConstruction(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
  await db.execute(sql`update orgs set country = 'US' where id = ${orgId}`);
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function secondSubsidiary(org: ScratchOrg): Promise<string> {
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  return subB;
}

type Lens = {
  org: ScratchOrg;
  adminId: string;
  actorAId: string;
  subB: string;
};

async function setupLens(): Promise<Lens> {
  const org = await createScratchOrg();
  await enableConstruction(org.orgId);
  const adminId = await createScratchUser(org.orgId, "Construction Scope Admin", "cscope_admin");
  await grantPermissions(org.orgId, adminId, ["hrm.construction.read", "hrm.construction.manage"]);
  const subB = await secondSubsidiary(org);
  const actorAId = await createScratchUser(org.orgId, "Construction Entity A", "cscope_actor_a");
  await scopeRole(
    org.orgId,
    "cscope_actor_a",
    ["hrm.construction.read", "hrm.construction.manage"],
    [org.subsidiaryId],
  );
  return { org, adminId, actorAId, subB };
}

async function seedEntityProject(orgId: string, subsidiaryId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, name, status, subsidiary_id)
    values (${id}, ${orgId}, ${name}, 'active', ${subsidiaryId})
  `);
  return id;
}

async function seedWorker(orgId: string, subsidiaryId: string, name: string): Promise<{ employmentId: string; partyId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return { employmentId, partyId };
}

async function seedTime(orgId: string, partyId: string, projectId: string, workedOn: string, hours: string): Promise<void> {
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, project_id, worked_on, hours, status)
    values (${orgId}, ${partyId}, ${projectId}, ${workedOn}::date, ${hours}, 'approved')
  `);
}

async function seedComponent(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, is_active)
    values (${id}, ${orgId}, ${`PD_${id.slice(0, 6)}`}, 'Per diem', 'earning', true)
  `);
  return id;
}

/** A refusal's usable shape: the error class plus the exact message. */
async function refusalOf(promise: Promise<unknown>): Promise<{ error: Error; message: string }> {
  try {
    await promise;
  } catch (e) {
    return { error: e as Error, message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

/**
 * Uniformity: two refusals carry the identical message once the probed
 * ids are blanked — B's id must read exactly like a fabricated one, not
 * merely match the same pattern.
 */
function assertSameRefusal(a: { message: string }, b: { message: string }, ids: string[]): void {
  const blank = (message: string) => ids.reduce((text, id) => text.replaceAll(id, "<id>"), message);
  assert.equal(blank(a.message), blank(b.message), "out-of-scope refuses exactly like missing");
}

test("H-CONSTRUCTION: run lists hide B's filings from the A lens", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, adminId, actorAId, subB } = lens;
    const projectA = await seedEntityProject(org.orgId, org.subsidiaryId, "A Job");
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");
    const weeks = ["2026-09-13", "2026-09-06", "2026-08-30"];
    const seedRun = (projectId: string, weekEnding: string) => db.execute(sql`
      insert into hrm_certified_payroll_runs
        (org_id, project_id, week_ending, status, generated_at, format_key, payload, created_by, updated_by)
      values (${org.orgId}, ${projectId}, ${weekEnding}::date, 'generated', now(), 'federal-weekly',
              ${JSON.stringify({ rendered: { filename: "cert.txt", contentType: "text/plain", body: "frozen" } })}::jsonb,
              ${adminId}, ${adminId})
      returning id::text as id
    `);
    const runA = ((await seedRun(projectA, weeks[0]!)).rows[0] as { id: string }).id;
    const runB = ((await seedRun(projectB, weeks[1]!)).rows[0] as { id: string }).id;
    await seedRun(projectB, weeks[2]!);

    const full = await listRuns(db, org.orgId, adminId);
    assert.ok(full.some((run) => run.id === runA), "admin sees the A run");
    assert.ok(full.some((run) => run.id === runB), "admin sees the B run");

    const scoped = await listRuns(db, org.orgId, actorAId);
    assert.ok(scoped.some((run) => run.id === runA), "A run stays visible to the A lens");
    assert.ok(!scoped.some((run) => run.id === runB), "B run is hidden from the A lens");

    const byBProject = await listRuns(db, org.orgId, actorAId, projectB);
    assert.equal(byBProject.length, 0, "filtering by B's project reads empty, not B's runs");
    const fabricated = await listRuns(db, org.orgId, actorAId, randomUUID());
    assert.equal(fabricated.length, 0, "a fabricated project reads exactly like B's");
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});

test("H-CONSTRUCTION: B's run lifecycle refuses the A lens and changes nothing", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, adminId, actorAId, subB } = lens;
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");
    const seedRun = async (weekEnding: string, status: "generated" | "submitted") => {
      const rows = (await db.execute(sql`
        insert into hrm_certified_payroll_runs
          (org_id, project_id, week_ending, status, generated_at, submitted_at, format_key, payload, created_by, updated_by)
        values (${org.orgId}, ${projectB}, ${weekEnding}::date, ${status}, now(),
                ${status === "submitted" ? sql`now()` : sql`null`}, 'federal-weekly',
                ${JSON.stringify({ rendered: { filename: "cert.txt", contentType: "text/plain", body: "frozen" } })}::jsonb,
                ${adminId}, ${adminId})
        returning id::text as id
      `)).rows as Array<{ id: string }>;
      return rows[0]!.id;
    };
    const submitTarget = await seedRun("2026-09-13", "generated");
    const amendTarget = await seedRun("2026-09-06", "generated");
    const missingId = randomUUID();

    // Submit: B's generated run refuses exactly like a fabricated id, and
    // stays generated — the admin's submit afterwards proves it.
    const submitRefusal = await refusalOf(submitRun(db, { orgId: org.orgId, actorId: actorAId, runId: submitTarget }));
    assert.ok(submitRefusal.error instanceof HrmConstructionError);
    assert.match(submitRefusal.message, /cannot be submitted/);
    const submitMissing = await refusalOf(submitRun(db, { orgId: org.orgId, actorId: actorAId, runId: missingId }));
    assertSameRefusal(submitRefusal, submitMissing, [submitTarget, missingId]);
    const submitted = await submitRun(db, { orgId: org.orgId, actorId: adminId, runId: submitTarget });
    assert.equal(submitted.status, "submitted");

    // Amend: B's run refuses and writes nothing — read back as admin,
    // the parent is still generated and the run count never moved.
    const before = await listRuns(db, org.orgId, adminId);
    const amendRefusal = await refusalOf(amendRun(db, { orgId: org.orgId, actorId: actorAId, runId: amendTarget }));
    assert.ok(amendRefusal.error instanceof HrmConstructionError);
    assert.match(amendRefusal.message, /does not exist in this organization/);
    const after = await listRuns(db, org.orgId, adminId);
    assert.equal(after.length, before.length, "refused amend writes no run");
    assert.equal(after.find((run) => run.id === amendTarget)?.status, "generated", "parent run untouched");

    // Download: B's frozen file refuses by project name; the admin reads
    // the same bytes, proving the file exists and only the lens refused.
    const downloadRefusal = await refusalOf(downloadRun(db, org.orgId, actorAId, submitTarget));
    assert.ok(downloadRefusal.error instanceof HrmConstructionError);
    assert.match(downloadRefusal.message, /does not exist in this organization/);
    const file = await downloadRun(db, org.orgId, adminId, submitTarget);
    assert.equal(file.filename, "cert.txt");

    // Cockpit: B's project summary refuses; a fabricated project refuses
    // the same way.
    const summaryRefusal = await refusalOf(projectComplianceSummary(db, org.orgId, actorAId, projectB));
    assert.match(summaryRefusal.message, /does not exist in this organization/);
    const missingProject = randomUUID();
    const summaryMissing = await refusalOf(projectComplianceSummary(db, org.orgId, actorAId, missingProject));
    assertSameRefusal(summaryRefusal, summaryMissing, [projectB, missingProject]);
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});

test("H-CONSTRUCTION: per-diem entries fence B's amounts and approvals", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, adminId, actorAId, subB } = lens;
    const projectA = await seedEntityProject(org.orgId, org.subsidiaryId, "A Job");
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");
    const workerA = await seedWorker(org.orgId, org.subsidiaryId, "A Worker");
    const workerB = await seedWorker(org.orgId, subB, "B Worker");
    const componentId = await seedComponent(org.orgId);
    await createPolicy(db, {
      orgId: org.orgId, actorId: adminId, name: "Daily rate", basis: "flat_daily",
      rules: { amount: "75.0000" }, currency: "USD", effectiveFrom: "2026-01-01", payComponentId: componentId,
    });
    await seedTime(org.orgId, workerA.partyId, projectA, "2026-09-08", "8.0000");
    await seedTime(org.orgId, workerB.partyId, projectB, "2026-09-08", "8.0000");
    // Computing B's week as A refuses before materializing anything.
    const beforeCount = (await listEntries(db, org.orgId, adminId)).length;
    const computeRefusal = await refusalOf(
      computeForWeek(db, { orgId: org.orgId, actorId: actorAId, employmentId: workerB.employmentId, weekStart: "2026-09-07" }),
    );
    assert.ok(computeRefusal.error instanceof HrmConstructionError);
    assert.match(computeRefusal.message, /does not exist in this organization/);
    assert.equal(
      (await listEntries(db, org.orgId, adminId)).length,
      beforeCount,
      "refused compute writes no entries",
    );
    const entriesA = await computeForWeek(db, {
      orgId: org.orgId, actorId: adminId, employmentId: workerA.employmentId, weekStart: "2026-09-07",
    });
    const entriesB = await computeForWeek(db, {
      orgId: org.orgId, actorId: adminId, employmentId: workerB.employmentId, weekStart: "2026-09-07",
    });
    assert.equal(entriesA.length, 1);
    assert.equal(entriesB.length, 1);

    // The A lens lists A's entry only — B's 75.00 leaks through no row.
    const scoped = await listEntries(db, org.orgId, actorAId);
    assert.ok(scoped.some((entry) => entry.id === entriesA[0]!.id), "A entry stays visible");
    assert.ok(!scoped.some((entry) => entry.id === entriesB[0]!.id), "B entry is hidden");

    // Approving B's entry as A refuses; the admin's approval afterwards
    // proves the entry was still computed.
    const approveRefusal = await refusalOf(
      approveEntry(db, { orgId: org.orgId, actorId: actorAId, entryId: entriesB[0]!.id, kind: "per_diem" }),
    );
    assert.match(approveRefusal.message, /does not exist in this organization/);
    const approved = await approveEntry(db, {
      orgId: org.orgId, actorId: adminId, entryId: entriesB[0]!.id, kind: "per_diem",
    });
    assert.equal(approved.status, "approved");

    // Voiding B's approved entry as A refuses; the admin's void with the
    // same reason afterwards proves nothing was unlinked.
    const voidRefusal = await refusalOf(
      voidEntry(db, { orgId: org.orgId, actorId: actorAId, entryId: entriesB[0]!.id, kind: "per_diem", reason: "A void" }),
    );
    assert.match(voidRefusal.message, /cannot be voided/);
    const voided = await voidEntry(db, {
      orgId: org.orgId, actorId: adminId, entryId: entriesB[0]!.id, kind: "per_diem", reason: "A void",
    });
    assert.equal(voided.status, "voided");
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});

test("H-CONSTRUCTION: findings hide B's evidence and refuse B's transitions", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, adminId, actorAId, subB } = lens;
    const projectA = await seedEntityProject(org.orgId, org.subsidiaryId, "A Job");
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");
    const workerA = await seedWorker(org.orgId, org.subsidiaryId, "A Worker");
    const workerB = await seedWorker(org.orgId, subB, "B Worker");
    const findingA = await recordFinding(db, {
      orgId: org.orgId, actorId: adminId, kind: "missing_rate",
      projectId: projectA, workedOn: "2026-09-08", employmentId: workerA.employmentId, detail: { reason: "seed" },
    });
    const findingB = await recordFinding(db, {
      orgId: org.orgId, actorId: adminId, kind: "missing_rate",
      projectId: projectB, workedOn: "2026-09-08", employmentId: workerB.employmentId, detail: { reason: "seed" },
    });

    const scoped = await listFindings(db, org.orgId, actorAId, "open");
    assert.ok(scoped.some((finding) => finding.id === findingA.id), "A finding stays visible");
    assert.ok(!scoped.some((finding) => finding.id === findingB.id), "B finding is hidden");

    // Acknowledging B's flag as A refuses without touching it — the
    // admin's ack afterwards proves it was still open.
    const ackRefusal = await refusalOf(acknowledgeFinding(db, org.orgId, actorAId, findingB.id));
    assert.match(ackRefusal.message, /cannot be acknowledged/);
    const missingFinding = randomUUID();
    const ackMissing = await refusalOf(acknowledgeFinding(db, org.orgId, actorAId, missingFinding));
    assertSameRefusal(ackRefusal, ackMissing, [findingB.id, missingFinding]);
    const acked = await acknowledgeFinding(db, org.orgId, adminId, findingB.id);
    assert.equal(acked.status, "acknowledged");

    // Resolving B's flag as A refuses; the admin's resolve with a reason
    // afterwards proves the state never moved.
    const resolveRefusal = await refusalOf(resolveFinding(db, org.orgId, actorAId, findingB.id, "A reason"));
    assert.match(resolveRefusal.message, /cannot be resolved/);
    const resolved = await resolveFinding(db, org.orgId, adminId, findingB.id, "crew rebalanced");
    assert.equal(resolved.status, "resolved");
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});

test("H-CONSTRUCTION: the wage resolver fences B's priced day and writes no evidence", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, adminId, actorAId, subB } = lens;
    const projectA = await seedEntityProject(org.orgId, org.subsidiaryId, "A Job");
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");
    const workerA = await seedWorker(org.orgId, org.subsidiaryId, "A Worker");
    const workerB = await seedWorker(org.orgId, subB, "B Worker");
    const journey = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "ELEC-J", name: "Electrician journey", trade: "Electrical",
    });
    const scheduleA = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "union_agreement", name: "A local",
      appliesTo: { project_ids: [projectA] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    const scheduleB = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "union_agreement", name: "B local",
      appliesTo: { project_ids: [projectB] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    for (const scheduleId of [scheduleA.id, scheduleB.id]) {
      await addScheduleLine(db, {
        orgId: org.orgId, actorId: adminId, scheduleId, classificationId: journey.id,
        baseRate: "60.0000", fringeRate: "3.0000", currency: "USD", effectiveFrom: "2026-01-01",
      });
    }
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId: workerA.employmentId,
      classificationId: journey.id, effectiveFrom: "2026-01-01",
    });
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId: workerB.employmentId,
      classificationId: journey.id, effectiveFrom: "2026-01-01",
    });

    // In-scope control: A's worker prices on A's project.
    const priced = await resolveWage(db, {
      orgId: org.orgId, actorId: actorAId, employmentId: workerA.employmentId,
      projectId: projectA, workedOn: "2026-09-08",
    });
    assert.equal(priced.base, "60.0000");

    // B's worker refuses exactly like a fabricated employment — and the
    // refused pricing writes no finding naming B.
    const openBefore = (await listFindings(db, org.orgId, adminId, "open"))
      .filter((finding) => finding.employmentId === workerB.employmentId);
    const wageRefusal = await refusalOf(resolveWage(db, {
      orgId: org.orgId, actorId: actorAId, employmentId: workerB.employmentId,
      projectId: projectB, workedOn: "2026-09-08",
    }));
    assert.ok(wageRefusal.error instanceof HrmConstructionError);
    assert.match(wageRefusal.message, /does not exist in this organization/);
    const missingEmployment = randomUUID();
    const wageMissing = await refusalOf(resolveWage(db, {
      orgId: org.orgId, actorId: actorAId, employmentId: missingEmployment,
      projectId: projectB, workedOn: "2026-09-08",
    }));
    assertSameRefusal(wageRefusal, wageMissing, [workerB.employmentId, missingEmployment]);
    const openAfter = (await listFindings(db, org.orgId, adminId, "open"))
      .filter((finding) => finding.employmentId === workerB.employmentId);
    assert.equal(openAfter.length, openBefore.length, "refused pricing flags nothing");

    // A grant-less but unrestricted approver still prices (the
    // approval-time hook contract): the lens fences, never the grant.
    const approverId = await createScratchUser(org.orgId, "Hook Approver", "cscope_hook");
    const hookPriced = await resolveWage(db, {
      orgId: org.orgId, actorId: approverId, employmentId: workerA.employmentId,
      projectId: projectA, workedOn: "2026-09-08",
    });
    assert.equal(hookPriced.base, "60.0000");
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});

test("H-CONSTRUCTION: ratio, split, and classify refuse B's project", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, actorAId, subB } = lens;
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");

    const checkRefusal = await refusalOf(
      checkDay(db, { orgId: org.orgId, actorId: actorAId, projectId: projectB, workedOn: "2026-09-08" }),
    );
    assert.match(checkRefusal.message, /does not exist in this organization/);

    const splitRefusal = await refusalOf(
      dailySplit(db, { orgId: org.orgId, actorId: actorAId, projectId: projectB, workedOn: "2026-09-08" }),
    );
    assert.match(splitRefusal.message, /does not exist in this organization/);

    const classifyRefusal = await refusalOf(
      classify(db, { orgId: org.orgId, actorId: actorAId, projectId: projectB, workedOn: "2026-09-08" }),
    );
    assert.match(classifyRefusal.message, /does not exist in this organization/);
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});

test("H-CONSTRUCTION: config writes refuse B anchors and org-wide needs the remedy", { skip: !DB }, async () => {
  const lens = await setupLens();
  try {
    const { org, adminId, actorAId, subB } = lens;
    const projectB = await seedEntityProject(org.orgId, subB, "B Job");
    const workerA = await seedWorker(org.orgId, org.subsidiaryId, "A Worker");
    const workerB = await seedWorker(org.orgId, subB, "B Worker");
    const journey = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "PLMB-J", name: "Plumber journey", trade: "Plumbing",
    });
    const apprentice = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "PLMB-A", name: "Plumber apprentice", trade: "Plumbing",
      isApprentice: true, journeyClassificationId: journey.id,
    });
    const scheduleB = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "prevailing_wage", name: "B schedule",
      appliesTo: { project_ids: [projectB] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    const scheduleOrg = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "org_declared", name: "Shared schedule",
      appliesTo: {}, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    const compClass = await createCompClass(db, {
      orgId: org.orgId, actorId: adminId, code: "5183", name: "Plumbing", ratePer100: "4.5000",
      effectiveFrom: "2026-01-01",
    });

    // Schedule reads fence the same way: B-targeted lines never reach
    // the A lens, while the shared org-wide schedule stays readable.
    const schedulesA = await listSchedules(db, org.orgId, actorAId);
    assert.ok(!schedulesA.some((schedule) => schedule.id === scheduleB.id), "B schedule hidden from the A lens");
    assert.ok(schedulesA.some((schedule) => schedule.id === scheduleOrg.id), "shared schedule stays readable");

    // B-anchored declarations refuse as not-found.
    const scheduleRefusal = await refusalOf(createSchedule(db, {
      orgId: org.orgId, actorId: actorAId, kind: "union_agreement", name: "B local",
      appliesTo: { project_ids: [projectB] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    }));
    assert.match(scheduleRefusal.message, /does not exist in this organization/);

    const lineRefusal = await refusalOf(addScheduleLine(db, {
      orgId: org.orgId, actorId: actorAId, scheduleId: scheduleB.id, classificationId: journey.id,
      baseRate: "60.0000", currency: "USD", effectiveFrom: "2026-01-01",
    }));
    assert.match(lineRefusal.message, /does not exist in this organization/);

    const scopeRefusal = await refusalOf(updateScheduleScope(db, {
      orgId: org.orgId, actorId: actorAId, scheduleId: scheduleB.id, appliesTo: {},
    }));
    assert.match(scopeRefusal.message, /does not exist in this organization/);

    const assignRefusal = await refusalOf(assignClassification(db, {
      orgId: org.orgId, actorId: actorAId, employmentId: workerB.employmentId,
      classificationId: journey.id, effectiveFrom: "2026-01-01",
    }));
    assert.match(assignRefusal.message, /does not exist in this organization/);

    const ruleRefusal = await refusalOf(createCompRule(db, {
      orgId: org.orgId, actorId: actorAId, priority: 1,
      match: { project_id: projectB }, compClassId: compClass.id,
    }));
    assert.match(ruleRefusal.message, /does not exist in this organization/);

    const ratioRefusal = await refusalOf(createRatioRule(db, {
      orgId: org.orgId, actorId: actorAId, scheduleId: scheduleB.id,
      journeyClassificationId: journey.id, apprenticeClassificationId: apprentice.id,
      ratioJourney: 3, ratioApprentice: 1, measured: "daily", effectiveFrom: "2026-01-01",
    }));
    assert.match(ratioRefusal.message, /does not exist in this organization/);

    // The home local prices the worker by reciprocity: naming B's
    // schedule from A's assignment refuses, while the admin's
    // shared-schedule reference proves valid refs still assign.
    const homeRefusal = await refusalOf(assignClassification(db, {
      orgId: org.orgId, actorId: actorAId, employmentId: workerA.employmentId,
      classificationId: journey.id, effectiveFrom: "2026-01-01", homeScheduleId: scheduleB.id,
    }));
    assert.match(homeRefusal.message, /does not exist in this organization/);
    const homeOk = await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId: workerA.employmentId,
      classificationId: journey.id, effectiveFrom: "2026-01-01", homeScheduleId: scheduleOrg.id,
    });
    assert.equal(homeOk.homeScheduleId, scheduleOrg.id);

    // Org-wide config refuses by name with the remedy — never silent, never saved.
    const orgWideSchedule = await refusalOf(createSchedule(db, {
      orgId: org.orgId, actorId: actorAId, kind: "org_declared", name: "Everywhere",
      appliesTo: {}, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    }));
    assert.ok(orgWideSchedule.error instanceof UnrestrictedScopeError);
    assert.match(orgWideSchedule.message, /requires unrestricted subsidiary access/);

    const classificationRefusal = await refusalOf(createClassification(db, {
      orgId: org.orgId, actorId: actorAId, code: "X-1", name: "X", trade: "X",
    }));
    assert.ok(classificationRefusal.error instanceof UnrestrictedScopeError);
    assert.match(classificationRefusal.message, /requires unrestricted subsidiary access/);

    const compClassRefusal = await refusalOf(createCompClass(db, {
      orgId: org.orgId, actorId: actorAId, code: "5184", name: "Other", ratePer100: "1.0000",
      effectiveFrom: "2026-01-01",
    }));
    assert.ok(compClassRefusal.error instanceof UnrestrictedScopeError);
    assert.match(compClassRefusal.message, /requires unrestricted subsidiary access/);

    const stateRuleRefusal = await refusalOf(createCompRule(db, {
      orgId: org.orgId, actorId: actorAId, priority: 1,
      match: { state_code: "CA" }, compClassId: compClass.id,
    }));
    assert.ok(stateRuleRefusal.error instanceof UnrestrictedScopeError);
    assert.match(stateRuleRefusal.message, /requires unrestricted subsidiary access/);

    const policyRefusal = await refusalOf(createPolicy(db, {
      orgId: org.orgId, actorId: actorAId, name: "A policy", basis: "flat_daily",
      rules: { amount: "10.0000" }, currency: "USD", effectiveFrom: "2026-01-01",
    }));
    assert.ok(policyRefusal.error instanceof UnrestrictedScopeError);
    assert.match(policyRefusal.message, /requires unrestricted subsidiary access/);
  } finally {
    await dropScratchOrg(lens.org.orgId);
  }
});
