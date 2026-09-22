/**
 * HR-20 kiosk sessionless resolution (DB-owned — gated remotely).
 *
 * Kiosk devices carry no session: resolveKioskByToken and identifyByPin run
 * with no ambient org context. Under FORCE RLS an unscoped read resolves
 * nothing, so the token must be resolved under a narrow bypass and every
 * subsequent read scoped to the resolved org — otherwise every device meets
 * kiosk_unknown / pin_not_set. These tests call the service exactly as the
 * device does (no withOrg wrapper) and prove the happy path resolves plus
 * unknown tokens still refuse.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { currentRequestOrgResolver, db, registerRequestOrgResolver, withOrg } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { identifyByPin, registerKiosk, resolveKioskByToken, setWorkerPin } from "./kiosk.ts";
import { FieldTimeError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFieldTime(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeKiosk": true}'::jsonb)
     where id = ${orgId}`);
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
      const { token } = await registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Gate" });
      await setWorkerPin({ orgId: org.orgId, actorUserId: randomUUID(), employeePartyId: worker, pin: "4821" });
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

test("an unknown device token refuses without org context", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    await withoutTestBypass(async () => {
      assert.equal(await refusesCode(() => resolveKioskByToken("not-a-real-device-token")), "kiosk_unknown");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
