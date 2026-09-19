import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  EmploymentReadError,
  listEmploymentOptions,
  listLocationOptions,
} from "./employment-read.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

// DB-backed proof for the authoring pickers (Slice F send-back): the
// employment options list holders with person · employer · job-title labels
// under the aggregate read authority, and the location options list active
// native locations with subsidiary scope. Runs against the reviewer's own
// database; never touches shared fixtures.

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function grantRead(orgId: string, roleKey: string): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = '["hrm.employment.read"]'::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function restrictRole(orgId: string, roleKey: string, subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function mkParty(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name)
    values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkPrimaryAssignment(orgId: string, employmentId: string, jobTitle: string): Promise<void> {
  const slot = (await db.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key)
    values (${orgId}, ${employmentId}, 'primary') returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, fte, is_primary,
       effective_from, recorded_at)
    values (${orgId}, ${slot}, ${employmentId}, 1, ${jobTitle}, '1.0000', true,
      '2026-01-01'::date, '2026-01-01T00:00:00.000001Z'::timestamptz)`);
}

async function seedChildSubsidiary(orgId: string, rootId: string): Promise<string> {
  const childId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${childId}, ${orgId}, ${rootId}, 'Child entity', base_currency, country
      from subsidiaries where id = ${rootId} and org_id = ${orgId}`);
  return childId;
}

