import assert from "node:assert/strict";
import test from "node:test";
import "../dashboard/_dashboard-render-harness";
import {
  buttonsNamed,
  click,
  mountDashboard,
  scriptFetch,
  tick,
} from "../dashboard/_dashboard-render-harness";
import type { OrderPayload } from "./OrderDrawer";

const { registerHooks } = await import("node:module");

const confirmScript = { confirmResult: true, confirmCalls: [] as unknown[] };
Object.assign(globalThis, { __orderReceiptVoid: confirmScript });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(opts){const s=globalThis.__orderReceiptVoid;s.confirmCalls.push(opts);return s.confirmResult}",
      };
    }
    return next(specifier, context);
  },
});

const { OrderDrawer } = await import("./OrderDrawer");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { act } = await import("react");

type Toast = { kind: string; message: string };

function toasts(): Toast[] {
  return (globalThis as unknown as { __dashToasts?: Toast[] }).__dashToasts ?? [];
}

function pushes(): string[] {
  return (globalThis as unknown as { __dashRouter: { pushes: string[] } }).__dashRouter.pushes;
}

const ORG_ID = "org-receipt-void-1";
const PO_ID = "77777777-7777-7777-8777-777777777777";
const RECEIPT_ID = "88888888-8888-8888-8888-888888888888";
const RECEIPT_REVISION = "2026-08-02T09:00:00.123456Z";

function poDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PO_ID,
    currency: "CAD",
    subsidiary_id: null,
    project_id: null,
    department_id: null,
    memo: null,
    due_date: null,
    document_date: "2026-08-01",
    updated_at: "2026-08-01T12:00:00.123456Z",
    subtotal: "20",
    tax_total: "0",
    total: "20",
    party_id: "vendor-1",
    party_name: "Vendor",
    document_number: "PO-9001",
    extra_dims: {},
    status: "approved",
    ...overrides,
  };
}

function receiptLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: "to",
    link_type: "fulfills",
    id: RECEIPT_ID,
    kind: "purchase_receipt",
    document_number: "RCPT-0001",
    status: "approved",
    ...overrides,
  };
}

