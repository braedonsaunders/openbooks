import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";

/**
 * Cash sales loader contract: an open draft carries the caller's create and
 * post grants to the shared DocumentDrawer, so a cash_sales.create holder can
 * edit, save and delete the draft while posting stays behind cash_sales.post.
 * The list's New control offers both cash kinds, each as an unsaved create.
 *
 * Only session copy and translations are doubled; the loader, feature gate
 * and permission checks run against a scratch org.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __cashSalesViewUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ intl: true, extra: { "server-only": "export {}" } });
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__cashSalesViewUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrg, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { receiveInventory } = await import("@openbooks/engine/inventory/movements");
const { loadCashSales } = await import("./view");

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor,
  orgId,
  name: "Cashier",
  email: "cashier@scratch.test",
  roles: [],
  isSuperAdmin: false,
  envKind: "production",
  productionOrgId: orgId,
  homeOrgId: orgId,
  homeUserId: actor,
});

async function role(orgId: string, key: string, permissions: string[]): Promise<string> {
  const userId = await withBypassContext(() => createScratchUser(orgId, key, key));
  await withBypassContext(() =>
    db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`),
  );
  return userId;
}

test(
  "a cash sale draft is editable for its create grant and postable only with post",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"cashSales":true}'::jsonb, true)
       where id = ${org.orgId}`),
      );
      const cashier = await role(org.orgId, "cashier", ["cash_sales.read", "cash_sales.create"]);
      const supervisor = await role(org.orgId, "till_supervisor", [
        "cash_sales.read",
        "cash_sales.create",
        "cash_sales.post",
        "cash_sales.deposit",
      ]);
      const viewer = await role(org.orgId, "till_viewer", ["cash_sales.read"]);
      const draftId = crypto.randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, created_by)
      values (${draftId}, ${org.orgId}, 'cash_sale', ${`CS-${draftId}`}, ${org.date}, 'USD', ${org.subsidiaryId}, ${cashier})`),
      );

      const load = (user: string, sp: Record<string, string>) => {
        state.user = sessionFor(org.orgId, user);
        return withOrgContext(org.orgId, () => loadCashSales(sp));
      };

      const asCashier = await load(cashier, { doc: draftId });
      assert.ok(asCashier.drawer, "the draft opens");
      assert.equal(
        asCashier.drawer.canCreate,
        true,
        "cash_sales.create edits, saves and deletes the draft",
      );
      assert.equal(asCashier.drawer.canPost, false, "posting stays behind cash_sales.post");
      assert.equal(asCashier.drawer.canDeposit, false, "till drops stay behind cash_sales.deposit");
      assert.deepEqual(
        asCashier.drawer.depositAccounts,
        [],
        "no configured destinations means no drop form",
      );
      assert.equal(asCashier.drawer.depositDefaultDate, "", "no deposit grant means no drop date");
      assert.deepEqual(
        asCashier.newButton.items.map((item) => item.kind),
        ["cash_sale", "cash_refund", "cash_sale", "cash_sale"],
        "the list New control offers both cash kinds plus the fast paths",
      );
      assert.equal(
        asCashier.newButton.items[2]?.href,
        `/cash-sales?doc=new&kind=cash_sale&duplicateFrom=${draftId}`,
        "the prior batch joins the menu as a duplicate source",
      );
      assert.equal(
        asCashier.newButton.items[3]?.href,
        "/cash-sales/daily-summary",
        "the daily summary entry navigates to its form",
      );

      const asSupervisor = await load(supervisor, { doc: draftId });
      assert.equal(asSupervisor.drawer?.canCreate, true);
      assert.equal(asSupervisor.drawer?.canPost, true);
      assert.equal(asSupervisor.drawer?.canDeposit, true, "cash_sales.deposit opens the till drop");
      assert.match(
        String(asSupervisor.drawer?.depositDefaultDate ?? ""),
        /^\d{4}-\d{2}-\d{2}$/,
        "the deposit grant resolves the org-today drop date",
      );
      assert.deepEqual(
        asSupervisor.drawer?.serverOptions,
        [],
        "no employees means pooled tips, never a refusal",
      );

      const asViewer = await load(viewer, { doc: draftId });
      assert.equal(asViewer.drawer?.canCreate, false, "a read-only role sees the draft read-only");
      assert.equal(asViewer.drawer?.canPost, false);

      const create = await load(cashier, { doc: "new", kind: "cash_sale" });
      assert.equal(create.drawer?.createMode, true, "New opens the unsaved-create drawer");
      assert.equal(create.drawer?.canCreate, true);
      const count = await withBypassContext(() =>
        db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from documents where org_id = ${org.orgId} and kind = 'cash_sale'`,
          "objects",
        ),
      );
      assert.equal(count[0]?.n, "1", "opening New allocates no document");
    } finally {
      state.user = null;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "refund prefill loads returnable lines for a sale with an issued stock line",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // The returnable-lines query joins a JSON-extracted text id against the
    // uuid movement key: the uuid side must cast, so an issued stock line
    // resolves instead of failing the comparison.
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"cashSales":true}'::jsonb, true)
       where id = ${org.orgId}`),
      );
      const cashier = await role(org.orgId, "cashier", ["cash_sales.read", "cash_sales.create"]);
      const saleId = crypto.randomUUID();
      const lineId = crypto.randomUUID();
      const tillId = crypto.randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
      values (${tillId}, ${org.orgId}, '1015', 'Till Cash', 'asset_current_other', false, true, false, false, null, '[]'::jsonb, '{}'::jsonb, true)`),
      );
      // Stock on hand first: the native posting issues the sale's stock
      // itself, so the fixture receives, drafts, approves and posts instead
      // of inserting posted rows the period guard refuses.
      await withOrg(org.orgId, () =>
        receiveInventory(org.orgId, cashier, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          quantity: "10",
          unitCost: "4",
          subsidiaryId: org.subsidiaryId,
          offsetAccountId: org.accounts.clearing,
          date: org.date,
        }),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, created_by, status)
      values (${saleId}, ${org.orgId}, 'cash_sale', 'CS-T5', ${org.date}, 'CAD', ${org.subsidiaryId}, ${cashier}, 'draft')`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, item_id, stock_location_id)
      values (${lineId}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue}, 'FIFO Widget', 2, 10, 20, ${org.items.fifo}, ${org.stockLocationId})`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into document_tenders (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null, '200000', 'CAD', null)`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`),
      );
      await withOrg(org.orgId, () =>
        postDocument(saleId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        }),
      );
      const movementId = (
        await withBypassContext(() =>
          db.execute<{ id: string }>(
            sql`
      select id from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`,
            "objects",
          ),
        )
      )[0]?.id;
      assert.ok(movementId, "posting the stocked sale must issue its stock natively");

      const load = (user: string, sp: Record<string, string>) => {
        state.user = sessionFor(org.orgId, user);
        return withOrgContext(org.orgId, () => loadCashSales(sp));
      };
      const refund = await load(cashier, { doc: "new", kind: "cash_refund", refundFrom: saleId });
      assert.equal(
        refund.drawer?.createMode,
        true,
        "the refund prefill opens the unsaved-create drawer",
      );
      const lines =
        (refund.drawer?.payload as { lines?: Record<string, unknown>[] } | undefined)?.lines ?? [];
      assert.equal(lines.length, 1, "the issued stock line prefills exactly once");
      assert.deepEqual(
        (lines[0]?.custom as { inventoryReturn?: { sourceIssueMovementId?: unknown } } | undefined)
          ?.inventoryReturn,
        { sourceIssueMovementId: movementId },
        "the prefill carries the issue movement as return evidence",
      );
    } finally {
      state.user = null;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "duplicate yesterday copies the prior batch as today's draft",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    // The fast path copies lines and tender shape with today's date while
    // close-out facts stay behind: yesterday's tips never seed today's draft.
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"cashSales":true}'::jsonb, true)
       where id = ${org.orgId}`),
      );
      const cashier = await role(org.orgId, "cashier", ["cash_sales.read", "cash_sales.create"]);
      const saleId = crypto.randomUUID();
      const tillId = crypto.randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
      values (${tillId}, ${org.orgId}, '1015', 'Till Cash', 'asset_current_other', false, true, false, false, null, '[]'::jsonb, '{}'::jsonb, true)`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, created_by, status, custom)
      values (${saleId}, ${org.orgId}, 'cash_sale', 'CS-PRIOR', '2020-01-01', 'USD', ${org.subsidiaryId}, ${cashier}, 'draft',
        '{"closeout": {"tipsTotal": "5.0000", "feeTotal": "0", "overShort": "0", "serverPartyId": null, "parts": []}}'::jsonb)`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
      values (${crypto.randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue}, 'Day sales', 1, 100, 100)`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into document_tenders (org_id, document_id, position, kind, method_label, account_id,
           stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null, '1000000', 'USD', null)`),
      );

      const load = (user: string, sp: Record<string, string>) => {
        state.user = sessionFor(org.orgId, user);
        return withOrgContext(org.orgId, () => loadCashSales(sp));
      };
      const list = await load(cashier, {});
      const duplicate = list.newButton.items.find((item) =>
        (item.href ?? "").includes("duplicateFrom="),
      );
      assert.equal(
        duplicate?.href,
        `/cash-sales?doc=new&kind=cash_sale&duplicateFrom=${saleId}`,
        "yesterday's batch joins the New menu as a duplicate source",
      );
      const create = await load(cashier, { doc: "new", kind: "cash_sale", duplicateFrom: saleId });
      assert.equal(
        create.drawer?.createMode,
        true,
        "the duplicate opens the unsaved-create drawer",
      );
      const payload = create.drawer?.payload as {
        doc: Record<string, unknown>;
        lines: Record<string, unknown>[];
      };
      assert.equal(payload.lines.length, 1, "yesterday's lines seed today's draft");
      assert.equal(payload.lines[0]?.account_id, org.accounts.revenue);
      const tenders = (payload.doc.custom as { tenders?: unknown[] } | undefined)?.tenders ?? [];
      assert.equal(tenders.length, 1, "yesterday's tender shape seeds today's draft");
      assert.ok(
        !("closeout" in ((payload.doc.custom ?? {}) as Record<string, unknown>)),
        "yesterday's close-out never seeds today's draft",
      );
    } finally {
      state.user = null;
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
