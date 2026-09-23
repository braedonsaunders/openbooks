import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// convertApplicationOrder must refuse cross-kind ids and out-of-scope
// subsidiaries before the converter runs: without the route-kind check a
// quote/SO id converts through the purchase-orders route, and without the
// subsidiary check an out-of-scope PO converts under a restricted key.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { convertApplicationOrder } = await import("./orders.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

async function insertOrder(orgId: string, actor: string, kind: string, subsidiaryId: string | null, number: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,currency,subtotal,tax_total,total,subsidiary_id,created_by)
    values (${id},${orgId},${kind},${number},'2026-07-15','CAD','0','0','0',${subsidiaryId},${actor})`));
  return id;
}

function contextFor(orgId: string, actor: string, allowed: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: { id: actor, orgId, name: "Converter", email: "c@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor },
      permissions: new Set(["ap.create", "ar.create"]),
      allowedSubsidiaryIds: allowed,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: "key-1",
  };
}

test("convert refuses a sibling-kind id on the wrong route", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Converter", "order_converter"));
    const quoteId = await insertOrder(org.orgId, actor, "quote", org.subsidiaryId, "EST-SCOPE-1");
    const ctx = contextFor(org.orgId, actor, null);
    await assert.rejects(
      () => convertApplicationOrder(ctx, {
        documentId: quoteId,
        targetKind: "vendor_bill",
        idempotencyKey: `scope-kind-${randomUUID()}`,
        expectedKind: "purchase_order",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "not_found");
        assert.equal(error.status, 404);
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("convert refuses an out-of-scope subsidiary PO for a restricted caller", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Converter", "order_converter"));
    const hidden = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`));
    const poId = await insertOrder(org.orgId, actor, "purchase_order", hidden, "PO-SCOPE-1");
    const ctx = contextFor(org.orgId, actor, new Set([org.subsidiaryId]));
    await assert.rejects(
      () => convertApplicationOrder(ctx, {
        documentId: poId,
        targetKind: "vendor_bill",
        idempotencyKey: `scope-sub-${randomUUID()}`,
        expectedKind: "purchase_order",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "forbidden");
        assert.equal(error.status, 403);
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("convert passes the guards for a matching kind in scope", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Converter", "order_converter"));
    const quoteId = await insertOrder(org.orgId, actor, "quote", org.subsidiaryId, "EST-SCOPE-2");
    const ctx = contextFor(org.orgId, actor, new Set([org.subsidiaryId]));
    // A draft cannot convert: reaching the converter's own draft refusal
    // proves the kind and subsidiary guards passed.
    await assert.rejects(
      () => convertApplicationOrder(ctx, {
        documentId: quoteId,
        targetKind: "sales_order",
        idempotencyKey: `scope-pass-${randomUUID()}`,
        expectedKind: "quote",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "invalid_input");
        assert.match(error.message, /Issue the order before converting/);
        return true;
      },
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
