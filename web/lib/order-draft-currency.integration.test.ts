import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// createOrderDraft must refuse when the org base currency is missing instead
// of inventing CAD — the same rule the canonical order create enforces, so a
// draft can never silently book foreign-currency intent as domestic.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createOrderDraft, OrderDraftError } = await import("./order-cycle.ts");


test("createOrderDraft refuses when the org base currency is missing", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Drafter", "order_drafter"));
    // base_currency is NOT NULL, so an unconfigured org carries the empty
    // string — the same falsy "missing" state the canonical create refuses.
    await withBypassContext(() => db.execute(sql`update orgs set base_currency = '' where id = ${org.orgId}`));
    await assert.rejects(
      () => withBypassContext(() => createOrderDraft(org.orgId, actor, "purchase_order", randomUUID(), null)),
      (error: unknown) => {
        assert.ok(error instanceof OrderDraftError);
        assert.match(error.message, /no base currency configured/);
        assert.match(error.message, /set one before creating orders/);
        return true;
      },
    );
    const count = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*) as n from documents where org_id = ${org.orgId} and kind = 'purchase_order'`))).rows[0]!.n;
    assert.equal(Number(count), 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("createOrderDraft mints the draft in the org base currency", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Drafter", "order_drafter"));
    const draft = await withBypassContext(() => createOrderDraft(org.orgId, actor, "purchase_order", randomUUID(), null));
    const row = (await withBypassContext(() => db.execute<{ currency: string }>(sql`
      select currency from documents where id = ${draft.id} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(row.currency, "CAD");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
