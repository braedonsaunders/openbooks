import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";
import { loadDocumentInventoryLines } from "@openbooks/engine/src/inventory/document-lines.ts";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __inventoryDefaultEntityAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__inventoryDefaultEntityAudit.user,allowedSubsidiaryIds:null}}",
      ) };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

/**
 * B-INV-06 (+B2-INV-05): an unscoped posting books to the hierarchy root no
 * matter the entry path. The fixture backdates a child subsidiary so it is
 * the oldest-created entity: the old per-route default booked to it, while
 * document lines always used the root.
 */
test("unscoped receipts, counts, and document lines book to the root entity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = { orgId: org.orgId, id: actor };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    // A younger root with an older child: oldest-created is NOT the root.
    const elderId = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${elderId},${org.orgId},${org.subsidiaryId},'Elder child','CAD','CA')`);
    await db.execute(sql`update subsidiaries set created_at='2020-01-01T00:00:00Z' where org_id=${org.orgId} and id=${elderId}`);
    // The warehouse admits the root only: a path resolving any other entity
    // trips the ownership check instead of posting elsewhere.
    await db.execute(sql`update locations set subsidiary_id=${org.subsidiaryId}, subsidiary_include_children=false
      where org_id=${org.orgId} and id=${org.locationId}`);
    const oldest = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id=${org.orgId} order by created_at,id limit 1`)).rows[0]!.id;
    assert.equal(oldest, elderId, "fixture must make a non-root entity the oldest");

    // Path 1: the actions route posts an unscoped receipt.
    const { POST: postAction } = await import("./route.ts");
    const receipt = await postAction(new Request("http://audit.local/api/inventory/actions", {
      method: "POST",
      body: JSON.stringify({
        action: "receive", idempotencyKey: randomUUID(), itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, date: org.date,
        quantity: "5", unitCost: "10", offsetAccountId: org.accounts.clearing,
      }),
    }));
    assert.equal(receipt.status, 200, JSON.stringify(await receipt.clone().json()));
    const movement = (await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text as subsidiary_id from inventory_movements where org_id=${org.orgId}`)).rows[0]!;
    assert.equal(movement.subsidiary_id, org.subsidiaryId, "unscoped receipt books to the root, not the oldest entity");

    // Path 2: the counts route creates an unscoped count.
    const { POST: postCount } = await import("../counts/route.ts");
    const count = await postCount(new Request("http://audit.local/api/inventory/counts", {
      method: "POST",
      body: JSON.stringify({
        action: "create", idempotencyKey: randomUUID(), locationId: org.locationId,
        date: org.date, lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
      }),
    }));
    assert.equal(count.status, 200, JSON.stringify(await count.clone().json()));
    const header = (await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text as subsidiary_id from stock_counts where org_id=${org.orgId}`)).rows[0]!;
    assert.equal(header.subsidiary_id, org.subsidiaryId, "unscoped count books to the root, not the oldest entity");

    // Path 3: document lines resolve an unscoped document to the same root.
    const documentId = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,currency,status)
      values(${documentId},${org.orgId},'goods_receipt','GR-ROOT-1',${org.date},'CAD','draft')`);
    await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,quantity,unit_price,amount,stock_location_id)
      values(${randomUUID()},${org.orgId},${documentId},1,${org.items.fifo},2,10,20,${org.stockLocationId})`);
    // The warehouse admits the root only, so a successful load proves the
    // unscoped document resolved to the root — any other entity would trip
    // the ownership check above.
    const lines = await loadDocumentInventoryLines(db, org.orgId, documentId);
    assert.equal(lines.length, 1, "all three paths book to the same root entity");
  } finally { await dropScratchOrg(org.orgId); }
});
