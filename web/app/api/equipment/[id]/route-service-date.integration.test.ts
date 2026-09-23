import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import type { Authz } from "../../../../lib/authz";

// Equipment dates are interpolated into DATE columns. An impossible calendar
// day (2026-02-30) passes the trim-only guard and must fail closed as a 422
// domain error — never escape as a PostgreSQL date error (a 500). Identity,
// features, and SQL stay native; only the authz gate is substituted.
const enabled = !!process.env.OPENBOOKS_DB_URL;
const identity: { gate: Authz | null } = { gate: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.equipment-date-guard")] = identity;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/api/json") return next(new URL("../../../../lib/api/json.ts", import.meta.url).href, context);
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "./authz" && (context.parentURL ?? "").endsWith("/lib/feature-gates.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          "export async function guardPermission(){return globalThis[Symbol.for('openbooks.equipment-date-guard')].gate}",
        ),
      };
    }
    return next(specifier, context);
  },
});
const { PATCH } = await import("./route");

function patch(id: string, body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`https://openbooks.test/api/equipment/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

test("equipment PATCH refuses an impossible service date with a 422", { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"equipment":true}'::jsonb) where id=${org.orgId}`);
    identity.gate = {
      user: { orgId: org.orgId, id: org.orgId },
      permissions: new Set(["*"]),
      allowedSubsidiaryIds: null,
    } as Authz;
    const unitId = randomUUID();
    await db.execute(sql`insert into equipment_units (id, org_id, subsidiary_id, unit_number, name, status)
      values (${unitId}, ${org.orgId}, ${org.subsidiaryId}, 'EX-001', 'Test excavator', 'draft')`);

    const bad = await patch(unitId, { acquiredOn: "2026-02-30", revision: 0 });
    assert.equal(bad.status, 422);
    const stored = (await db.execute<{ acquired_on: string | null }>(sql`
      select acquired_on::text as acquired_on from equipment_units where id = ${unitId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(stored.acquired_on, null);

    const badService = await patch(unitId, { acquiredOn: "2026-01-15", inServiceOn: "2026-02-30", revision: 0 });
    assert.equal(badService.status, 422);

    const good = await patch(unitId, { acquiredOn: "2026-01-15", inServiceOn: "2026-02-27", revision: 0 });
    assert.equal(good.status, 200);
  } finally {
    identity.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
