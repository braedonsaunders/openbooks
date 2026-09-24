import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import { HrmQualificationError } from "./errors.ts";
import {
  listQualificationEvents,
  listQualifications,
  loadQualification,
  recordQualification,
  revokeQualification,
  verifyQualification,
} from "./qualifications.ts";
import { createQualificationType, declareCategory } from "./types.ts";

/**
 * Qualifications hang off employments, so every HR read and mutation
 * scopes by the employee's employer subsidiary. A certifications holder
 * restricted to one subsidiary must not list, open, verify, renew,
 * revoke, or record another subsidiary's rows — each refusal answers
 * exactly like the row (or employment) was never there, and writes
 * nothing. Self/team audiences keep their structural scope, unchanged.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = ["hrm", "hrmCertifications"];

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'`);
  }
}

async function restrictRole(orgId: string, roleKey: string, subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function mkEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Worker ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)`);
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function fixture() {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  const adminId = await createScratchUser(org.orgId, "Qual Admin", "qualscope_admin");
  await grant(org.orgId, adminId, ["hrm.certifications.read", "hrm.certifications.manage"]);
  const hrId = await createScratchUser(org.orgId, "Qual HR", "qualscope_hr");
  await grant(org.orgId, hrId, ["hrm.certifications.read", "hrm.certifications.manage"]);
  await restrictRole(org.orgId, "qualscope_hr", [org.subsidiaryId]);
  const branchId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Division B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  const empA = await mkEmployment(org.orgId, org.subsidiaryId);
  const empB = await mkEmployment(org.orgId, branchId);
  await declareCategory(db, { orgId: org.orgId, actorId: adminId, category: "scope-ticket" });
  const type = await createQualificationType(db, {
    orgId: org.orgId, actorId: adminId,
    code: `ScopeTicket-${randomUUID().slice(0, 8)}`, name: "Scope ticket", category: "scope-ticket",
  });
  const qualA = await recordQualification(db, {
    orgId: org.orgId, actorId: adminId, employmentId: empA, typeId: type.id, issuedOn: "2026-01-05",
  });
  const qualB1 = await recordQualification(db, {
    orgId: org.orgId, actorId: adminId, employmentId: empB, typeId: type.id, issuedOn: "2026-01-06",
  });
  const qualB2 = await recordQualification(db, {
    orgId: org.orgId, actorId: adminId, employmentId: empB, typeId: type.id, issuedOn: "2026-01-07",
  });
  return { org, adminId, hrId, branchId, empA, empB, typeId: type.id, qualA, qualB1, qualB2 };
}

async function ledgerCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from hrm_worker_qualifications where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.n ?? 0);
}

async function assertNotFound(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HrmQualificationError, `${label}: refusal must stay an HrmQualificationError`);
    assert.match(error.message, /not found in this organization/, `${label}: refusal must read as uniform not-found`);
    return true;
  }, label);
}

test("HR list hides another subsidiary's qualifications", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const rows = await listQualifications(db, { orgId: f.org.orgId, actorId: f.hrId });
    assert.deepEqual(rows.map((r) => r.id), [f.qualA.id], "only the caller's own entity is enumerated");
    const named = await listQualifications(db, {
      orgId: f.org.orgId, actorId: f.hrId, employmentId: f.empB,
    });
    assert.deepEqual(named, [], "a named out-of-scope employment answers as if it held nothing");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("HR row reads refuse another subsidiary's row as not-found", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    assert.equal(
      await loadQualification(db, { orgId: f.org.orgId, actorId: f.hrId, qualificationId: f.qualB1.id }),
      null,
      "an out-of-scope row reads as null, exactly like a missing one",
    );
    await assertNotFound(
      listQualificationEvents(db, { orgId: f.org.orgId, actorId: f.hrId, qualificationId: f.qualB1.id }),
      "events on another subsidiary's row",
    );
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("HR mutations refuse another subsidiary's employment", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const before = await ledgerCount(f.org.orgId);
    await assertNotFound(
      recordQualification(db, {
        orgId: f.org.orgId, actorId: f.hrId, employmentId: f.empB, typeId: f.typeId, issuedOn: "2026-02-02",
      }),
      "record on another subsidiary's employment",
    );
    await assertNotFound(
      verifyQualification(db, {
        orgId: f.org.orgId, actorId: f.hrId, qualificationId: f.qualB1.id, reason: "saw the certificate",
      }),
      "verify on another subsidiary's row",
    );
    await assertNotFound(
      revokeQualification(db, {
        orgId: f.org.orgId, actorId: f.hrId, qualificationId: f.qualB2.id, reason: "scope probe",
      }),
      "revoke on another subsidiary's row",
    );
    assert.equal(await ledgerCount(f.org.orgId), before, "refused mutations write nothing");
    const reread = await loadQualification(db, {
      orgId: f.org.orgId, actorId: f.adminId, qualificationId: f.qualB1.id,
    });
    assert.equal(reread?.storedStatus, "pending_verification", "a refused verify changes no status");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

test("an unrestricted holder keeps the full surface", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const rows = await listQualifications(db, { orgId: f.org.orgId, actorId: f.adminId });
    assert.equal(rows.length, 3);
    const verified = await verifyQualification(db, {
      orgId: f.org.orgId, actorId: f.adminId, qualificationId: f.qualB1.id, reason: "certificate on file",
    });
    assert.equal(verified.storedStatus, "valid");
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});
