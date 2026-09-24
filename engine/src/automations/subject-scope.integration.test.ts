import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { createAutomation } from "./services.ts";
import { executeAutomation, AutomationExecuteError } from "./execute.ts";
import { simulateAutomation } from "./simulator.ts";

/**
 * H-AUTOMATION subject-scope proofs (DB-owned — gated remotely).
 *
 * A subsidiary-A caller must neither run an automation against a
 * subsidiary-B employment nor simulate it to learn match and step
 * outcomes: an out-of-scope subject answers exactly like a deleted one
 * (the same gone-refusal live, the same subject-less steps in simulate),
 * and entity sampling never enumerates out-of-scope subjects.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function seedEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const workerPartyId = randomUUID();
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Automation Worker', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2026-01-01', now())
  `);
  return employmentId;
}

async function seedRecipe(orgId: string, actorId: string): Promise<string> {
  const recipe = await createAutomation({
    orgId,
    actorId,
    name: "subject scope probe",
    trigger: { kind: "manual" },
    rules: {},
    conditions: {},
    actions: [{ kind: "send_notification", to: "initiator", body: "fired" }],
  });
  await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
  return recipe.id;
}

async function setupWorld(): Promise<{
  orgId: string;
  subA: string;
  subB: string;
  actorId: string;
  employmentA: string;
  employmentB: string;
  recipeId: string;
}> {
  const org = await createScratchOrg();
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"automations": true}'::jsonb)
     where id = ${org.orgId}`);
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  const actorId = await createScratchUser(org.orgId, "Automation Runner", "auto_runner");
  await grant(org.orgId, actorId, ["automations.manage", "automations.run", "automations.read"]);
  const employmentA = await seedEmployment(org.orgId, org.subsidiaryId);
  const employmentB = await seedEmployment(org.orgId, subB);
  const recipeId = await seedRecipe(org.orgId, actorId);
  return { orgId: org.orgId, subA: org.subsidiaryId, subB, actorId, employmentA, employmentB, recipeId };
}

async function goneMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof AutomationExecuteError, `expected AutomationExecuteError, got ${String(error)}`);
    return (error as Error).message;
  }
  throw new Error("expected the gone-refusal");
}

test("live runs against an out-of-scope employment refuse exactly like a deleted subject", { skip: !DB }, async () => {
  const w = await withBypassContext(() => setupWorld());
  try {
    const scopeA = new Set([w.subA]);
    const outOfScope = await goneMessage(() => executeAutomation({
      orgId: w.orgId, actorId: w.actorId, automationId: w.recipeId,
      subjectEntity: "employment", subjectId: w.employmentB,
      triggerPayload: { kind: "manual" }, allowedSubsidiaryIds: scopeA,
    }));
    const missing = await goneMessage(() => executeAutomation({
      orgId: w.orgId, actorId: w.actorId, automationId: w.recipeId,
      subjectEntity: "employment", subjectId: randomUUID(),
      triggerPayload: { kind: "manual" }, allowedSubsidiaryIds: scopeA,
    }));
    assert.equal(outOfScope, missing);
    // The in-scope employment runs.
    const run = await executeAutomation({
      orgId: w.orgId, actorId: w.actorId, automationId: w.recipeId,
      subjectEntity: "employment", subjectId: w.employmentA,
      triggerPayload: { kind: "manual" }, allowedSubsidiaryIds: scopeA,
    });
    assert.equal(run.status, "succeeded");
  } finally {
    await withBypassContext(() => dropScratchOrg(w.orgId));
  }
});

test("explicit-subject simulations match a deleted subject step for step", { skip: !DB }, async () => {
  const w = await withBypassContext(() => setupWorld());
  try {
    const scopeA = new Set([w.subA]);
    const base = {
      orgId: w.orgId, actorId: w.actorId, automationId: w.recipeId,
      subjectEntity: "employment", allowedSubsidiaryIds: scopeA,
    };
    const outOfScope = await simulateAutomation({ ...base, subjectId: w.employmentB });
    const missing = await simulateAutomation({ ...base, subjectId: randomUUID() });
    // The envelope echoes the requested id; the uniform part is the
    // outcome: same status, same subject-less steps.
    assert.equal(outOfScope.length, 1);
    assert.equal(missing.length, 1);
    assert.equal(outOfScope[0]!.status, missing[0]!.status);
    assert.deepEqual(outOfScope[0]!.steps, missing[0]!.steps);
  } finally {
    await withBypassContext(() => dropScratchOrg(w.orgId));
  }
});

test("entity sampling never enumerates out-of-scope subjects", { skip: !DB }, async () => {
  const w = await withBypassContext(() => setupWorld());
  try {
    const sampled = await simulateAutomation({
      orgId: w.orgId, actorId: w.actorId, automationId: w.recipeId,
      subjectEntity: "employment", sampleSize: 10, allowedSubsidiaryIds: new Set([w.subA]),
    });
    const ids = sampled.map((s) => s.subjectId);
    assert.ok(ids.includes(w.employmentA), "in-scope employment is sampled");
    assert.ok(!ids.includes(w.employmentB), "out-of-scope employment is never sampled");
  } finally {
    await withBypassContext(() => dropScratchOrg(w.orgId));
  }
});
