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
Object.assign(globalThis, { __orderSaveLanding: confirmScript });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(opts){const s=globalThis.__orderSaveLanding;s.confirmCalls.push(opts);return s.confirmResult}",
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

const ORG_ID = "org-save-landing-1";
const QUOTE_ID = "55555555-5555-5555-8555-555555555555";
const CREATED_ID = "66666666-6666-6666-8666-666666666666";

function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: QUOTE_ID,
    currency: "CAD",
    subsidiary_id: null,
    project_id: null,
    department_id: null,
    memo: null,
    due_date: null,
    document_date: "2026-08-01",
    updated_at: "2026-08-01T12:00:00.123456Z",
    subtotal: "100",
    tax_total: "0",
    total: "100",
    party_id: "cust-1",
    party_name: "Acme",
    document_number: "EST-1001",
    extra_dims: {},
    status: "draft",
    ...overrides,
  };
}

function baseLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientKey: "line-1",
    persistedLineId: "line-db-1",
    item_id: null,
    account_id: "acct-4000",
    description: "Advisory",
    quantity: "1",
    unit: "hr",
    unit_price: "100.00",
    tax_code_id: null,
    tax_group_id: null,
    department_id: null,
    project_id: null,
    stock_location_id: null,
    extra_dims: {},
    ...overrides,
  };
}

async function mountDrawer(props: { createMode?: boolean; doc?: Record<string, unknown> } = {}) {
  return mountDashboard(
    <OrderDrawer
      order={
        { doc: props.doc ?? baseDoc(), lines: [baseLine()], links: [] } as unknown as OrderPayload
      }
      kind="quote"
      orgId={ORG_ID}
      parties={[{ id: "cust-1", display_name: "Acme" }]}
      accounts={[{ id: "acct-4000", display_name: "Revenue" }]}
      items={[]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      createMode={props.createMode}
      initialMode="edit"
      closeHref="/estimates"
    />,
    messages,
  );
}

function textInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll("input")].filter(
    (input) => (input as HTMLInputElement).type === "text",
  ) as HTMLInputElement[];
}

function inputByValue(value: string): HTMLInputElement | null {
  return textInputs().find((input) => input.value === value) ?? null;
}

async function typeMemo(value: string) {
  const memo = textInputs()[0]!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(memo, value);
    memo.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function openActionsSave() {
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions live behind the Actions menu");
  await click(menu);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode offers an explicit Save");
  await click(save);
  await tick();
  await tick();
}

test("creating an estimate lands in view mode with a saved toast naming its number", async (t) => {
  window.sessionStorage.clear();
  let posts = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/estimates" && init?.method === "POST") {
      posts += 1;
      return Response.json(
        {
          doc: baseDoc({
            id: CREATED_ID,
            document_number: "EST-1002",
            updated_at: "2026-08-02T09:00:00.123456Z",
          }),
          lines: [],
          links: [],
        },
        { status: 201 },
      );
    }
    if (url.startsWith("/api/flows/"))
      return Response.json({ error: "no flow state" }, { status: 404 });
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer({ createMode: true, doc: baseDoc({ id: "" }) });
  t.after(unmount);
  await tick();
  await tick();
  await typeMemo("fresh estimate");
  await openActionsSave();
  assert.equal(posts, 1, "the create posts once");
  assert.deepEqual(
    pushes(),
    [`/estimates?estimate=${CREATED_ID}`],
    "the create lands on the persisted record without edit mode",
  );
  const saved = toasts().filter((toast) => toast.kind === "success");
  assert.ok(
    saved.some((toast) => toast.message.includes("EST-1002")),
    `the create toasts the saved number, got: ${JSON.stringify(saved)}`,
  );
});

test("saving an edited estimate toasts its number and leaves edit mode", async (t) => {
  window.sessionStorage.clear();
  let patches = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/estimates/${QUOTE_ID}` && init?.method === "PATCH") {
      patches += 1;
      return Response.json(
        {
          doc: baseDoc({ memo: "keep me", updated_at: "2026-08-02T10:00:00.123456Z" }),
          lines: [],
          links: [],
        },
        { status: 200 },
      );
    }
    if (url.startsWith("/api/flows/"))
      return Response.json({ error: "no flow state" }, { status: 404 });
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer();
  t.after(unmount);
  await tick();
  await tick();
  await typeMemo("keep me");
  await openActionsSave();
  assert.equal(patches, 1, "the edit saves once");
  assert.equal(
    inputByValue("keep me"),
    null,
    "the save leaves edit mode: the memo input is read-only text",
  );
  const saved = toasts().filter((toast) => toast.kind === "success");
  assert.ok(
    saved.some((toast) => toast.message.includes("EST-1001")),
    `the edit toasts the saved number, got: ${JSON.stringify(saved)}`,
  );
});
