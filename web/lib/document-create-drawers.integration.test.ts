import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "./auth";

/**
 * Every document list's New control opens the shared unsaved-create drawer.
 *
 * Each list header renders the shared NewDocumentButton, which navigates to
 * `?doc=new&kind=` without allocating anything; the list loader below must
 * answer that URL with an open create drawer. A list whose loader refuses
 * the create URL (or whose New menu offers a kind the loader rejects)
 * strands the operator on a dead New button: no drawer, no error. This pins
 * the contract once, centrally, for every document list.
 *
 * Only session copy and translations are doubled; the loaders, feature gates
 * and permission checks run against a scratch org.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __documentCreateDrawersUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const { stubModules } = await import("../testing/stub-modules");
stubModules({ intl: true, extra: { "server-only": "export {}" } });
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__documentCreateDrawersUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { isDocumentCreateKind } = await import("./document-kinds");
const { loadApBills } = await import("../app/(app)/ap/bills/view");
const { loadArInvoices } = await import("../app/(app)/ar/invoices/view");
const { loadCashSales } = await import("../app/(app)/cash-sales/view");
const { loadBankingTransactions } = await import("../app/(app)/banking/transactions/view");
const { loadReturns } = await import("../app/(app)/returns/view");

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor,
  orgId,
  name: "Clerk",
  email: "clerk@scratch.test",
  roles: [],
  isSuperAdmin: false,
  envKind: "production",
  productionOrgId: orgId,
  homeOrgId: orgId,
  homeUserId: actor,
});

type NewItem = { kind: string; label: string; href?: string };

function assertNavigable(list: string, items: NewItem[]): void {
  assert.ok(items.length > 0, `${list} offers at least one New kind`);
  for (const item of items) {
    assert.ok(
      (item.href ?? "") !== "" || isDocumentCreateKind(item.kind),
      `${list} New item "${item.kind}" must navigate (href) or be a creatable kind`,
    );
  }
}

test(
  "every document list New opens its create drawer",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb)
        || '{"cashSales":true,"orders":true,"warehousing":true,"fulfillment":true,"returnAuthorizations":true}'::jsonb, true)
       where id = ${org.orgId}`),
      );
      const userId = await withBypassContext(() => createScratchUser(org.orgId, "clerk", "clerk"));
      await withBypassContext(() =>
        db.execute(sql`
      update app_roles set permissions = ${JSON.stringify([
        "ap.read",
        "ap.create",
        "ap.post",
        "ar.read",
        "ar.create",
        "ar.post",
        "banking.read",
        "gl.post",
        "cash_sales.read",
        "cash_sales.create",
        "orders.fulfill",
        "items.post",
      ])}::jsonb
       where org_id = ${org.orgId} and key = ${"clerk"}`),
      );
      state.user = sessionFor(org.orgId, userId);
      const load = <T>(
        fn: (sp: Record<string, string | string[] | undefined>) => Promise<T>,
        sp: Record<string, string>,
      ) => withOrgContext(org.orgId, () => fn(sp));

      const bills = await load(loadApBills, { doc: "new", kind: "vendor_bill", mode: "edit" });
      assert.equal(bills.drawerOpen, true, "bills New opens the create drawer");
      assert.equal((bills.drawer as { createMode?: boolean } | null)?.createMode, true);
      assertNavigable("bills", bills.newItems);
      assert.deepEqual(
        bills.newItems.filter((item) => !item.href).map((item) => item.kind),
        ["vendor_bill", "vendor_credit"],
      );
      assert.deepEqual(
        bills.newItems.filter((item) => item.href).map((item) => item.href),
        ["/ap/bills/batch"],
      );

      const invoices = await load(loadArInvoices, {
        doc: "new",
        kind: "customer_invoice",
        mode: "edit",
      });
      assert.equal(invoices.drawerOpen, true, "invoices New opens the create drawer");
      assert.equal((invoices.drawer as { createMode?: boolean } | null)?.createMode, true);
      assertNavigable("invoices", invoices.newButton.items);
      assert.deepEqual(
        invoices.newButton.items.map((item) => item.kind),
        ["customer_invoice", "customer_credit"],
      );

      const cash = await load(loadCashSales, { doc: "new", kind: "cash_sale", mode: "edit" });
      assert.equal(cash.drawerOpen, true, "cash sales New opens the create drawer");
      assert.equal((cash.drawer as { createMode?: boolean } | null)?.createMode, true);
      assertNavigable("cash sales", cash.newButton.items);
      // Create kinds open the drawer; the cashier daily-summary fast path
      // (0d90039bb2) joins the menu as a navigating item, so it is pinned by href.
      assert.deepEqual(
        cash.newButton.items.filter((item) => !item.href).map((item) => item.kind),
        ["cash_sale", "cash_refund"],
      );
      assert.deepEqual(
        cash.newButton.items.filter((item) => item.href).map((item) => item.href),
        ["/cash-sales/daily-summary"],
      );

      const banking = await load(loadBankingTransactions, {
        doc: "new",
        kind: "card_charge",
        mode: "edit",
      });
      assert.equal(banking.drawerOpen, true, "banking New opens the create drawer");
      assert.equal((banking.drawer as { createMode?: boolean } | null)?.createMode, true);
      assertNavigable("banking", banking.newButton.items);

      const returns = await load(loadReturns, { doc: "new", kind: "rma", mode: "edit" });
      assert.ok(returns.drawer, "returns New opens the create drawer");
      assert.equal((returns.drawer as { createMode?: boolean } | null)?.createMode, true);
      assertNavigable("returns", returns.newButton.items);
      assert.deepEqual(
        returns.newButton.items.map((item) => item.kind),
        ["rma"],
      );
    } finally {
      state.user = null;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
