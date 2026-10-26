import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { getAutomationRun, listAutomationRuns, AutomationServiceError } from "./services.ts";
import { resolveRunSubjectSubsidiaries } from "./run-scope.ts";
import { loadSubjectSnapshot } from "./registry.ts";

/**
 * H-AUTORUNS: run history is scoped by the run subject's subsidiary.
 * getAutomationRun checked automations.read plus org_id, then returned
 * triggerPayload, subjectId, error and steps for ANY org run; the runs
 * list exposed every subjectKind. A restricted caller now sees only runs
 * whose subject sits in their lens, and an out-of-scope (or
 * subjectless) run answers exactly like a missing one — never a scope
 * disclosure. Only the service is under test; no authz is doubled.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Harness {
  orgId: string;
  subA: string;
  subB: string;
  automationId: string;
  runA: string;
  runB: string;
  runBare: string;
  restrictedId: string;
  adminId: string;
}

async function grant(orgId: string, userId: string, permission: string): Promise<void> {
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${orgId}, ${userId}, ${permission}, 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'
  `);
}

async function seed(): Promise<Harness> {
  const org = await createScratchOrg();
  const subB = await withBypassContext(
    async () =>
      (
        await db.execute<{ id: string }>(
          sql`
    insert into subsidiaries (org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${org.orgId}, ${org.subsidiaryId}, 'Other Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    returning id`,
          "objects",
        )
      )[0]!.id,
  );
  const projectA = await withBypassContext(
    async () =>
      (
        await db.execute<{ id: string }>(
          sql`
    insert into projects (org_id, name, is_active, subsidiary_id)
    values (${org.orgId}, 'Scope project A', true, ${org.subsidiaryId})
    returning id`,
          "objects",
        )
      )[0]!.id,
  );
  const projectB = await withBypassContext(
    async () =>
      (
        await db.execute<{ id: string }>(
          sql`
    insert into projects (org_id, name, is_active, subsidiary_id)
    values (${org.orgId}, 'Scope project B', true, ${subB})
    returning id`,
          "objects",
        )
      )[0]!.id,
  );
  const adminId = await createScratchUser(org.orgId, "Run Scope Admin", "run_scope_admin");
  await grant(org.orgId, adminId, "automations.read");
  const restrictedId = await createScratchUser(org.orgId, "Run Scope Viewer", "run_scope_viewer");
  await grant(org.orgId, restrictedId, "automations.read");
  await withBypassContext(async () =>
    db.execute(sql`
    update app_roles set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
     where org_id = ${org.orgId} and key = 'run_scope_viewer'`),
  );
  const automationId = await withBypassContext(
    async () =>
      (
        await db.execute<{ id: string }>(
          sql`
    insert into automations (org_id, name, status, trigger, rules, conditions, actions)
    values (${org.orgId}, 'run scope recipe', 'enabled',
            '{"kind":"manual"}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
    returning id`,
          "objects",
        )
      )[0]!.id,
  );
  const mkRun = async (subjectKind: string | null, subjectId: string | null): Promise<string> =>
    await withBypassContext(
      async () =>
        (
          await db.execute<{ id: string }>(
            sql`
      insert into automation_runs (org_id, automation_id, version, subject_kind, subject_id, status)
      values (${org.orgId}, ${automationId}, 1, ${subjectKind}, ${subjectId}, 'succeeded')
      returning id`,
            "objects",
          )
        )[0]!.id,
    );
  const runA = await mkRun("project", projectA);
  const runB = await mkRun("project", projectB);
  const runBare = await mkRun(null, null);
  return {
    orgId: org.orgId,
    subA: org.subsidiaryId,
    subB,
    automationId,
    runA,
    runB,
    runBare,
    restrictedId,
    adminId,
  };
}

test(
  "a restricted caller reads the in-scope run but not the other subsidiary run",
  { skip: !DB },
  async () => {
    const h = await seed();
    try {
      const lens = new Set([h.subA]);
      const seen = (await getAutomationRun(h.orgId, h.restrictedId, h.runA, lens)) as {
        id: string;
      };
      assert.equal(seen.id, h.runA);
      await assert.rejects(
        getAutomationRun(h.orgId, h.restrictedId, h.runB, lens),
        (error: unknown) =>
          error instanceof AutomationServiceError && /run not found/i.test(error.message),
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(h.orgId));
    }
  },
);

test(
  "a subjectless run is org-wide: invisible to a restricted caller, visible unrestricted",
  { skip: !DB },
  async () => {
    const h = await seed();
    try {
      const lens = new Set([h.subA]);
      await assert.rejects(
        getAutomationRun(h.orgId, h.restrictedId, h.runBare, lens),
        (error: unknown) =>
          error instanceof AutomationServiceError && /run not found/i.test(error.message),
      );
      const seen = (await getAutomationRun(h.orgId, h.adminId, h.runBare, null)) as { id: string };
      assert.equal(seen.id, h.runBare);
    } finally {
      await withBypassContext(() => dropScratchOrg(h.orgId));
    }
  },
);

test(
  "the runs list filters to the caller lens, and omitting the lens resolves the actor",
  { skip: !DB },
  async () => {
    const h = await seed();
    try {
      const lens = new Set([h.subA]);
      const listed = await listAutomationRuns(
        h.orgId,
        h.restrictedId,
        h.automationId,
        undefined,
        lens,
      );
      assert.deepEqual(listed.map((run) => run.id).sort(), [h.runA]);
      // No subjectId in the list contract: the id scopes the read only.
      assert.ok(listed.every((run) => !("subjectId" in run)));
      // Without an explicit lens the service resolves the actor's own grants.
      const resolved = await listAutomationRuns(h.orgId, h.restrictedId, h.automationId);
      assert.deepEqual(resolved.map((run) => run.id).sort(), [h.runA]);
      const all = await listAutomationRuns(h.orgId, h.adminId, h.automationId, undefined, null);
      assert.deepEqual(all.map((run) => run.id).sort(), [h.runA, h.runB, h.runBare].sort());
    } finally {
      await withBypassContext(() => dropScratchOrg(h.orgId));
    }
  },
);

test("leave-request run scope resolves its employer subsidiary", { skip: !DB }, async () => {
  const h = await seed();
  try {
    const employmentId = randomUUID();
    const partyId = randomUUID();
    const leaveTypeId = randomUUID();
    const leaveRequestId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${partyId}, ${h.orgId}, 'person', 'Run Scope Employee', true, '{}'::jsonb)`);
      await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
        values (${employmentId}, ${h.orgId}, ${partyId}, ${h.subA}, 1)`);
      await db.execute(sql`insert into hrm_leave_types (id, org_id, code, name)
        values (${leaveTypeId}, ${h.orgId}, 'VAC', 'Vacation')`);
      await db.execute(sql`insert into hrm_leave_requests (id, org_id, employment_id, leave_type_id, starts_on, ends_on, hours, status)
        values (${leaveRequestId}, ${h.orgId}, ${employmentId}, ${leaveTypeId}, '2026-10-19', '2026-10-19', 8, 'draft')`);
    });
    const scope = await withBypassContext(() =>
      resolveRunSubjectSubsidiaries(h.orgId, [
        { subjectKind: "leave_request", subjectId: leaveRequestId },
      ]),
    );
    assert.equal(scope.get(`leave_request\u0001${leaveRequestId}`), h.subA);
    const snapshot = await withBypassContext(() =>
      loadSubjectSnapshot(h.orgId, "leave_request", leaveRequestId),
    );
    assert.equal(snapshot?.scope?.subsidiaryId, h.subA);
  } finally {
    await withBypassContext(() => dropScratchOrg(h.orgId));
  }
});
