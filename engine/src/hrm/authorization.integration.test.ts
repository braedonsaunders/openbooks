import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  HrmAuthorizationError,
  loadActorPerson,
  requireHrmEmploymentApprove,
  requireHrmEmploymentManage,
  requireHrmEmploymentRead,
} from "./authorization.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

// DB-backed proof that HRM gates follow actorIdentity's home-org bypass:
// a nonexistent actor id is refused, and a platform super-admin whose
// users row is not in the subject org is still allowed. The unit fake
// cannot prove either — planting a local row hides a local-only precheck
// regression, and omitting one falls through to the process database.

async function seedTargetEmployment(orgId: string, subsidiaryId: string, label: string): Promise<string> {
  const partyId = (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name)
    values (${orgId}, 'person', ${label})
    returning id
  `)).rows[0]!.id;
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId})
    returning id
  `)).rows[0]!.id;
}

test("nonexistent actor id is refused against a real organization", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const employmentId = await seedTargetEmployment(org.orgId, org.subsidiaryId, "Missing-actor worker");
    const missing = randomUUID();
    // Employment exists. Fail-open would return that subject instead of refusing.
    await assert.rejects(
      requireHrmEmploymentRead(db, org.orgId, missing, employmentId),
      /identity behind this action is not established/,
    );
    await assert.rejects(
      requireHrmEmploymentManage(db, org.orgId, missing, employmentId),
      /identity behind this action is not established/,
    );
    await assert.rejects(
      requireHrmEmploymentApprove(db, org.orgId, missing, employmentId),
      /identity behind this action is not established/,
    );
    await assert.rejects(
      loadActorPerson(db, org.orgId, missing),
      /identity behind this action is not established/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("home-org platform super-admin can read employment in another organization", { skip }, async () => {
  const home = await createScratchOrg();
  const target = await createScratchOrg();
  try {
    const admin = await createScratchUser(home.orgId, "Platform administrator", "admin");
    await db.execute(sql`update users set is_super_admin=true where id=${admin}`);
    const clerk = await createScratchUser(home.orgId, "Home clerk", "clerk");
    const employmentId = await seedTargetEmployment(target.orgId, target.subsidiaryId, "Target worker");
    // No target-org users row for admin. A local-only precheck refuses this.
    const subject = await requireHrmEmploymentRead(db, target.orgId, admin, employmentId);
    assert.equal(subject.id, employmentId);
    assert.equal(subject.orgId, target.orgId);
    await assert.rejects(
      requireHrmEmploymentRead(db, target.orgId, clerk, employmentId),
      HrmAuthorizationError,
    );
  } finally {
    await dropScratchOrg(target.orgId);
    await dropScratchOrg(home.orgId);
  }
});
