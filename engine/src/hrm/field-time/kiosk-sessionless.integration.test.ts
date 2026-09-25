/** DB-owned sessionless kiosk contract under production RLS and no org context. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { currentRequestOrgResolver, db, registerRequestOrgResolver, withOrg } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { identifyByPin, registerKiosk, resolveKioskByToken, revokeKiosk, setWorkerPin } from "./kiosk.ts";
import { lockActiveKioskToken } from "./kiosk-token-lock.ts";
import { FieldTimeError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFieldTime(orgId: string): Promise<void> {
  await withOrg(orgId, () => db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeKiosk": true}'::jsonb)
     where id = ${orgId}`));
}

/**
 * Run fn with the integration-test bypass lifted, so unscoped reads meet
 * production RLS (deny-by-default GUCs, FORCE ROW LEVEL SECURITY) instead
 * of test authority. Without this the test would pass even when the
 * service reads with no org context — the guard going blind, untested.
 */
async function withoutTestBypass<T>(fn: () => Promise<T>): Promise<T> {
  const prev = currentRequestOrgResolver();
  registerRequestOrgResolver(() => undefined);
  try {
    return await fn();
  } finally {
    registerRequestOrgResolver(prev ?? (() => undefined));
  }
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

test("a sessionless device resolves its kiosk and identifies by PIN with no org context", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const token = await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${worker}, ${org.orgId}, 'person', 'Crew Hand')`);
      const employmentId = randomUUID();
      await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${employmentId}, ${org.orgId}, ${worker}, ${org.subsidiaryId}, 1)`);
      await db.execute(sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at) values (${org.orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())`);
      const { token } = await registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Gate", allowedSubsidiaryIds: null });
      await setWorkerPin({ orgId: org.orgId, actorUserId: randomUUID(), employeePartyId: worker, pin: "4821", allowedSubsidiaryIds: null });
      return token;
    });
    // No withOrg wrapper anywhere below: this is the device's exact shape.
    await withoutTestBypass(async () => {
      const kiosk = await resolveKioskByToken(token);
      assert.equal(kiosk.orgId, org.orgId);
      assert.equal(kiosk.name, "Gate");
      assert.equal(await identifyByPin({ kiosk, employeePartyId: worker, pin: "4821" }), worker);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a revoked token cannot pass the mutation-time kiosk lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    await withOrg(org.orgId, async () => {
      const registered = await registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Retired Gate", allowedSubsidiaryIds: null });
      await revokeKiosk({ orgId: org.orgId, kioskId: registered.kiosk.id, actorUserId: randomUUID(), allowedSubsidiaryIds: null });
      assert.equal(await refusesCode(() => lockActiveKioskToken({ orgId: org.orgId, kioskId: registered.kiosk.id, deviceToken: registered.token })), "kiosk_unknown");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
