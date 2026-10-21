import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * The inventory asset account re-points open valuation: every issue relieves
 * the profile's CURRENT asset account, so moving it while the item holds
 * open stock strands the old account's debit. The native costing-profile
 * service refuses the move while stock is on hand — naming the issue-or-sell
 * remedy — with a refused-audit row (actor, requested accounts, reason), and
 * still saves the same move for an item holding no stock. Accounts that
 * price future postings only (COGS here) change freely with stock on hand.
 * Runs in a child with React's server condition like the purchase-receipt
 * counterpart, because the receive flow lives behind it.
 */
test("costing refuses an asset-account move while stock is on hand", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { registerHooks } from "node:module";
    import { sql } from "drizzle-orm";
    import { db, withBypassContext, withOrg, withOrgContext } from "./engine/src/platform/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const state = { orgId: "", actorId: "" };
    Object.assign(globalThis, { __costingAssetGuard: state });
    const virtual = (s) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(s) });
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "next/navigation")
        return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
      if (specifier.endsWith("/lib/feature-gates"))
        return virtual("export async function guardFeaturePermission() { const s = globalThis.__costingAssetGuard; return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null }; }");
      return next(specifier, context);
    } });
    const { GET, PUT } = await import("./web/app/api/items/[id]/costing/route.ts");

    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
      state.orgId = org.orgId;
      state.actorId = actorId;
      await withBypassContext(() => db.execute(sql\`
        update orgs set settings = jsonb_set(settings, '{features,inventory}', 'true'::jsonb, true)
         where id = \${org.orgId}\`));
      const call = (itemId, body) => withOrgContext(org.orgId, () => (body === undefined ? GET : PUT)(
        new Request("http://costing.test/api/items/" + itemId + "/costing", {
          method: body === undefined ? "GET" : "PUT",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: itemId }) },
      ));
      const profile = async () => {
        const res = await call(org.items.fifo);
        const json = await res.json();
        assert.equal(res.status, 200, JSON.stringify(json));
        return json.profile;
      };
      const putBody = (token, overrides) => ({
        costingMethod: "fifo",
        tracking: "none",
        assetAccountId: org.accounts.invAsset,
        cogsAccountId: org.accounts.cogs,
        adjustmentAccountId: org.accounts.adjustment,
        varianceAccountId: org.accounts.adjustment,
        receivedNotBilledAccountId: org.accounts.clearing,
        baseUnit: "ea",
        expectedUpdatedAt: token,
        ...overrides,
      });
      const auditRefusals = async () => (await db.execute(sql\`
        select actor_id as "actorId", changes from audit_log
         where org_id = \${org.orgId} and table_name = 'item_inventory_profiles' and row_id = \${org.items.fifo}
           and action = 'update' and changes->>'refused' = 'true'
         order by at desc\`)).rows;

      // A second asset account to move to, and a second expense account.
      const newAsset = randomUUID();
      const newCogs = randomUUID();
      await withBypassContext(() => db.execute(sql\`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (\${newAsset}, \${org.orgId}, '1310', 'Second Inventory Asset', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true),
               (\${newCogs}, \${org.orgId}, '5010', 'Second COGS', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)\`));

      // Receive real on-hand stock through the native purchase flow.
      const userId = actorId;
      const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
      const sourceLineId = randomUUID();
      await withBypassContext(() => db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${sourceLineId}, \${org.orgId}, \${order.id}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
           'Widget', '10', 'ea', '2', '20', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)\`));
      await withBypassContext(() => db.execute(sql\`
        update documents set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = '20', total = '20'
         where id = \${order.id} and org_id = \${org.orgId}\`));
      await withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, {
        receiptDate: org.date, idempotencyKey: "receipt-asset-guard", lines: [{ sourceLineId, quantity: "10" }],
      }));

      // ---- The asset move is refused while stock is on hand ---------------
      const before = await profile();
      const refused = await call(org.items.fifo, putBody(before.updated_at, { assetAccountId: newAsset }));
      const refusedJson = await refused.json();
      assert.equal(refused.status, 409, JSON.stringify(refusedJson));
      assert.match(refusedJson.error ?? "", /on-hand stock/, "the refusal names the stocked state");
      assert.match(refusedJson.error ?? "", /issue or sell/, "the refusal names the remedy");
      const afterRefusal = await profile();
      assert.equal(afterRefusal.asset_account_id, org.accounts.invAsset, "a refused move writes nothing");
      assert.equal(afterRefusal.updated_at, before.updated_at, "a refused move burns no revision");
      const refusals = await auditRefusals();
      const [refusal] = refusals;
      assert.ok(refusal, "the refused move leaves an audit row");
      assert.equal(refusal.actorId, actorId, "the audit row names the actor");
      assert.match(JSON.stringify(refusal.changes), /on-hand stock/, "the audit row keeps the reason");
      assert.match(JSON.stringify(refusal.changes), new RegExp(newAsset), "the audit row keeps the requested account");

      // ---- Future-posting accounts still move with stock on hand ----------
      const cogsMove = await call(org.items.fifo, putBody(before.updated_at, { cogsAccountId: newCogs }));
      assert.equal(cogsMove.status, 200, JSON.stringify(await cogsMove.json()));
      const afterCogs = await profile();
      assert.equal(afterCogs.cogs_account_id, newCogs, "the COGS move commits");
      assert.equal(afterCogs.asset_account_id, org.accounts.invAsset, "the asset account is untouched");

      // ---- The same asset move commits for an item holding no stock ------
      const otherRes = await call(org.items.movingAvg);
      const otherJson = await otherRes.json();
      assert.equal(otherRes.status, 200, JSON.stringify(otherJson));
      const stockless = await call(org.items.movingAvg, putBody(otherJson.profile.updated_at, {
        costingMethod: "moving_average",
        assetAccountId: newAsset,
      }));
      assert.equal(stockless.status, 200, JSON.stringify(await stockless.json()));
      const otherAfterRes = await call(org.items.movingAvg);
      const otherAfter = (await otherAfterRes.json()).profile;
      assert.equal(otherAfter.asset_account_id, newAsset, "the asset move commits with no open stock");

      console.log("COSTING-ASSET-GUARD");
    } finally {
      try { await dropScratchOrg(org.orgId); }
      finally { await (await import("@openbooks/jobs")).closeJobConnections(); }
    }
  `;

  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/testing/database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /COSTING-ASSET-GUARD/);
});
