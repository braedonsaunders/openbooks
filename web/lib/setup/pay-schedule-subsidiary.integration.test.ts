import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * The setup-writer half of the frozen-entity defect: the payroll onboarding
 * wizard creates pay schedules through the generic setup entity route, which
 * accepted `subsidiaryId: null` in a multi-entity tenant without a word —
 * minting schedules whose runs froze the wrong paying entity and currency.
 * Re-scoping such a schedule later healed nothing.
 *
 * Proved here against the real writer and a real database:
 * - creating a pay schedule with no subsidiary is refused in a multi-entity
 *   org, and allowed in a single-entity one;
 * - un-scoping an existing schedule is refused the same way;
 * - re-scoping a schedule re-resolves its draft run (entity AND currency)
 *   in the same transaction and reports the outcome on the response.
 */

// The writer imports the server-only marker; shim it like the other
// route-level tests do (same seam as subsidiary-scope.test.ts).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createPayRun } = await import("@openbooks/engine/src/payroll/run-lifecycle.ts");
const {
  createSetupRecord,
  updateSetupRecord,
} = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg(options: { secondSubsidiary?: boolean } = {}) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || '{"features": {"payroll": true}}'::jsonb
     where id = ${org.orgId}`);
  let secondId: string | null = null;
  if (options.secondSubsidiary) {
    secondId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                is_elimination, is_active, custom)
      values (${secondId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
              '{}'::jsonb, false, true, '{}'::jsonb)`);
  }
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  return { orgId: org.orgId, rootSubsidiaryId: org.subsidiaryId, secondId, actor };
}

const scheduleBody = (extra: Record<string, unknown> = {}) => ({
  name: `Biweekly ${randomUUID().slice(0, 8)}`,
  frequency: "biweekly",
  periodsPerYear: 26,
  anchorPeriodEnd: "2026-07-18",
  isActive: true,
  ...extra,
});

test(
  "the wizard path refuses a subsidiary-less schedule in a multi-entity org",
  { skip: !DB },
  async () => {
    const f = await seedOrg({ secondSubsidiary: true });
    try {
      const refused = await createSetupRecord(f.actor, "pay-schedules", scheduleBody());
      assert.equal(refused.status, 400);
      assert.match(String(refused.body.error), /Choose the subsidiary this schedule pays for/);

      const created = await createSetupRecord(
        f.actor, "pay-schedules", scheduleBody({ subsidiaryId: f.secondId }),
      );
      assert.equal(created.status, 200);
      assert.ok(typeof created.body.id === "string");

      // Un-scoping back to none is the same defect and is refused too. (The
      // writer takes full-row PATCH bodies, like the drawer sends.)
      const unscoping = await updateSetupRecord(f.actor, "pay-schedules", {
        ...scheduleBody({ subsidiaryId: null }),
        id: created.body.id,
      });
      assert.equal(unscoping.status, 400);
      assert.match(String(unscoping.body.error), /Choose the subsidiary this schedule pays for/);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a single-entity org keeps the root default without being asked",
  { skip: !DB },
  async () => {
    const f = await seedOrg();
    try {
      const created = await createSetupRecord(f.actor, "pay-schedules", scheduleBody());
      assert.equal(created.status, 200);
      const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from pay_schedules
         where id = ${String(created.body.id)} and org_id = ${f.orgId}`)).rows[0]!;
      assert.equal(row.subsidiary_id, null);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a single-entity org may name its only subsidiary explicitly",
  { skip: !DB },
  async () => {
    // The payroll onboarding wizard always sends the org's sole subsidiary
    // id on a single-entity tenant ("defaults to its only subsidiary
    // without being asked"). The generic subsidiary feature fence must not
    // refuse that: naming a real, active subsidiary of the org is always
    // safe, and the engine's own pay-schedule rule validates it.
    const f = await seedOrg();
    try {
      const created = await createSetupRecord(
        f.actor, "pay-schedules", scheduleBody({ subsidiaryId: f.rootSubsidiaryId }),
      );
      assert.equal(created.status, 200);
      const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from pay_schedules
         where id = ${String(created.body.id)} and org_id = ${f.orgId}`)).rows[0]!;
      assert.equal(row.subsidiary_id, f.rootSubsidiaryId);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "re-scoping a schedule re-resolves its draft run in the same transaction",
  { skip: !DB },
  async () => {
    const f = await seedOrg({ secondSubsidiary: true });
    try {
      const created = await createSetupRecord(
        f.actor, "pay-schedules", scheduleBody({ subsidiaryId: f.rootSubsidiaryId }),
      );
      assert.equal(created.status, 200);
      const scheduleId = String(created.body.id);

      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actor.id, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const before = (await db.execute<{ subsidiary_id: string; currency: string }>(sql`
        select subsidiary_id, currency from documents where id = ${run.documentId}`)).rows[0]!;
      assert.equal(before.subsidiary_id, f.rootSubsidiaryId);
      assert.equal(before.currency, "CAD");

      const updated = await updateSetupRecord(f.actor, "pay-schedules", {
        ...scheduleBody({ subsidiaryId: f.secondId }),
        id: scheduleId,
      });
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.body.rescope, { reresolved: 1, untouched: 0 });

      const after = (await db.execute<{ subsidiary_id: string; currency: string }>(sql`
        select subsidiary_id, currency from documents where id = ${run.documentId}`)).rows[0]!;
      assert.equal(after.subsidiary_id, f.secondId);
      assert.equal(after.currency, "USD");
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);
