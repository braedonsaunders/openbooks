import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import {
  cancelCycle,
  closeCycle,
  createCycle,
  proposeLine,
  submitCycleForApproval,
} from "./cycles.ts";

/**
 * H-COMPCYCLE regression: merit-cycle writes checked hrm.compensation.manage
 * only. loadCycleForUpdate loaded by org/id with no subsidiary lens, so an
 * A-scoped manager submitted, pushed, or closed B's merit cycle — pushing
 * B's WAGES — while getCycle/listCycleLines hid B. Creation accepted an
 * arbitrary employer_subsidiary_id.
 *
 * Creation now validates the declared anchor inside the write transaction
 * (B-anchored refuses uniformly not-visible, org-wide needs unrestricted
 * scope), and every move rechecks the cycle's anchor plus every line's
 * employer under the cycle lock before acting. Proofs run the service:
 * out-of-scope moves refuse as NOT_FOUND identical to fabricated ids,
 * while in-scope moves proceed to their next gate (the Flows refusal, a
 * stored proposal, a closed round).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

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

async function seedEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const party = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${party}, ${orgId}, 'person', 'Cycle Worker', true, '{}'::jsonb)`);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${party}, ${subsidiaryId}, 1)`);
  return employmentId;
}

const CYCLE_BASE = {
  kind: "merit" as const,
  effectiveOn: "2026-04-01",
  currency: "CAD",
  guidelineKind: "matrix" as const,
  guideline: {},
};

async function seedLine(
  orgId: string,
  cycleId: string,
  employmentId: string,
  status: string,
): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    insert into hrm_comp_cycle_lines
      (org_id, cycle_id, employment_id, current_rate, currency, basis, status,
       approver_party_id, decided_at)
    select ${orgId}, ${cycleId}, e.id, '90000.0000', 'CAD', 'annual', ${status},
           case when ${status} in ('approved', 'rejected') then e.worker_party_id else null end,
           case when ${status} in ('approved', 'rejected') then now() else null end
      from worker_employments e where e.org_id = ${orgId} and e.id = ${employmentId}
    returning id
  `)).rows;
  return rows[0]!.id;
}

async function refusalOf(promise: Promise<unknown>): Promise<{ name: string; code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { name: (e as Error).constructor.name, code: typeof code === "string" ? code : "", message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("H-COMPCYCLE: creation validates the declared employer anchor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = await createScratchUser(org.orgId, "Cycle Admin", "cyclec_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.compensation.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const managerA = await createScratchUser(org.orgId, "Cycle Manager A", "cyclec_mgr_a");
    await scopeRole(org.orgId, "cyclec_mgr_a", ["hrm.compensation.manage"], [org.subsidiaryId]);
    const attempt = (employerSubsidiaryId: string | null, name: string) =>
      createCycle({
        orgId: org.orgId, actorId: managerA, name, ...CYCLE_BASE,
        scope: { employerSubsidiaryId, departmentId: null },
      });

    // A B-anchored round refuses exactly like a fabricated subsidiary.
    const foreign = await refusalOf(attempt(subB, "B round"));
    const fabricated = await refusalOf(attempt(randomUUID(), "Fabricated round"));
    assert.deepEqual(foreign, fabricated);
    assert.match(foreign.message, /not visible in this organization and legal-entity scope/);

    // An org-wide round prices every entity at once: named org-wide remedy.
    const orgWide = await refusalOf(attempt(null, "Org round"));
    assert.equal(orgWide.name, "HrmAuthorizationError");
    assert.match(orgWide.message, /across legal entities/);

    // The in-scope anchor still stores.
    const stored = await attempt(org.subsidiaryId, "A round");
    assert.ok(stored.id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-COMPCYCLE: submit, propose, and close recheck scope under the lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = await createScratchUser(org.orgId, "Cycle Admin", "cyclew_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.compensation.manage", "hrm.compensation.approve"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedEmployment(org.orgId, org.subsidiaryId);
    const empB = await seedEmployment(org.orgId, subB);
    const managerA = await createScratchUser(org.orgId, "Cycle Manager A", "cyclew_mgr_a");
    await scopeRole(
      org.orgId, "cyclew_mgr_a",
      ["hrm.compensation.manage", "hrm.compensation.approve"], [org.subsidiaryId],
    );

    // A B-anchored draft cancels for nobody scoped to A — exactly like a
    // fabricated cycle id.
    const bCycle = await createCycle({
      orgId: org.orgId, actorId: adminId, name: "B round", ...CYCLE_BASE,
      scope: { employerSubsidiaryId: subB, departmentId: null },
    });
    const cancelHidden = await refusalOf(
      cancelCycle({ orgId: org.orgId, actorId: managerA, cycleId: bCycle.id, reason: "probe" }),
    );
    const cancelMissing = await refusalOf(
      cancelCycle({ orgId: org.orgId, actorId: managerA, cycleId: randomUUID(), reason: "probe" }),
    );
    assert.deepEqual(cancelHidden, cancelMissing);
    assert.equal(cancelHidden.code, "NOT_FOUND");

    // An A-anchored OPEN round carrying a B line: submit refuses for the
    // A-scoped actor, while the unrestricted admin passes the scope gate
    // and reaches the Flows refusal (no flow configured) instead.
    const mixed = await createCycle({
      orgId: org.orgId, actorId: adminId, name: "Mixed round", ...CYCLE_BASE,
      scope: { employerSubsidiaryId: org.subsidiaryId, departmentId: null },
    });
    await db.execute(sql`
      update hrm_comp_cycles set status = 'open' where org_id = ${org.orgId} and id = ${mixed.id}`);
    await seedLine(org.orgId, mixed.id, empA, "approved");
    await seedLine(org.orgId, mixed.id, empB, "approved");
    const submitHidden = await refusalOf(
      submitCycleForApproval({ orgId: org.orgId, actorId: managerA, cycleId: mixed.id }),
    );
    assert.equal(submitHidden.code, "NOT_FOUND");
    assert.match(submitHidden.message, /not visible in this organization/);
    const submitAdmin = await refusalOf(
      submitCycleForApproval({ orgId: org.orgId, actorId: adminId, cycleId: mixed.id }),
    );
    assert.match(submitAdmin.message, /approval flow/, "unrestricted passes scope, reaches Flows");

    // Proposing B's line refuses as a missing line; proposing A's line
    // stores through the service.
    const proposalCycle = await createCycle({
      orgId: org.orgId, actorId: adminId, name: "Proposal round", ...CYCLE_BASE,
      scope: { employerSubsidiaryId: org.subsidiaryId, departmentId: null },
    });
    await db.execute(sql`
      update hrm_comp_cycles set status = 'open' where org_id = ${org.orgId} and id = ${proposalCycle.id}`);
    const pendingB = await seedLine(org.orgId, proposalCycle.id, empB, "pending");
    const proposeHidden = await refusalOf(
      proposeLine({ orgId: org.orgId, actorId: managerA, lineId: pendingB, proposedRate: "95000.0000", reason: "probe" }),
    );
    const proposeMissing = await refusalOf(
      proposeLine({ orgId: org.orgId, actorId: managerA, lineId: randomUUID(), proposedRate: "95000.0000", reason: "probe" }),
    );
    assert.deepEqual(proposeHidden, proposeMissing);
    assert.equal(proposeHidden.code, "NOT_FOUND");
    const pendingA = await seedLine(org.orgId, proposalCycle.id, empA, "pending");
    const stored = await proposeLine({
      orgId: org.orgId, actorId: managerA, lineId: pendingA, proposedRate: "95000.0000", reason: "merit",
    });
    assert.equal(stored.status, "proposed");
    assert.equal(stored.proposedRate, "95000.0000");

    // Closing B's round refuses like a fabricated cycle id. An A-only
    // pushed round still closes for the restricted actor.
    const pushedB = await createCycle({
      orgId: org.orgId, actorId: adminId, name: "Pushed round", ...CYCLE_BASE,
      scope: { employerSubsidiaryId: subB, departmentId: null },
    });
    await db.execute(sql`
      update hrm_comp_cycles set status = 'pushed' where org_id = ${org.orgId} and id = ${pushedB.id}`);
    const closeHidden = await refusalOf(closeCycle({ orgId: org.orgId, actorId: managerA, cycleId: pushedB.id }));
    const closeMissing = await refusalOf(closeCycle({ orgId: org.orgId, actorId: managerA, cycleId: randomUUID() }));
    assert.deepEqual(closeHidden, closeMissing);
    assert.equal(closeHidden.code, "NOT_FOUND");
    const pushedA = await createCycle({
      orgId: org.orgId, actorId: adminId, name: "Pushed A round", ...CYCLE_BASE,
      scope: { employerSubsidiaryId: org.subsidiaryId, departmentId: null },
    });
    await db.execute(sql`
      update hrm_comp_cycles set status = 'pushed' where org_id = ${org.orgId} and id = ${pushedA.id}`);
    assert.equal(
      (await closeCycle({ orgId: org.orgId, actorId: managerA, cycleId: pushedA.id })).status, "closed",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-COMPCYCLE: a line proposal waits for the employment scope lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let releaseHolder!: () => void;
  let employmentLocked!: () => void;
  let holder: Promise<void> | undefined;
  const hold = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const locked = new Promise<void>((resolve) => { employmentLocked = resolve; });
  try {
    const adminId = await createScratchUser(org.orgId, "Cycle Lock Admin", "cyclelock_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.compensation.manage"]);
    const managerId = await createScratchUser(org.orgId, "Cycle Lock Manager", "cyclelock_manager");
    await scopeRole(org.orgId, "cyclelock_manager", ["hrm.compensation.manage"], [org.subsidiaryId]);
    const employmentId = await seedEmployment(org.orgId, org.subsidiaryId);
    const cycle = await createCycle({
      orgId: org.orgId, actorId: adminId, name: "Locked proposal", ...CYCLE_BASE,
      scope: { employerSubsidiaryId: org.subsidiaryId, departmentId: null },
    });
    await db.execute(sql`update hrm_comp_cycles set status = 'open' where org_id = ${org.orgId} and id = ${cycle.id}`);
    const lineId = await seedLine(org.orgId, cycle.id, employmentId, "pending");
    holder = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`
        select id from worker_employments
         where org_id = ${org.orgId} and id = ${employmentId}
         for update`);
      employmentLocked();
      await hold;
    });
    await locked;
    let finished = false;
    const proposal = proposeLine({
      orgId: org.orgId, actorId: managerId, lineId, proposedRate: "95000.0000", reason: "scope lock probe",
    }).finally(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(finished, false, "the proposal must wait for the locked employment before checking its legal entity");
    releaseHolder();
    await holder;
    assert.equal((await proposal).status, "proposed");
  } finally {
    releaseHolder();
    if (holder) await holder;
    await dropScratchOrg(org.orgId);
  }
});