async function mkLocation(
  orgId: string,
  name: string,
  code: string | null,
  subsidiaryId: string | null,
  isActive: boolean,
): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into locations (org_id, name, code, subsidiary_id, is_active)
    values (${orgId}, ${name}, ${code}, ${subsidiaryId}, ${isActive}) returning id`)).rows[0]!.id;
}

test("employment options name the person, employer, and live primary job", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const alice = await mkParty(org.orgId, "Alice Holder");
    const aliceEmployment = await mkEmployment(org.orgId, alice, org.subsidiaryId);
    await mkPrimaryAssignment(org.orgId, aliceEmployment, "Cashier");
    const bob = await mkParty(org.orgId, "Bob Reserved");
    const bobEmployment = await mkEmployment(org.orgId, bob, org.subsidiaryId);

    const options = await listEmploymentOptions({ orgId: org.orgId, actorId: actor });
    assert.equal(options.length, 2);
    const aliceOption = options.find((option) => option.employmentId === aliceEmployment);
    assert.ok(aliceOption);
    assert.match(aliceOption.label, /Alice Holder/);
    assert.match(aliceOption.label, /Cashier/);
    const bobOption = options.find((option) => option.employmentId === bobEmployment);
    assert.ok(bobOption);
    assert.match(bobOption.label, /Bob Reserved/);
    assert.ok(!bobOption.label.includes("Cashier"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("employment options filter by name and refuse unbounded pages", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const alice = await mkParty(org.orgId, "Alice Holder");
    await mkEmployment(org.orgId, alice, org.subsidiaryId);
    const plain = await mkParty(org.orgId, "Q_ueen Literal");
    await mkEmployment(org.orgId, plain, org.subsidiaryId);

    const ali = await listEmploymentOptions({ orgId: org.orgId, actorId: actor, q: "ali" });
    assert.equal(ali.length, 1);
    assert.match(ali[0]!.label, /Alice Holder/);
    // LIKE metacharacters match literally: % never wildcards the underscore.
    const pct = await listEmploymentOptions({ orgId: org.orgId, actorId: actor, q: "Q%ueen" });
    assert.equal(pct.length, 0);
    const exact = await listEmploymentOptions({ orgId: org.orgId, actorId: actor, q: "Q_ueen" });
    assert.equal(exact.length, 1);

    const one = await listEmploymentOptions({ orgId: org.orgId, actorId: actor, limit: 1 });
    assert.equal(one.length, 1);
    await assert.rejects(
      listEmploymentOptions({ orgId: org.orgId, actorId: actor, limit: 0 }),
      EmploymentReadError,
    );
    await assert.rejects(
      listEmploymentOptions({ orgId: org.orgId, actorId: actor, limit: 101 }),
      EmploymentReadError,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("employment options enforce the gate, the grant, and the scope", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    const gated = await createScratchUser(org.orgId, "HRM gated", "hrm_gated");
    await grantRead(org.orgId, "hrm_gated");
    const denied = await createScratchUser(org.orgId, "HRM denied", "hrm_denied");
    const party = await mkParty(org.orgId, "Scoped worker");
    const inScope = await mkEmployment(org.orgId, party, org.subsidiaryId);
    const childId = await seedChildSubsidiary(org.orgId, org.subsidiaryId);
    const otherParty = await mkParty(org.orgId, "Other worker");
    const outOfScope = await mkEmployment(org.orgId, otherParty, childId);

    // Feature off refuses by name before any row is read.
    await assert.rejects(
      listEmploymentOptions({ orgId: org.orgId, actorId: gated }),
      EmploymentReadError,
    );
    await enableHrm(org.orgId);
    // No grant refuses through the authorization gate.
    await assert.rejects(
      listEmploymentOptions({ orgId: org.orgId, actorId: denied }),
      HrmAuthorizationError,
    );
    await restrictRole(org.orgId, "hrm_reader", [org.subsidiaryId]);
    const scoped = await listEmploymentOptions({ orgId: org.orgId, actorId: actor });
    assert.deepEqual(
      scoped.map((option) => option.employmentId),
      [inScope],
    );
    // The pinned draft value leads the page without leaking strangers.
    const pinned = await listEmploymentOptions({
      orgId: org.orgId,
      actorId: actor,
      limit: 1,
      includeEmploymentId: inScope,
    });
    assert.equal(pinned[0]?.employmentId, inScope);
    const unknown = await listEmploymentOptions({
      orgId: org.orgId,
      actorId: actor,
      includeEmploymentId: outOfScope,
    });
    assert.ok(unknown.every((option) => option.employmentId !== outOfScope));
    assert.ok(unknown.every((option) => option.employmentId !== randomUUID()));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("location options list active native locations inside the scope", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const childId = await seedChildSubsidiary(org.orgId, org.subsidiaryId);
    const hq = await mkLocation(org.orgId, "Headquarters", "HQ", null, true);
    const shop = await mkLocation(org.orgId, "Shop floor", null, org.subsidiaryId, true);
    const remote = await mkLocation(org.orgId, "Far site", "FAR", childId, true);
    await mkLocation(org.orgId, "Closed depot", "SHUT", null, false);

    await restrictRole(org.orgId, "hrm_reader", [org.subsidiaryId]);
    const options = await listLocationOptions({ orgId: org.orgId, actorId: actor });
    const ids = options.map((option) => option.locationId);
    assert.ok(ids.includes(hq), "org-wide locations stay visible");
    assert.ok(ids.includes(shop), "in-scope locations list");
    assert.ok(!ids.includes(remote), "out-of-scope locations never list");
    assert.ok(
      options.every((option) => !option.label.includes("Closed depot")),
      "inactive locations never list",
    );
    const hqOption = options.find((option) => option.locationId === hq);
    assert.equal(hqOption?.label, "HQ · Headquarters");

    const filtered = await listLocationOptions({ orgId: org.orgId, actorId: actor, q: "shop" });
    assert.deepEqual(filtered.map((option) => option.locationId), [shop]);

    const pinned = await listLocationOptions({
      orgId: org.orgId,
      actorId: actor,
      limit: 1,
      includeLocationId: shop,
    });
    assert.equal(pinned[0]?.locationId, shop);

    await assert.rejects(
      listLocationOptions({ orgId: org.orgId, actorId: actor, limit: 500 }),
      EmploymentReadError,
    );
    const stranger = await createScratchUser(org.orgId, "HRM stranger", "hrm_stranger");
    await assert.rejects(
      listLocationOptions({ orgId: org.orgId, actorId: stranger }),
      HrmAuthorizationError,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