async function mountPo(canVoidReceipt = true) {
  return mountDashboard(
    <OrderDrawer
      order={{ doc: poDoc(), lines: [], links: [receiptLink()] } as unknown as OrderPayload}
      kind="purchase_order"
      orgId={ORG_ID}
      parties={[{ id: "vendor-1", display_name: "Vendor" }]}
      accounts={[{ id: "acct-5000", display_name: "Purchases" }]}
      items={[]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      canVoidReceipt={canVoidReceipt || undefined}
      closeHref="/purchase-orders"
    />,
    messages,
  );
}

function voidDialog(): HTMLElement | null {
  return document.querySelector('[aria-label="Void this transaction?"]');
}

async function typeVoidReason(value: string) {
  const area = voidDialog()?.querySelector("#void-reason") as HTMLTextAreaElement | null;
  assert.ok(area, "the void dialog asks for a reason");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function confirmVoidDialog() {
  const confirm = [...(voidDialog()?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === "Void" && !(b as HTMLButtonElement).disabled,
  ) as HTMLButtonElement | undefined;
  assert.ok(confirm, "the void dialog confirms explicitly");
  await click(confirm);
  await tick();
  await tick();
  await tick();
}

async function openVoidDialog() {
  await openRelatedTab();
  const voids = buttonsNamed("Void");
  assert.equal(voids.length, 1, "the approved receipt link offers Void");
  await click(voids[0]!);
  await tick();
  await tick();
  assert.ok(voidDialog(), "Void opens the governed dialog, not a blind post");
}

async function openRelatedTab() {
  const tab = buttonsNamed("Origin / Converted into")[0];
  assert.ok(tab, "the Related tab shows linked documents");
  await click(tab);
  await tick();
  await tick();
}

function mockVoidEndpoints(
  t: { after: (fn: () => void | Promise<void>) => void },
  post: (body: Record<string, unknown>) => Response,
) {
  return scriptFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url === `/api/documents/${RECEIPT_ID}/void` && method === "GET") {
      return Response.json({
        adjustmentPeriods: [],
        originalDate: "2026-08-01",
        suggestedDate: "2026-08-01",
        fallbackToOpenPeriod: false,
        originalFiscalYear: 2026,
        originalPeriodName: "2026-08",
        suggestedFiscalYear: 2026,
        suggestedPeriodName: "2026-08",
        suggestedOpen: true,
        revision: RECEIPT_REVISION,
      });
    }
    if (url === `/api/documents/${RECEIPT_ID}/void` && method === "POST") {
      return post(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
    if (url.startsWith("/api/flows/"))
      return Response.json({ error: "no flow state" }, { status: 404 });
    return null;
  });
}

test("voiding a linked goods receipt posts with its revision and toasts its number", async (t) => {
  window.sessionStorage.clear();
  const posts: Record<string, unknown>[] = [];
  const restoreFetch = mockVoidEndpoints(t, (body) => {
    posts.push(body);
    return Response.json({ ok: true, status: "voided", reversalEntryId: "entry-1" });
  });
  t.after(restoreFetch);
  const { unmount } = await mountPo();
  t.after(unmount);
  await tick();
  await tick();
  await openVoidDialog();
  await typeVoidReason("phantom full-quantity receipt from the blind convert");
  await confirmVoidDialog();
  assert.equal(posts.length, 1, "the void posts once");
  assert.deepEqual(posts[0], {
    reason: "phantom full-quantity receipt from the blind convert",
    expectedUpdatedAt: RECEIPT_REVISION,
    reversalDate: "2026-08-01",
  });
  const saved = toasts().filter((toast) => toast.kind === "success");
  assert.ok(
    saved.some((toast) => toast.message.includes("RCPT-0001")),
    `the void toasts the receipt number, got: ${JSON.stringify(saved)}`,
  );
  assert.deepEqual(pushes(), [], "the void stays on the order: no navigation");
});

test("a refused receipt void pins the refusal and keeps the link", async (t) => {
  window.sessionStorage.clear();
  const restoreFetch = mockVoidEndpoints(t, () =>
    Response.json(
      {
        error:
          "inventory from this movement has downstream consumption; reverse those issues/transfers first",
      },
      { status: 422 },
    ),
  );
  t.after(restoreFetch);
  const { unmount } = await mountPo();
  t.after(unmount);
  await tick();
  await tick();
  await openVoidDialog();
  await typeVoidReason("phantom full-quantity receipt from the blind convert");
  await confirmVoidDialog();
  assert.ok(
    voidDialog()?.querySelector('[role="alert"]'),
    "the refusal renders in the open dialog",
  );
  assert.ok(
    document.body.textContent?.includes("downstream consumption"),
    "the refusal names the real blocker",
  );
  assert.equal(
    toasts().filter((toast) => toast.kind === "success").length,
    0,
    "a refused void toasts nothing",
  );
  assert.equal(
    buttonsNamed("Void").filter((b) => !voidDialog()?.contains(b)).length,
    1,
    "the receipt link stays voidable",
  );
});

test("a denied receipt void keeps the dialog open with the grant to ask for", async (t) => {
  window.sessionStorage.clear();
  const restoreFetch = mockVoidEndpoints(t, () =>
    Response.json({ error: "missing permission: goods_receipts.create" }, { status: 403 }),
  );
  t.after(restoreFetch);
  const { unmount } = await mountPo();
  t.after(unmount);
  await tick();
  await tick();
  await openVoidDialog();
  await typeVoidReason("phantom full-quantity receipt from the blind convert");
  await confirmVoidDialog();
  assert.ok(voidDialog(), "a denied void never closes the dialog");
  assert.match(
    voidDialog()?.textContent ?? "",
    /missing permission: goods_receipts\.create/,
    "the denial renders its message in the dialog",
  );
  assert.match(
    voidDialog()?.textContent ?? "",
    /Ask your administrator/,
    "the denial names the grant to ask for",
  );
  assert.equal(
    toasts().filter((toast) => toast.kind === "success").length,
    0,
    "a denied void toasts nothing",
  );
});

test("a viewer without the void grant gets the hint instead of Void", async (t) => {
  window.sessionStorage.clear();
  const restoreFetch = mockVoidEndpoints(t, () => Response.json({ ok: true }));
  t.after(restoreFetch);
  const { unmount } = await mountPo(false);
  t.after(unmount);
  await tick();
  await tick();
  await openRelatedTab();
  assert.equal(buttonsNamed("Void").length, 0, "no live Void is offered without the grant");
  assert.match(
    document.body.textContent ?? "",
    /Ask your administrator/,
    "the link carries the shared missing-grant hint",
  );
});
