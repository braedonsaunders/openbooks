import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";
import { receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { postLandedCostVoucher, reverseLandedCostVoucher } from "@openbooks/engine/src/inventory/landed-cost.ts";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __landedPagingAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__landedPagingAudit.user,allowedSubsidiaryIds:null}}",
      ) };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

interface VoucherRow {
  id: string;
  documentNumber: string;
  status: string;
  voucherDate: string;
}

async function getJson(url: string): Promise<{ status: number; body: { vouchers: VoucherRow[]; totalCount: number; nextCursor: string | null } }> {
  const { GET } = await import("./route");
  const response = await GET(new Request(url));
  return { status: response.status, body: await response.json() };
}

/**
 * IN10: with 50 newer (all reversed) vouchers, an older still-posted one
 * vanished from the only reversal picker — the list was newest-50-only with
 * no status filter or cursor. The list is now server-filtered by status,
 * server-searched, and cursor-paged with a total.
 */
test("an older posted voucher behind 50 reversed ones stays pickable", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = { orgId: org.orgId, id: actor };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    await receiveInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      quantity: "200", unitCost: "10", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
    const target = [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }];
    // One older voucher, then 50 newer ones on later in-period dates.
    const oldest = await postLandedCostVoucher(org.orgId, actor, { amount: "100", basis: "value",
      freightAccountId: org.accounts.freight, subsidiaryId: org.subsidiaryId, voucherDate: "2026-07-01",
      memo: "January freight still posted", targets: target });
    const newer: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const day = String(2 + (i % 14)).padStart(2, "0");
      const voucher = await postLandedCostVoucher(org.orgId, actor, { amount: "1", basis: "value",
        freightAccountId: org.accounts.freight, subsidiaryId: org.subsidiaryId, voucherDate: `2026-07-${day}`,
        memo: `routine freight ${i}`, targets: target });
      newer.push(voucher.id);
    }
    for (const id of newer) {
      await reverseLandedCostVoucher(org.orgId, actor, { voucherId: id, reversalDate: org.date, reason: "Freight was billed to the wrong receipt entirely" });
    }

    // The reversal picker asks for posted vouchers: the older one is there.
    const posted = await getJson("http://audit.local/api/inventory/advanced?view=landed&status=posted&limit=50");
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.totalCount, 1, "only the older voucher is still posted");
    assert.equal(posted.body.vouchers.length, 1);
    assert.equal(posted.body.vouchers[0]!.id, oldest.id, "the older posted voucher must be pickable");
    assert.equal(posted.body.nextCursor, null);

    // Unfiltered, the 51 vouchers page past the old 50-row cap with a total.
    const first = await getJson("http://audit.local/api/inventory/advanced?view=landed&limit=50");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.totalCount, 51);
    assert.equal(first.body.vouchers.length, 50);
    assert.ok(typeof first.body.nextCursor === "string" && first.body.nextCursor.length > 0, "a cursor must continue the list");
    assert.ok(!first.body.vouchers.some((v) => v.id === oldest.id), "the older voucher sorts last (guard)");
    const second = await getJson(
      `http://audit.local/api/inventory/advanced?view=landed&limit=50&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.totalCount, 51);
    assert.equal(second.body.vouchers.length, 1);
    assert.equal(second.body.vouchers[0]!.id, oldest.id, "the second page must reach the older voucher");
    assert.equal(second.body.nextCursor, null);

    // Server search finds the older voucher by its document number.
    const number = posted.body.vouchers[0]!.documentNumber;
    const found = await getJson(
      `http://audit.local/api/inventory/advanced?view=landed&status=posted&q=${encodeURIComponent(number)}`,
    );
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.totalCount, 1);
    assert.equal(found.body.vouchers[0]!.id, oldest.id);

    // Boundary refusals stay refusals, not server errors.
    for (const bad of [
      "http://audit.local/api/inventory/advanced?view=landed&status=archived",
      "http://audit.local/api/inventory/advanced?view=landed&limit=500",
      "http://audit.local/api/inventory/advanced?view=landed&cursor=not-a-cursor",
    ]) {
      const refused = await getJson(bad);
      assert.equal(refused.status, 422, bad);
    }
  } finally { await dropScratchOrg(org.orgId); }
});
