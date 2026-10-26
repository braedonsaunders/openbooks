import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import "../dashboard/_dashboard-render-harness";
import { mountDashboard, scriptFetch, tick } from "../dashboard/_dashboard-render-harness";
import type { OrderPayload } from "./OrderDrawer";

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { OrderDrawer } = await import("./OrderDrawer");
const { ReceiveAgainstPoDrawer } = await import("../inventory/ReceiveAgainstPoDrawer");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;

const PO_ID = "33333333-3333-4333-8333-333333333333";
const LINE_ID = "88888888-8888-4888-8888-888888888888";
const WH_ID = "77777777-7777-4777-8777-777777777777";

function stockPo(status: string): OrderPayload {
  return {
    doc: {
      id: PO_ID,
      status,
      currency: "USD",
      subsidiary_id: null,
      project_id: null,
      department_id: null,
      memo: null,
      due_date: null,
      document_date: "2026-08-01",
      updated_at: "2026-08-01T12:00:00.123456Z",
      subtotal: "20.00",
      tax_total: "0",
      total: "20.00",
      party_id: "vendor-1",
      party_name: "Acme Supplies",
      document_number: "PO-1001",
      extra_dims: {},
    },
    lines: [
      {
        id: LINE_ID,
        item_id: "item-widget",
        account_id: "acct-1200",
        description: "Widget",
        quantity: "10",
        quantity_fulfilled: "0",
        quantity_cancelled: "0",
        unit: "ea",
        unit_price: "2.00",
        tax_code_id: null,
        tax_group_id: null,
        department_id: null,
        project_id: null,
        stock_location_id: null,
        extra_dims: {},
      },
    ],
    links: [],
  } as unknown as OrderPayload;
}

function drawerProps(order: OrderPayload) {
  return {
    order,
    kind: "purchase_order" as const,
    parties: [{ id: "vendor-1", display_name: "Acme Supplies" }],
    accounts: [],
    items: [{ id: "item-widget", display_name: "Widget", has_inventory_profile: true }],
    stockLocations: [{ id: WH_ID, code: "TACOMA-WH", subsidiaryId: null }],
    taxCodes: [],
    taxGroups: [],
    departments: [],
    projects: [],
    subsidiaries: [],
    segments: [],
    canManage: true,
    allowedConvertKinds: ["purchase_receipt", "vendor_bill"],
    closeHref: "/purchase-orders",
  };
}

function prefillOk() {
  return Response.json({
    receiptDate: "2026-08-01",
    lines: [
      {
        sourceLineId: LINE_ID,
        lineNumber: 1,
        description: "Widget",
        unit: "ea",
        unitPrice: "2.00",
        remaining: "10",
        stockLocationId: WH_ID,
      },
    ],
  });
}

function mockPrefill(t: TestContext) {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/receive` && (init?.method ?? "GET") === "GET")
      return prefillOk();
    if (url.startsWith("/api/flows/"))
      return Response.json({ error: "no flow state" }, { status: 404 });
    return null;
  });
  t.after(restoreFetch);
}

function receiptDialog(): HTMLElement | null {
  return document.querySelector('[aria-label="Receive goods"]');
}

test("the inventory receive entry opens the order with the receipt form raised", async (t) => {
  mockPrefill(t);
  const { unmount } = await mountDashboard(
    <OrderDrawer {...drawerProps(stockPo("approved"))} initialReceiveOpen />,
    messages,
  );
  t.after(unmount);
  await tick();
  await tick();
  assert.ok(receiptDialog(), "receive=1 raises the receipt form without touching Actions");
  const date = receiptDialog()?.querySelector("#receipt-date") as HTMLInputElement | null;
  assert.equal(date?.value, "08/01/2026", "the raised form prefills the business date");
});

test("the receive entry honors nothing on a draft order", async (t) => {
  mockPrefill(t);
  const { unmount } = await mountDashboard(
    <OrderDrawer {...drawerProps(stockPo("draft"))} initialReceiveOpen />,
    messages,
  );
  t.after(unmount);
  await tick();
  await tick();
  assert.equal(receiptDialog(), null, "a draft order opens normally even with receive=1");
  assert.match(
    document.body.textContent ?? "",
    /PO-1001/,
    "the draft drawer still opens on its own record",
  );
});

test("the inventory picker links each open order to its raised receipt form", async (t) => {
  const po = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const { unmount } = await mountDashboard(
    <ReceiveAgainstPoDrawer
      orders={[
        { id: po, number: "PO-2001", vendor: "Acme Supplies", openLines: 2 },
        { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", number: null, vendor: null, openLines: 1 },
      ]}
      closeHref="/inventory?inventoryView=movements"
    />,
    messages,
  );
  t.after(unmount);
  await tick();
  const links = [...document.querySelectorAll("a")].filter((a) =>
    (a as HTMLAnchorElement).href.includes("receive=1"),
  ) as HTMLAnchorElement[];
  assert.equal(links.length, 2, "every open order links to its receipt form");
  assert.ok(links[0]!.href.includes(`order=${po}`), "the link carries the order identity");
  assert.match(links[0]!.textContent ?? "", /PO-2001/, "the link names the order");
  assert.match(links[0]!.textContent ?? "", /Acme Supplies/, "the link names the vendor");
});

test("the inventory picker says plainly when nothing is waiting", async (t) => {
  const { unmount } = await mountDashboard(
    <ReceiveAgainstPoDrawer orders={[]} closeHref="/inventory?inventoryView=movements" />,
    messages,
  );
  t.after(unmount);
  await tick();
  assert.match(
    document.body.textContent ?? "",
    /No purchase orders are waiting for receipt/,
    "an empty queue explains itself instead of rendering a bare drawer",
  );
});

function primaryReceiveButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Receive goods",
  ) as HTMLButtonElement | undefined;
}

test("an issued purchase order with stock left to receive offers Receive goods as its primary action", async (t) => {
  mockPrefill(t);
  const { unmount } = await mountDashboard(
    <OrderDrawer {...drawerProps(stockPo("approved"))} />,
    messages,
  );
  t.after(unmount);
  await tick();
  const primary = primaryReceiveButton();
  assert.ok(primary, "the issued order exposes the receipt step without opening Actions");
  primary.click();
  await tick();
  await tick();
  assert.ok(receiptDialog(), "the primary action raises the receipt form");
});

test("an issued purchase order with nothing left to receive offers no receive primary action", async (t) => {
  mockPrefill(t);
  const received = stockPo("approved");
  received.lines = received.lines.map((line) => ({
    ...line,
    quantity_fulfilled: "10",
  })) as typeof received.lines;
  const { unmount } = await mountDashboard(<OrderDrawer {...drawerProps(received)} />, messages);
  t.after(unmount);
  await tick();
  assert.equal(
    primaryReceiveButton(),
    undefined,
    "a fully received order has no receipt step to offer",
  );
});
