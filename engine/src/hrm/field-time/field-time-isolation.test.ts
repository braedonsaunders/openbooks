/**
 * HR-20 feature-off isolation proofs (DB-owned — gated remotely).
 *
 * The field-ticket system is shipped and in use; field time must never
 * interfere with it. With fieldTime / fieldTimeCrewEntry off, every
 * existing path that can reach field-time code — the timesheet drawer
 * flags (approvalFlags), the project cockpit crew-today (crewToday), the
 * team scope (teamClockedIn), and the inbox worklist
 * (crewTimeBatchAdapter.list) — must observe nothing and issue no query
 * against a field-time table. Writes refuse by name before any row.
 *
 * Each proof runs the real hook with a recording double in place of the
 * executor: every statement is delegated to the live handle (so results
 * are real) and its SQL text remembered. The off-assertions fail naming
 * the exact statement that reached for a gated table. The final test
 * turns the features on and shows the same doubles DO observe the gated
 * tables, so the off-assertions are not vacuous.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db, withOrg, type SqlExecutor } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { crewTimeBatchAdapter } from "../../inbox/adapters/crew-time-batch.ts";
import { FieldTimeError } from "./errors.ts";
import {
  approvalFlags,
  crewToday,
  getBatchDetail,
  listCrewBatches,
  myClockDay,
  teamClockedIn,
} from "./reads.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const FIELD_TIME_TABLES =
  /(time_clock_events|crew_time_batch|worker_clock_pins|project_geofences|time_kiosks)/i;

/** Recording double: delegates to the live handle, remembers SQL text. */
function recording() {
  const seen: string[] = [];
  const exec = {
    execute: (async (query: SQL) => {
      seen.push(new PgDialect().sqlToQuery(query).sql);
      return db.execute(query as unknown as Parameters<typeof db.execute>[0]);
    }),
  } as unknown as SqlExecutor;
  return { exec, seen };
}

function gatedStatements(seen: string[]): string[] {
  return seen.filter((text) => FIELD_TIME_TABLES.test(text));
}

/** Parents on, field-time flags explicitly off: only our own gate can refuse. */
async function disableFieldTime(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "equipment": true,
             "fieldTime": false, "fieldTimeGeofence": false, "fieldTimePhoto": false,
             "fieldTimeKiosk": false, "fieldTimeCrewEntry": false,
             "fieldTimeEquipment": false, "fieldTimeMultiStageApproval": false}'::jsonb)
     where id = ${orgId}`);
}

async function enableFieldTime(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "equipment": true,
             "fieldTime": true, "fieldTimeCrewEntry": true}'::jsonb)
     where id = ${orgId}`);
}

function refusesCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error) => {
      assert.ok(error instanceof FieldTimeError, `refusal is a FieldTimeError, got ${String(error)}`);
      return (error as FieldTimeError).code;
    },
  );
}

test("feature-off: timesheet and cockpit reads observe nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await disableFieldTime(org.orgId);
    await withOrg(org.orgId, async () => {
      const { exec, seen } = recording();
      assert.deepEqual(
        await approvalFlags(org.orgId, { weekStart: "2026-09-14", employeePartyId: randomUUID() }, exec),
        [],
      );
      assert.deepEqual(await crewToday(org.orgId, randomUUID(), exec), []);
      assert.deepEqual(await teamClockedIn(org.orgId, randomUUID(), "2026-09-14", exec), []);
      assert.deepEqual(
        gatedStatements(seen),
        [],
        `existing paths reached gated tables while fieldTime is off:\n${gatedStatements(seen).join("\n")}`,
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("feature-off: self and crew reads refuse by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await disableFieldTime(org.orgId);
    await withOrg(org.orgId, async () => {
      const { exec, seen } = recording();
      assert.equal(await refusesCode(myClockDay(org.orgId, randomUUID(), exec)), "field_time_off");
      assert.equal(await refusesCode(listCrewBatches(org.orgId, {}, { actorUserId: randomUUID(), allowedSubsidiaryIds: null }, exec)), "field_time_crew_off");
      assert.equal(await refusesCode(getBatchDetail(org.orgId, { actorUserId: randomUUID(), allowedSubsidiaryIds: null }, randomUUID(), exec)), "field_time_crew_off");
      assert.deepEqual(
        gatedStatements(seen),
        [],
        `refusals ran gated statements before refusing:\n${gatedStatements(seen).join("\n")}`,
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("feature-off: inbox lists no crew items without touching crew tables", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await disableFieldTime(org.orgId);
    await withOrg(org.orgId, async () => {
      const { exec, seen } = recording();
      const items = await crewTimeBatchAdapter.list({
        orgId: org.orgId,
        actorId: randomUUID(),
        asOf: new Date().toISOString(),
        exec,
      });
      assert.deepEqual(items, []);
      assert.deepEqual(
        gatedStatements(seen),
        [],
        `inbox reached gated tables while fieldTimeCrewEntry is off:\n${gatedStatements(seen).join("\n")}`,
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("feature-on: the same doubles observe the gated tables (red-proof)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    await withOrg(org.orgId, async () => {
      const flags = recording();
      await approvalFlags(org.orgId, { weekStart: "2026-09-14", employeePartyId: randomUUID() }, flags.exec);
      assert.ok(
        gatedStatements(flags.seen).length > 0,
        "the double sees no gated table with the feature on — the off-assertions above prove nothing",
      );
      const today = recording();
      await crewToday(org.orgId, randomUUID(), today.exec);
      assert.ok(
        gatedStatements(today.seen).length > 0,
        "the double sees no gated table with the feature on — the off-assertions above prove nothing",
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
