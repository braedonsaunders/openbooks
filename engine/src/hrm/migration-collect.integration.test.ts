import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  collectLegacyEmployments,
  EmploymentCollectionError,
  hashCollectedInput,
  type OperatorEmploymentMapping,
} from "./migration-collect.ts";
import {
  preflightEmploymentMigration,
  type SourcePersonRow,
} from "./migration-preflight.ts";
import {
  EmploymentMigrationRefusalError,
  executeEmploymentMigration,
  migrationExitCode,
  type EmploymentMigrationReport,
} from "./migration-execute.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

/**
 * Slice B2 legacy evidence collector proofs (integration partition): clean
 * employees collect to classifier-ready rows with candidates, subsidiary
 * conflicts and post-termination activity are reported never resolved, every
 * anchor source maps to an observation, missing anchors refuse downstream,
 * tenant RLS holds, collections are byte-deterministic, and the operator CLI
 * runs collect -> dry-run -> apply -> already_migrated end to end.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const TSX_CLI = resolve(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_CLI = resolve(ROOT, "scripts", "hrm-migrate-employments.ts");

interface ProfileSeed {
  scheduleId: string;
  province?: string;
  labourJurisdiction?: string | null;
}

async function seedSubsidiary(org: ScratchOrg, name: string): Promise<string> {
  const id = randomUUID();
  await withOrg(org.orgId, async () => {
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${name}, 'CAD', 'CA')`);
  });
  return id;
}

async function seedSchedule(orgId: string, name: string, subsidiaryId: string | null): Promise<string> {
  const id = randomUUID();
  await withOrg(orgId, async () => {
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year,
                                 anchor_period_end, subsidiary_id)
      values (${id}, ${orgId}, ${name}, 'biweekly', 26, '2026-07-18', ${subsidiaryId})`);
  });
  return id;
}

async function seedEmployee(
  org: ScratchOrg,
  name: string,
  role: { hiredOn: string | null; terminatedOn?: string | null },
  profile: ProfileSeed | null,
  partySubsidiaryId?: string,
): Promise<{ partyId: string; roleId: string }> {
  const partyId = randomUUID();
  const roleId = randomUUID();
  const subsidiary = partySubsidiaryId ?? org.subsidiaryId;
  await withOrg(org.orgId, async () => {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${partyId}, ${org.orgId}, 'employee', ${name}, ${subsidiary})`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, hired_on, terminated_on)
      values (${roleId}, ${org.orgId}, ${partyId}, ${role.hiredOn}, ${role.terminatedOn ?? null})`);
    if (profile !== null) {
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id,
                                               country,
                                               province, labour_jurisdiction)
        values (${org.orgId}, ${partyId}, ${profile.scheduleId}, 'CA', ${profile.province ?? "ON"},
                ${profile.labourJurisdiction ?? null})`);
    }
  });
  return { partyId, roleId };
}

async function seedCommittedStub(
  org: ScratchOrg,
  actorId: string,
  scheduleId: string,
  partyId: string,
  payDate: string,
): Promise<void> {
  const documentId = randomUUID();
  await withOrg(org.orgId, async () => {
    await db.execute(sql`
      insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                             currency, status, created_by, updated_by)
      values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${payDate}-${partyId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${payDate}, 'CAD', 'approved', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, run_status, created_by, updated_by)
      values (${documentId}, ${org.orgId}, ${scheduleId}, ${payDate}, ${payDate},
              ${payDate}, 2026, 'committed', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                             periods_per_year, pay_date, tax_year, currency_code,
                             created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${partyId}, 'ON', 26,
              ${payDate}, 2026, 'CAD', ${actorId}, ${actorId})`);
  });
}

async function seedApprovedWeek(org: ScratchOrg, partyId: string, weekStart: string): Promise<void> {
  await withOrg(org.orgId, async () => {
    await db.execute(sql`
      insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status)
      values (${randomUUID()}, ${org.orgId}, ${partyId}, ${weekStart}, 'approved')`);
  });
}

async function seedLedgerMovement(org: ScratchOrg, partyId: string, movementDate: string): Promise<void> {
  const planId = randomUUID();
  await withOrg(org.orgId, async () => {
    await db.execute(sql`
      insert into entitlement_plans (id, org_id, code, name)
      values (${planId}, ${org.orgId}, 'B2BANK', 'B2 time bank')`);
    await db.execute(sql`
      insert into entitlement_ledger (id, org_id, plan_id, employee_party_id,
                                      movement_date, amount, kind)
      values (${randomUUID()}, ${org.orgId}, ${planId}, ${partyId},
              ${movementDate}, '10', 'accrual')`);
  });
}

function rowByParty(rows: readonly SourcePersonRow[], partyId: string): SourcePersonRow {
  const row = rows.find((candidate) => candidate.nativePartyId === partyId);
  assert.ok(row, `expected a collected row for party ${partyId}`);
  return row;
}

test("clean employees collect to ready rows with observation candidates", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const scheduleId = await seedSchedule(org.orgId, "Collector biweekly", org.subsidiaryId);
    const active = await seedEmployee(
      org, "Collector Active", { hiredOn: "2022-03-14" }, { scheduleId });
    const departed = await seedEmployee(
      org, "Collector Departed", { hiredOn: "2020-01-15", terminatedOn: "2026-04-30" }, { scheduleId });
    await seedCommittedStub(org, actorId, scheduleId, active.partyId, "2026-09-10");
    await seedCommittedStub(org, actorId, scheduleId, departed.partyId, "2026-04-30");

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.orgId, org.orgId);
    assert.equal(collected.rows.length, 2);
    const partyOrder = [active.partyId, departed.partyId].sort();
    assert.deepEqual(
      collected.rows.map((row) => row.nativePartyId),
      partyOrder,
      "rows arrive in deterministic party-id order",
    );
    assert.equal(collected.evidenceHash, hashCollectedInput(collected.rows));

    const activeRow = rowByParty(collected.rows, active.partyId);
    assert.ok(activeRow.role, "collected rows always carry the role inventory");
    assert.equal(activeRow.sourceId, active.roleId);
    assert.equal(activeRow.sourceVersion, "collect-v2");
    assert.equal(activeRow.party.kind, "employee");
    assert.equal(activeRow.employer.assertedSubsidiaryId, org.subsidiaryId);
    assert.ok(
      activeRow.employer.subsidiaryFacts.some(
        (fact) => fact.id === org.subsidiaryId && fact.isActive && !fact.isEliminated,
      ),
      "org subsidiary facts accompany the assertion",
    );
    assert.equal(activeRow.role.present, true);
    assert.equal(activeRow.role.hiredOn, "2022-03-14");
    assert.equal(activeRow.role.dateProvenance, "employee_roles.hired_on");
    assert.equal(activeRow.payroll?.present, true);
    assert.equal(activeRow.payroll?.subsidiaryId, org.subsidiaryId);
    assert.equal(activeRow.observation?.status, "active");
    assert.equal(activeRow.observation?.observedAt, "2026-09-10T00:00:00Z");
    assert.ok(
      (activeRow.observation?.provenance ?? "").includes("pay_stubs"),
      "observation provenance names the anchor source",
    );
    assert.equal(activeRow.existingBinding, null);

    const departedRow = rowByParty(collected.rows, departed.partyId);
    assert.ok(departedRow.role, "collected rows always carry the role inventory");
    assert.equal(departedRow.observation?.status, "terminated");
    assert.equal(departedRow.observation?.observedAt, "2026-04-30T00:00:00Z");
    assert.equal(departedRow.role.terminatedOn, "2026-04-30");

    const preflight = preflightEmploymentMigration(collected.rows);
    assert.deepEqual(preflight.counts.ready, 2);
    assert.equal(preflight.rows.length, 2, "both collected persons are classified");
    for (const evaluated of preflight.rows) {
      assert.equal(evaluated.classification, "ready");
      assert.equal(evaluated.historicalCoverage, "unknown");
      assert.ok(evaluated.candidate, "ready rows carry an observation-date candidate");
      assert.equal(evaluated.candidate?.employerSubsidiaryId, org.subsidiaryId);
    }
    const byParty = new Map(preflight.rows.map((evaluated) => [evaluated.nativePartyId, evaluated]));
    assert.equal(byParty.get(active.partyId)?.candidate?.status, "active");
    assert.equal(byParty.get(active.partyId)?.candidate?.effectiveFrom, "2026-09-10");
    assert.equal(byParty.get(active.partyId)?.serviceStart, "2022-03-14");
    assert.equal(byParty.get(departed.partyId)?.candidate?.status, "terminated");
    assert.equal(byParty.get(departed.partyId)?.candidate?.effectiveFrom, "2026-04-30");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an org-wide schedule (subsidiary null) collects and classifies ready, never refused", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    // The production shape: one schedule shared by every subsidiary. Its
    // subsidiary_id is null by design, and the LEFT JOIN still finds it.
    const scheduleId = await seedSchedule(org.orgId, "Org-wide biweekly", null);
    const employee = await seedEmployee(
      org, "Org-wide Employee", { hiredOn: "2021-06-01" }, { scheduleId });
    await seedCommittedStub(org, actorId, scheduleId, employee.partyId, "2026-09-10");

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.rows.length, 1);
    const row = rowByParty(collected.rows, employee.partyId);
    assert.equal(row.payroll?.present, true);
    assert.equal(row.payroll?.subsidiaryId, null, "an org-wide schedule corroborates no subsidiary");
    assert.equal(row.employer.assertedSubsidiaryId, org.subsidiaryId);

    const preflight = preflightEmploymentMigration(collected.rows);
    assert.equal(preflight.counts.ready, 1);
    assert.equal(preflight.rows[0]?.classification, "ready");
    assert.equal(preflight.rows[0]?.candidate?.employerSubsidiaryId, org.subsidiaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("schedule subsidiary versus party subsidiary collects a conflict the classifier refuses", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const otherSubsidiary = await seedSubsidiary(org, "Second Co");
    const homeSchedule = await seedSchedule(org.orgId, "Home biweekly", org.subsidiaryId);
    const otherSchedule = await seedSchedule(org.orgId, "Second biweekly", otherSubsidiary);
    void homeSchedule;
    const person = await seedEmployee(
      org, "Collector Conflict", { hiredOn: "2021-05-01" }, { scheduleId: otherSchedule });
    await seedCommittedStub(org, actorId, otherSchedule, person.partyId, "2026-09-10");

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.rows.length, 1);
    const row = collected.rows[0]!;
    // The collector reports both facts: party subsidiary asserted, schedule
    // subsidiary scoped. It never prefers one.
    assert.equal(row.employer.assertedSubsidiaryId, org.subsidiaryId);
    assert.equal(row.payroll?.subsidiaryId, otherSubsidiary);

    const preflight = preflightEmploymentMigration(collected.rows);
    assert.equal(preflight.rows.length, 1);
    const evaluated = preflight.rows[0]!;
    assert.equal(evaluated.classification, "ambiguous");
    assert.ok(
      evaluated.issues.some((issue) => issue.code === "schedule_employer_conflict"),
      "conflicting employer evidence refuses instead of resolving",
    );
    assert.equal(evaluated.candidate, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// A recorded terminated_on anchors a terminated observation only when NOTHING
// else does (see the anchorless test below): with activity dated after it the
// conflict still wins, because a declaration never settles a conflict with
// observed activity.
test("post-termination activity is reported as a conflict, never preferred", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const scheduleId = await seedSchedule(org.orgId, "Post-term biweekly", org.subsidiaryId);
    const person = await seedEmployee(
      org, "Collector PostTerm", { hiredOn: "2020-01-15", terminatedOn: "2026-04-30" }, { scheduleId });
    await seedCommittedStub(org, actorId, scheduleId, person.partyId, "2026-06-15");

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.rows.length, 1);
    const row = collected.rows[0]!;
    assert.ok(row.role, "collected rows always carry the role inventory");
    assert.equal(row.role.terminatedOn, "2026-04-30");
    assert.equal(row.observation?.status, "unknown");
    assert.match(
      row.observation?.provenance ?? "",
      /terminated_on:2026-04-30/,
      "provenance names the termination event",
    );
    assert.match(
      row.observation?.provenance ?? "",
      /pay_stubs/,
      "provenance names the later activity",
    );

    assert.equal(row.observation?.conflict?.terminatedOn, "2026-04-30", "the conflict carries the termination date");
    assert.equal(row.observation?.conflict?.activityDate, "2026-06-15", "the conflict carries the later activity date");
    assert.match(row.observation?.conflict?.activityAnchor ?? "", /^pay_stubs:[^@]+@2026-06-15$/, "the conflict names the later anchor");

    // The classifier names the conflict as its own verdict: the observation
    // is present, so it is never reported as missing, and the remedy is to
    // reconcile the facts, never to assert a state over them.
    const preflight = preflightEmploymentMigration(collected.rows);
    assert.equal(preflight.rows[0]?.candidate, null);
    assert.equal(preflight.rows[0]?.classification, "requires_review");
    const verdict = preflight.rows[0]?.issues.find((issue) => issue.code === "post_termination_activity");
    assert.ok(verdict, "post-termination activity is a named verdict");
    assert.match(verdict.detail, /terminated_on 2026-04-30, but pay_stubs:.*@2026-06-15 is dated 2026-06-15/);
    assert.match(verdict.remedy, /correct the termination date/);
    const refusal = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: collected.rows }),
    ).then(
      () => {
        throw new Error("post-termination collection was expected to refuse");
      },
      (error: unknown) => {
        assert.ok(error instanceof EmploymentMigrationRefusalError);
        return error;
      },
    );
    const refused = refusal.report.persons[0]!;
    assert.equal(refused.outcome, "refused");
    assert.ok(
      refused.issues.some((issue) => issue.code === "post_termination_activity"),
      "unresolved status refuses under its own verdict instead of migrating either side",
    );
    assert.ok(
      !refused.issues.some((issue) => issue.code === "missing_current_observation"),
      "a present-but-conflicting observation is never reported as missing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("every anchor source maps to an observation", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const scheduleId = await seedSchedule(org.orgId, "Anchor biweekly", org.subsidiaryId);
    const weekly = await seedEmployee(
      org, "Collector Weekly", { hiredOn: "2023-02-01" }, { scheduleId });
    const entitled = await seedEmployee(
      org, "Collector Entitled", { hiredOn: "2023-03-01" }, { scheduleId });
    await seedApprovedWeek(org, weekly.partyId, "2026-09-13");
    await seedLedgerMovement(org, entitled.partyId, "2026-09-01");

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.rows.length, 2);
    const weeklyRow = rowByParty(collected.rows, weekly.partyId);
    assert.equal(weeklyRow.observation?.status, "active");
    assert.equal(weeklyRow.observation?.observedAt, "2026-09-13T00:00:00Z");
    assert.ok((weeklyRow.observation?.provenance ?? "").includes("timesheet_weeks"));
    const entitledRow = rowByParty(collected.rows, entitled.partyId);
    assert.equal(entitledRow.observation?.status, "active");
    assert.equal(entitledRow.observation?.observedAt, "2026-09-01T00:00:00Z");
    assert.ok((entitledRow.observation?.provenance ?? "").includes("entitlement_ledger"));

    const preflight = preflightEmploymentMigration(collected.rows);
    assert.deepEqual(preflight.counts.ready, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("no anchor and no termination collects a null observation the executor refuses", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const scheduleId = await seedSchedule(org.orgId, "Unanchored biweekly", org.subsidiaryId);
    const person = await seedEmployee(
      org, "Collector Unanchored", { hiredOn: "2024-01-10" }, { scheduleId });
    // An active flag on the role is not evidence either: absent terminated_on
    // never implies active (the ruling is one-directional).
    await withOrg(org.orgId, () =>
      db.execute(sql`update employee_roles set is_active = true where id = ${person.roleId}`));

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.rows.length, 1);
    assert.equal(collected.rows[0]?.nativePartyId, person.partyId);
    assert.equal(collected.rows[0]?.observation, null);

    const refusal = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: collected.rows }),
    ).then(
      () => {
        throw new Error("unanchored collection was expected to refuse");
      },
      (error: unknown) => {
        assert.ok(error instanceof EmploymentMigrationRefusalError);
        return error;
      },
    );
    assert.ok(
      refusal.report.persons[0]?.issues.some(
        (issue) => issue.code === "missing_current_observation",
      ),
      "refusal names the missing observation",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a recorded terminated_on alone anchors a terminated observation that migrates", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const scheduleId = await seedSchedule(org.orgId, "Departed biweekly", org.subsidiaryId);
    const departed = await seedEmployee(
      org, "Collector Old Departed", { hiredOn: "2015-06-01", terminatedOn: "2019-11-30" }, { scheduleId });
    const undated = await seedEmployee(
      org, "Collector Undated", { hiredOn: "2016-02-01" }, { scheduleId });

    const collected = await collectLegacyEmployments(org.orgId);
    assert.equal(collected.rows.length, 2);
    const departedRow = rowByParty(collected.rows, departed.partyId);
    assert.deepEqual(departedRow.observation, {
      status: "terminated",
      observedAt: "2019-11-30T00:00:00Z",
      provenance: "employee_roles.terminated_on",
    });
    assert.equal(departedRow.sourceVersion, "collect-v2");
    // The asymmetry: the same absence of anchors with no termination date
    // yields nothing, never active.
    assert.equal(rowByParty(collected.rows, undated.partyId).observation, null);

    const preflight = preflightEmploymentMigration(collected.rows);
    const byParty = new Map(preflight.rows.map((evaluated) => [evaluated.nativePartyId, evaluated]));
    assert.equal(byParty.get(departed.partyId)?.classification, "ready");
    assert.equal(byParty.get(departed.partyId)?.candidate?.status, "terminated");
    assert.equal(byParty.get(departed.partyId)?.candidate?.effectiveFrom, "2019-11-30");
    assert.equal(byParty.get(departed.partyId)?.serviceStart, "2015-06-01");
    assert.equal(byParty.get(undated.partyId)?.candidate, null);

    const report = await withOrg(org.orgId, () =>
      executeEmploymentMigration({ orgId: org.orgId, rows: collected.rows, dryRun: true, allowPartial: true }),
    );
    const outcomes = new Map(report.persons.map((person) => [person.nativePartyId, person]));
    assert.equal(outcomes.get(departed.partyId)?.outcome, "would_migrate");
    assert.equal(outcomes.get(undated.partyId)?.outcome, "refused");
    assert.ok(
      outcomes.get(undated.partyId)?.issues.some((issue) => issue.code === "missing_current_observation"),
      "the undated person is still refused for want of an observation",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("operator mappings attach as resolution evidence with provenance", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const scheduleId = await seedSchedule(org.orgId, "Mapped biweekly", org.subsidiaryId);
    // No hire date on the role: the mapping supplies it.
    const person = await seedEmployee(org, "Collector Mapped", { hiredOn: null }, { scheduleId });
    await seedCommittedStub(org, actorId, scheduleId, person.partyId, "2026-09-10");
    const mappings: OperatorEmploymentMapping[] = [
      {
        partyId: person.partyId,
        employerSubsidiaryId: org.subsidiaryId,
        hiredOn: "2021-06-01",
        terminatedOn: null,
        approvedBy: "operator-1",
        approvedAt: "2026-09-01T10:00:00Z",
        rationale: "offer letter on file",
      },
    ];

    const collected = await collectLegacyEmployments(org.orgId, { operatorMappings: mappings });
    assert.equal(collected.rows.length, 1);
    const row = collected.rows[0]!;
    assert.equal(row.resolution?.kind, "operator-employer-date-mapping");
    assert.equal(row.resolution?.hiredOn, "2021-06-01");
    assert.equal(row.resolution?.approvedBy, "operator-1");

    const preflight = preflightEmploymentMigration(collected.rows);
    assert.equal(preflight.rows[0]?.classification, "ready");
    assert.equal(preflight.rows[0]?.serviceStart, "2021-06-01");
    assert.equal(
      preflight.rows[0]?.serviceStartProvenance,
      "operator-employer-date-mapping",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an operator mapping for an uncollected party is refused, never dropped", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const scheduleId = await seedSchedule(org.orgId, "Strict biweekly", org.subsidiaryId);
    await seedEmployee(org, "Collector Strict", { hiredOn: "2022-01-01" }, { scheduleId });
    const mappings: OperatorEmploymentMapping[] = [
      {
        partyId: randomUUID(),
        employerSubsidiaryId: null,
        hiredOn: null,
        terminatedOn: null,
        approvedBy: "operator-1",
        approvedAt: "2026-09-01T10:00:00Z",
        rationale: "stray override",
      },
    ];
    await assert.rejects(
      collectLegacyEmployments(org.orgId, { operatorMappings: mappings }),
      (error: unknown) => {
        assert.ok(error instanceof EmploymentCollectionError);
        assert.match((error as Error).message, /did not collect/);
        return true;
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a second org's employees never appear in a collection", { skip }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const scheduleA = await seedSchedule(orgA.orgId, "RLS biweekly A", orgA.subsidiaryId);
    const scheduleB = await seedSchedule(orgB.orgId, "RLS biweekly B", orgB.subsidiaryId);
    const employeeA = await seedEmployee(
      orgA, "Collector Home", { hiredOn: "2022-01-01" }, { scheduleId: scheduleA });
    const employeeB = await seedEmployee(
      orgB, "Collector Away", { hiredOn: "2022-01-01" }, { scheduleId: scheduleB });

    const collectedA = await collectLegacyEmployments(orgA.orgId);
    assert.equal(collectedA.rows.length, 1);
    assert.equal(collectedA.rows[0]?.orgId, orgA.orgId);
    assert.equal(collectedA.rows[0]?.nativePartyId, employeeA.partyId);
    const collectedB = await collectLegacyEmployments(orgB.orgId);
    assert.equal(collectedB.rows.length, 1);
    assert.equal(collectedB.rows[0]?.nativePartyId, employeeB.partyId);
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, [TSX_CLI, MIGRATE_CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function reportJson(stdout: string): EmploymentMigrationReport {
  return JSON.parse(stdout.slice(stdout.indexOf("{"))) as EmploymentMigrationReport;
}

function evidenceHashFrom(stderr: string): string {
  const match = /evidence hash ([0-9a-f]{64})/.exec(stderr);
  assert.ok(match, `expected an evidence hash on stderr, got: ${stderr}`);
  return match[1]!;
}

test("operator CLI runs collect, dry-run, apply, then already_migrated", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const scheduleId = await seedSchedule(org.orgId, "E2E biweekly", org.subsidiaryId);
    const active = await seedEmployee(
      org, "E2E Active", { hiredOn: "2022-03-14" }, { scheduleId });
    const departed = await seedEmployee(
      org, "E2E Departed", { hiredOn: "2020-01-15", terminatedOn: "2026-04-30" }, { scheduleId });
    await seedCommittedStub(org, actorId, scheduleId, active.partyId, "2026-09-10");
    await seedCommittedStub(org, actorId, scheduleId, departed.partyId, "2026-04-30");

    const collected = runCli([`--collect=${org.orgId}`]);
    assert.equal(collected.status, 0, `collect failed: ${collected.stderr}`);
    const rows = JSON.parse(collected.stdout) as SourcePersonRow[];
    assert.equal(rows.length, 2);
    const firstHash = evidenceHashFrom(collected.stderr);

    const scratchDir = mkdtempSync(resolve(tmpdir(), "hrm-collect-e2e-"));
    const rowsPath = resolve(scratchDir, "rows.json");
    writeFileSync(rowsPath, collected.stdout);

    const dry = runCli([`--org=${org.orgId}`, `--input=${rowsPath}`]);
    assert.equal(dry.status, 0, `dry run failed: ${dry.stderr}\n${dry.stdout}`);
    const dryReport = reportJson(dry.stdout);
    assert.equal(dryReport.totals.wouldMigrate, 2);
    assert.equal(dryReport.totals.refused, 0);

    const applied = runCli([`--org=${org.orgId}`, `--input=${rowsPath}`, "--apply"]);
    assert.equal(applied.status, 0, `apply failed: ${applied.stderr}\n${applied.stdout}`);
    const appliedReport = reportJson(applied.stdout);
    assert.equal(appliedReport.totals.migrated, 2);
    assert.equal(appliedReport.totals.refused, 0);
    const stored = await withBypassContext(async () => {
      const result = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from worker_employments where org_id = ${org.orgId}`)) as unknown as {
        rows: Array<{ n: string }>;
      };
      return result.rows[0]?.n;
    });
    assert.equal(stored, "2");

    // Re-collection after migration is byte-identical, and the dry run
    // reports the settled persons instead of migrating again.
    const recollected = runCli([`--collect=${org.orgId}`]);
    assert.equal(recollected.status, 0, `re-collect failed: ${recollected.stderr}`);
    assert.equal(evidenceHashFrom(recollected.stderr), firstHash);
    writeFileSync(rowsPath, recollected.stdout);
    const again = runCli([`--org=${org.orgId}`, `--input=${rowsPath}`]);
    assert.equal(again.status, 0, `re-run dry run failed: ${again.stderr}\n${again.stdout}`);
    const againReport = reportJson(again.stdout);
    assert.equal(againReport.totals.alreadyMigrated, 2);
    assert.equal(againReport.totals.wouldMigrate, 0);
    assert.equal(againReport.totals.refused, 0);
    assert.equal(againReport.persons.length, 2, "the re-run reports both persons");
    for (const person of againReport.persons) {
      assert.equal(person.classification, "already_migrated");
      assert.equal(person.outcome, "already_migrated");
    }
    assert.equal(migrationExitCode(againReport), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("two collections of one org are byte-identical", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const scheduleId = await seedSchedule(org.orgId, "Stable biweekly", org.subsidiaryId);
    const person = await seedEmployee(
      org, "Collector Stable", { hiredOn: "2022-03-14" }, { scheduleId });
    await seedCommittedStub(org, actorId, scheduleId, person.partyId, "2026-09-10");

    const first = await collectLegacyEmployments(org.orgId);
    const second = await collectLegacyEmployments(org.orgId);
    assert.deepEqual(second.rows, first.rows);
    assert.equal(second.evidenceHash, first.evidenceHash);
    assert.equal(first.evidenceHash, hashCollectedInput(first.rows));
    assert.match(first.evidenceHash, /^[0-9a-f]{64}$/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
