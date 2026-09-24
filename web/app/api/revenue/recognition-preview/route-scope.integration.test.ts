import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";
Object.assign(globalThis, { __recognitionPreviewOracleNextResponse: NextResponse });

/**
 * H-REVENUE (preview oracle): the preview's id lookups must not confirm an
 * out-of-scope row's existence. Naming another entity's obligation or
 * contract answers exactly like a missing id (422 *_not_found); in-scope and
 * unrestricted ids preview normally. Only the gate is doubled; the engine
 * attribution and database are real.
 */
const state = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
  allowed: null as Set<string> | null,
};
Object.assign(globalThis, { __recognitionPreviewOracleState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      specifier.endsWith("/lib/authz") &&
      context.parentURL?.includes("/revenue/recognition-preview/")
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            const NextResponse = globalThis.__recognitionPreviewOracleNextResponse;
            export async function guardPermission(permission){
              if (!globalThis.__recognitionPreviewOracleState.permissions.has(permission)) {
                return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
              }
              return {
                user: globalThis.__recognitionPreviewOracleState.user,
                allowedSubsidiaryIds: globalThis.__recognitionPreviewOracleState.allowed,
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});

const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./route.ts");

async function previewFixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const subB = randomUUID();
  await withBypassContext(
    () => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`),
  );
  const ids = { obligationA: randomUUID(), obligationB: randomUUID(), contractA: randomUUID(), contractB: randomUUID() };
  for (const [oKey, cKey, sub] of [
    ["obligationA", "contractA", org.subsidiaryId],
    ["obligationB", "contractB", subB],
  ] as const) {
    await withBypassContext(
      () => db.execute(sql`
        insert into revenue_contracts
          (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, subsidiary_id, created_by, updated_by)
        values (${ids[cKey]}, ${org.orgId}, ${org.customerId}, ${`PREVIEW-SCOPE-${cKey}`}, 'active', '2026-01-01',
                'CAD', '12000', ${sub}, ${adminId}, ${adminId})`),
    );
    await withBypassContext(
      () => db.execute(sql`
        insert into performance_obligations
          (id, org_id, contract_id, description, recognition_rule_id,
           booked_amount, allocated_price, recognition_starts_on, status, created_by, updated_by)
        values (${ids[oKey]}, ${org.orgId}, ${ids[cKey]}, ${`Preview service ${oKey}`}, ${org.recognitionRuleId},
                '12000', '12000', '2026-01-01', 'open', ${adminId}, ${adminId})`),
    );
  }
  return { org, adminId, subA: org.subsidiaryId, ids };
}

const post = (body: unknown) =>
  POST(
    new Request("https://openbooks.test/api/revenue/recognition-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("recognition-preview oracle: out-of-scope ids answer exactly like missing ids", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const { org, adminId, subA, ids } = await previewFixture();
  try {
    state.user = { orgId: org.orgId, id: adminId };
    state.permissions = new Set<string>(["ar.post"]);
    state.allowed = new Set<string>([subA]);

    const foreignObligation = await post({ obligationId: ids.obligationB });
    assert.equal(foreignObligation.status, 422);
    assert.deepEqual(await foreignObligation.json(), { error: "obligation_not_found", field: "obligationId" });

    const missingObligation = await post({ obligationId: randomUUID() });
    assert.equal(missingObligation.status, 422);
    assert.deepEqual(await missingObligation.json(), { error: "obligation_not_found", field: "obligationId" });

    const foreignContract = await post({ contractId: ids.contractB });
    assert.equal(foreignContract.status, 422);
    assert.deepEqual(await foreignContract.json(), { error: "contract_not_found", field: "contractId" });

    const missingContract = await post({ contractId: randomUUID() });
    assert.equal(missingContract.status, 422);
    assert.deepEqual(await missingContract.json(), { error: "contract_not_found", field: "contractId" });

    const own = await post({ obligationId: ids.obligationA });
    assert.equal(own.status, 200);

    state.allowed = null;
    const open = await post({ obligationId: ids.obligationB });
    assert.equal(open.status, 200);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
