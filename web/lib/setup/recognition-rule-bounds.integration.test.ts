import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Recognition-rule policy bounds are enforced where the rule is saved, not
 * where it is later used: a term of -1, an overlong term or offset, or an
 * up-front percent above 100 used to save with a 200 and fail every later
 * invoice attach or posting. Proved here against the real setup writer and
 * a real database: each out-of-domain save is refused by field name with no
 * row written (create) or no row changed (edit), and valid values save.
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
const { createSetupRecord, updateSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seed() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  return { org, actor };
}

const ruleBody = (extra: Record<string, unknown> = {}) => ({
  code: `RM4-${randomUUID().slice(0, 8)}`,
  name: "Bounds probe",
  method: "straight_line_even",
  recognitionPeriods: 12,
  isActive: true,
  ...extra,
});

async function ruleCount(orgId: string, code: string) {
  const rows = (
    await db.execute<{ id: string }>(
      sql`select id from recognition_rules where org_id = ${orgId} and code = ${code}`,
    )
  ).rows;
  return rows.length;
}

test(
  "a rule with valid bounds saves",
  { skip: !DB },
  async () => {
    const { org, actor } = await seed();
    try {
      const body = ruleBody();
      const created = await createSetupRecord(actor, "recognition-rules", body);
      assert.equal(created.status, 200);
      assert.equal(await ruleCount(org.orgId, String(body.code)), 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

for (const [field, value] of [
  ["recognitionPeriods", -1],
  ["recognitionPeriods", 1201],
  ["periodOffset", 1201],
  ["initialAmountPercent", 150],
] as const) {
  test(
    `creating a rule with ${field} = ${value} is refused with no row written`,
    { skip: !DB },
    async () => {
      const { org, actor } = await seed();
      try {
        const body = ruleBody({ [field]: value });
        const created = await createSetupRecord(actor, "recognition-rules", body);
        assert.equal(created.status, 400);
        assert.match(String((created.body as { error?: string }).error ?? ""), new RegExp(field));
        assert.equal(await ruleCount(org.orgId, String(body.code)), 0);
      } finally {
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
}

test(
  "editing a rule out of bounds is refused with no row changed",
  { skip: !DB },
  async () => {
    const { org, actor } = await seed();
    try {
      const body = ruleBody();
      const created = await createSetupRecord(actor, "recognition-rules", body);
      assert.equal(created.status, 200);
      const id = String((created.body as { id: string }).id);
      const refused = await updateSetupRecord(actor, "recognition-rules", {
        id,
        name: "Bounds probe",
        method: "straight_line_even",
        recognitionPeriods: -1,
      });
      assert.equal(refused.status, 400);
      assert.match(
        String((refused.body as { error?: string }).error ?? ""),
        /recognitionPeriods/,
      );
      const row = (
        await db.execute<{ recognition_periods: number }>(
          sql`select recognition_periods from recognition_rules where org_id = ${org.orgId} and id = ${id}`,
        )
      ).rows[0]!;
      assert.equal(row.recognition_periods, 12);
      const saved = await updateSetupRecord(actor, "recognition-rules", {
        id,
        name: "Bounds probe",
        method: "straight_line_even",
        recognitionPeriods: 6,
      });
      assert.equal(saved.status, 200);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
