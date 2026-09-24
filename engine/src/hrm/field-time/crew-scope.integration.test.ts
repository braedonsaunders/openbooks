/**
 * H-CREW authorization proofs (DB-owned — gated remotely).
 *
 * - Foreman B cannot edit, submit, or withdraw foreman A's batch: every
 *   denial is batch_unknown, identical to a missing id.
 * - Opening a batch under another foreman's party id without time.manage
 *   is refused as foreman_not_self; a supervisor (canManageAll) may act.
 * - An out-of-scope project refuses as project_unknown, identical to a
 *   missing project — on create and inside every write transaction.
 * - Reads show own batches plus in-scope projects: B's list hides A's
 *   batch, B's detail lookup answers batch_unknown, unrestricted sees all.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction } from "../../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../../testing/fixtures.ts";
import {
  createBatch,
  setBatchLines,
  submitBatch,
  withdrawBatch,
} from "./crew.ts";
import { getBatchDetail, listCrewBatches } from "./reads.ts";
import { FieldTimeError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableCrewEntry(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeCrewEntry": true,
             "fieldTimeEquipment": false}'::jsonb)
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}',
      '{"roundingIncrement": 15, "roundingMode": "nearest", "unpaidBreakMinutes": 30,
        "autoCloseHours": 16, "signatureRequired": false, "equipmentToleranceHours": "1.0000",
        "photoRequired": false}'::jsonb)
     where id = ${orgId}`);
}

function refusesCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => { throw new Error("expected a refusal"); },
    (error) => {
      assert.ok(error instanceof FieldTimeError, `refusal is a FieldTimeError, got ${String(error)}`);
      return (error as FieldTimeError).code;
    },
  );
}

interface CrewWorld {
  orgId: string;
  subA: string;
  subB: string;
  foremanA: string;
  foremanB: string;
  worker: string;
  userA: string;
  userB: string;
  projectA: string;
  projectB: string;
}

async function seedCrewWorld(orgId: string, subA: string): Promise<CrewWorld> {
  const subB = randomUUID();
  const foremanA = randomUUID();
  const foremanB = randomUUID();
  const worker = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subB}, ${orgId}, ${subA}, 'Entity B', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name)
    values (${foremanA}, ${orgId}, 'person', 'Foreman A'),
           (${foremanB}, ${orgId}, 'person', 'Foreman B'),
           (${worker}, ${orgId}, 'person', 'Crew Hand')`);
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
    values (${projectA}, ${orgId}, ${subA}, 'JOB-A', 'Entity A job', 'active', true, '{}'::jsonb),
           (${projectB}, ${orgId}, ${subB}, 'JOB-B', 'Entity B job', 'active', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into schedule_resources (org_id, project_id, name, kind, party_id)
    values (${orgId}, ${projectA}, 'Foreman', 'crew', ${foremanA}),
           (${orgId}, ${projectB}, 'Foreman', 'crew', ${foremanB})`);
  const userA = await createScratchUser(orgId, "Foreman A", "crew_a");
  const userB = await createScratchUser(orgId, "Foreman B", "crew_b");
  await db.execute(sql`update users set party_id = ${foremanA} where org_id = ${orgId} and id = ${userA}`);
  await db.execute(sql`update users set party_id = ${foremanB} where org_id = ${orgId} and id = ${userB}`);
  return { orgId, subA, subB, foremanA, foremanB, worker, userA, userB, projectA, projectB };
}

const linesFor = (worker: string) => [{ employeePartyId: worker, hours: "8.0000" }];

test("foreman B cannot edit, submit, or withdraw foreman A's batch", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCrewEntry(org.orgId);
    const w = await withOrg(org.orgId, () => seedCrewWorld(org.orgId, org.subsidiaryId));
    const scopeA = new Set([w.subA]);
    const batchId = await withOrg(org.orgId, () =>
      createBatch({
        orgId: w.orgId, actorUserId: w.userA, foremanPartyId: w.foremanA,
        projectId: w.projectA, workedOn: "2026-09-14",
        canManageAll: false, allowedSubsidiaryIds: scopeA,
      }));
    await withOrg(org.orgId, async () => {
      // B holds crew entry on their own project but learns nothing here:
      // every denial matches the missing-id refusal exactly.
      const missing = randomUUID();
      assert.equal(
        await refusesCode(() => setBatchLines({
          orgId: w.orgId, actorUserId: w.userB, batchId, lines: linesFor(w.worker),
          canManageAll: false, allowedSubsidiaryIds: scopeA,
        })),
        await refusesCode(() => setBatchLines({
          orgId: w.orgId, actorUserId: w.userB, batchId: missing, lines: linesFor(w.worker),
          canManageAll: false, allowedSubsidiaryIds: scopeA,
        })),
      );
      assert.equal(
        await refusesCode(() => submitBatch({
          orgId: w.orgId, actorUserId: w.userB, batchId, canManageAll: false, allowedSubsidiaryIds: scopeA,
        })),
        "batch_unknown",
      );
      // A works their own batch end to end.
      await setBatchLines({
        orgId: w.orgId, actorUserId: w.userA, batchId, lines: linesFor(w.worker),
        canManageAll: false, allowedSubsidiaryIds: scopeA,
      });
      await submitBatch({
        orgId: w.orgId, actorUserId: w.userA, batchId, canManageAll: false, allowedSubsidiaryIds: scopeA,
      });
      assert.equal(
        await refusesCode(() => withdrawBatch({
          orgId: w.orgId, actorUserId: w.userB, batchId, canManageAll: false, allowedSubsidiaryIds: scopeA,
        })),
        "batch_unknown",
      );
      await withdrawBatch({
        orgId: w.orgId, actorUserId: w.userA, batchId, canManageAll: false, allowedSubsidiaryIds: scopeA,
      });
      const status = (await db.execute<{ status: string }>(sql`
        select status from crew_time_batches where id = ${batchId}`)).rows[0]?.status;
      assert.equal(status, "draft");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("opening a batch under another foreman's identity is refused without time.manage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCrewEntry(org.orgId);
    const w = await withOrg(org.orgId, () => seedCrewWorld(org.orgId, org.subsidiaryId));
    await withOrg(org.orgId, async () => {
      assert.equal(
        await refusesCode(() => createBatch({
          orgId: w.orgId, actorUserId: w.userB, foremanPartyId: w.foremanA,
          projectId: w.projectA, workedOn: "2026-09-14",
          canManageAll: false, allowedSubsidiaryIds: new Set([w.subA, w.subB]),
        })),
        "foreman_not_self",
      );
      // A supervisor acting for the foreman may still open it.
      const batchId = await createBatch({
        orgId: w.orgId, actorUserId: w.userB, foremanPartyId: w.foremanA,
        projectId: w.projectA, workedOn: "2026-09-14",
        canManageAll: true, allowedSubsidiaryIds: null,
      });
      assert.ok(batchId);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("batch creation waits for the foreman assignment to remain valid", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let releaseRemoval!: () => void;
  let assignmentLocked!: () => void;
  const holdRemoval = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  const locked = new Promise<void>((resolve) => { assignmentLocked = resolve; });
  let remover: Promise<void> | undefined;
  try {
    await enableCrewEntry(org.orgId);
    const w = await withOrg(org.orgId, () => seedCrewWorld(org.orgId, org.subsidiaryId));
    remover = withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`
        select id from schedule_resources
         where org_id = ${org.orgId} and project_id = ${w.projectA} and party_id = ${w.foremanA}
         for update`);
      assignmentLocked();
      await holdRemoval;
      await db.execute(sql`
        delete from schedule_resources
         where org_id = ${org.orgId} and project_id = ${w.projectA} and party_id = ${w.foremanA}`);
    });
    await locked;

    let finished = false;
    const creation = withOrg(org.orgId, () => createBatch({
      orgId: org.orgId,
      actorUserId: w.userA,
      foremanPartyId: w.foremanA,
      projectId: w.projectA,
      workedOn: "2026-09-14",
      canManageAll: false,
      allowedSubsidiaryIds: new Set([w.subA]),
    })).then((value) => ({ value }), (error: unknown) => ({ error })).finally(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(finished, false, "creation waits for the locked assignment row");

    releaseRemoval();
    await remover;
    const outcome = await creation;
    assert.ok("error" in outcome, "a removed foreman assignment prevents batch creation");
    assert.ok(outcome.error instanceof FieldTimeError);
    assert.equal(outcome.error.code, "foreman_not_on_project");
    const batches = await withOrg(org.orgId, async () => (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from crew_time_batches
       where org_id = ${org.orgId} and project_id = ${w.projectA} and foreman_party_id = ${w.foremanA}`)).rows[0]?.n);
    assert.equal(batches, "0");
  } finally {
    releaseRemoval();
    await remover;
    await dropScratchOrg(org.orgId);
  }
});

test("out-of-scope and missing projects refuse identically", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCrewEntry(org.orgId);
    const w = await withOrg(org.orgId, () => seedCrewWorld(org.orgId, org.subsidiaryId));
    await withOrg(org.orgId, async () => {
      const outOfScope = await refusesCode(() => createBatch({
        orgId: w.orgId, actorUserId: w.userA, foremanPartyId: w.foremanA,
        projectId: w.projectB, workedOn: "2026-09-14",
        canManageAll: false, allowedSubsidiaryIds: new Set([w.subA]),
      }));
      const missing = await refusesCode(() => createBatch({
        orgId: w.orgId, actorUserId: w.userA, foremanPartyId: w.foremanA,
        projectId: randomUUID(), workedOn: "2026-09-14",
        canManageAll: false, allowedSubsidiaryIds: new Set([w.subA]),
      }));
      assert.equal(outOfScope, "project_unknown");
      assert.equal(outOfScope, missing);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("reads show own batches plus in-scope projects only", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCrewEntry(org.orgId);
    const w = await withOrg(org.orgId, () => seedCrewWorld(org.orgId, org.subsidiaryId));
    const batchA = await withOrg(org.orgId, () =>
      createBatch({
        orgId: w.orgId, actorUserId: w.userA, foremanPartyId: w.foremanA,
        projectId: w.projectA, workedOn: "2026-09-14",
        canManageAll: false, allowedSubsidiaryIds: new Set([w.subA]),
      }));
    await withOrg(org.orgId, async () => {
      const actorA = { actorUserId: w.userA, allowedSubsidiaryIds: new Set<string>([w.subA]) };
      const actorB = { actorUserId: w.userB, allowedSubsidiaryIds: new Set<string>([w.subB]) };
      const seenByA = await listCrewBatches(w.orgId, {}, actorA);
      assert.ok(seenByA.some((b) => b.id === batchA), "foreman A lists their own batch");
      const seenByB = await listCrewBatches(w.orgId, {}, actorB);
      assert.ok(!seenByB.some((b) => b.id === batchA), "foreman B cannot enumerate A's batch");
      assert.equal(
        await refusesCode(() => getBatchDetail(w.orgId, actorB, batchA)),
        "batch_unknown",
      );
      const detail = await getBatchDetail(w.orgId, actorA, batchA);
      assert.equal(detail.id, batchA);
      const seenByUnrestricted = await listCrewBatches(
        w.orgId, {}, { actorUserId: w.userA, allowedSubsidiaryIds: null },
      );
      assert.ok(seenByUnrestricted.some((b) => b.id === batchA));
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
