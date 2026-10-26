import assert from "node:assert/strict";
import test from "node:test";

// Keyboard-first capture review: the real drawer inside the real shortcut
// provider, with only fetch and the router scripted. Each test drives the
// keys a clerk presses and reads what the drawer sends and where it goes.

declare global {
  var __kbRouter: { pushes: string[]; refreshes: number } | undefined;
  var __kbToasts: { kind: string; message: string }[] | undefined;
  var __kbConfirms: unknown[] | undefined;
}

// The primary modifier follows the platform; pin a non-Apple one (Ctrl).
Object.defineProperty(globalThis.navigator ?? {}, "platform", {
  value: "Linux x86_64",
  configurable: true,
});

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/ap/capture",
  matchMediaMatches: false,
  resizeObserver: false,
});
Object.defineProperty(window.navigator, "platform", { value: "Linux x86_64", configurable: true });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){const r=globalThis.__kbRouter;return{push(u){r.pushes.push(u)},replace(u){r.pushes.push(u)},refresh(){r.refreshes+=1},back(){},prefetch(){}}}export function usePathname(){return '/ap/capture'}export function useSearchParams(){return new URLSearchParams()}",
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__kbToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__kbToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__kbToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "../../../../lib/confirm") {
      const source =
        "export async function confirmDialog(options){(globalThis.__kbConfirms??=[]).push(options);return true}";
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { ShortcutProvider } = await import("../../../../components/shortcuts/shortcut-provider");
const { CaptureReviewDrawer } = await import("./CaptureReviewDrawer");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const CAPTURE_ID = "cap-kb-1";
const NAVIGATION = {
  listHref: "/ap/capture?status=ready",
  previousHref: "/ap/capture?status=ready&capture=cap-prev",
  nextHref: "/ap/capture?status=ready&capture=cap-next",
  nextReviewHref: "/ap/capture?status=ready&capture=cap-review",
};

function detail(overrides: { invoiceNumber?: string | null; total?: string | null } = {}) {
  return {
    id: CAPTURE_ID,
    status: "ready",
    updatedAt: "2026-10-21T12:00:00.000000Z",
    file_id: "file-1",
    original_filename: "acme-1042.pdf",
    document_kind: "vendor_bill" as const,
    normalized: {
      vendorName: "Acme",
      vendorTaxId: null,
      invoiceNumber: overrides.invoiceNumber === undefined ? "1042" : overrides.invoiceNumber,
      invoiceDate: "2026-10-01",
      dueDate: null,
      purchaseOrderNumber: null,
      currency: "USD",
      subtotal: "100.00",
      taxTotal: "0.00",
      total: overrides.total === undefined ? "100.00" : overrides.total,
      memo: null,
      lines: [],
    },
    validation_issues: [],
    overall_confidence: null,
    vendor_candidate_id: "vendor-1",
    purchase_order_id: null,
    document_id: null,
    last_error: null,
    contentType: "application/pdf",
    sizeBytes: 10,
    resolvedVendor: "Acme",
    purchaseOrderNumber: null,
    evidence: [],
  };
}

type Calls = { materialize: number; actions: unknown[]; bulk: unknown[] };

async function mount(
  options: {
    postStatus?: number;
    postBody?: unknown;
    invoiceNumber?: string | null;
    total?: string | null;
    canPost?: boolean;
    trust?: unknown;
  } = {},
) {
  globalThis.__kbRouter = { pushes: [], refreshes: 0 };
  globalThis.__kbToasts = [];
  globalThis.__kbConfirms = [];
  const calls: Calls = { materialize: 0, actions: [], bulk: [] };
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url === `/api/ap-capture/${CAPTURE_ID}/materialize`) {
      calls.materialize += 1;
      return Response.json({ documentId: "bill-1", documentNumber: "BILL-1" });
    }
    if (url === "/api/documents/actions") {
      calls.actions.push(JSON.parse(String(init?.body)));
      return Response.json(options.postBody ?? { ok: true, entryId: "je-1" }, {
        status: options.postStatus ?? 200,
      });
    }
    if (url === "/api/ap-capture/actions") {
      calls.bulk.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ id: CAPTURE_ID, ok: true }] });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ShortcutProvider>
          <CaptureReviewDrawer
            initial={detail(options)}
            vendors={[{ id: "vendor-1", label: "Acme" }]}
            accounts={[]}
            purchaseOrders={[]}
            canCreate
            canPost={options.canPost ?? true}
            navigation={NAVIGATION}
            trust={(options.trust as never) ?? null}
          />
        </ShortcutProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    calls,
    async done() {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function press(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
    await tick(60);
  });
  await tick(30);
}

function inputHolding(value: string): HTMLInputElement {
  const found = [...document.querySelectorAll("input")].find(
    (el) => (el as HTMLInputElement).value === value,
  );
  assert.ok(found, `an input holding ${JSON.stringify(value)} must exist`);
  return found as HTMLInputElement;
}

test("J and K move to the next and previous capture in list order", async (t) => {
  const drawer = await mount();
  t.after(() => drawer.done());
  await press(document.body, { key: "j", code: "KeyJ" });
  await press(document.body, { key: "k", code: "KeyK" });
  assert.deepEqual(globalThis.__kbRouter!.pushes, [NAVIGATION.nextHref, NAVIGATION.previousHref]);
});

test("J typed into a field is text, not navigation", async (t) => {
  const drawer = await mount();
  t.after(() => drawer.done());
  const field = inputHolding("1042");
  field.focus();
  await press(field, { key: "j", code: "KeyJ" });
  assert.deepEqual(globalThis.__kbRouter!.pushes, []);
});

test("Ctrl+Enter creates the draft and opens the next capture awaiting review, even from a field", async (t) => {
  const drawer = await mount();
  t.after(() => drawer.done());
  const field = inputHolding("1042");
  field.focus();
  await press(field, { key: "Enter", code: "Enter", ctrlKey: true });
  assert.equal(drawer.calls.materialize, 1);
  assert.deepEqual(drawer.calls.actions, [], "a plain create does not post");
  assert.deepEqual(globalThis.__kbRouter!.pushes, [NAVIGATION.nextReviewHref]);
});

test("Ctrl+Shift+Enter creates the draft, posts it through the documents action and moves on", async (t) => {
  const drawer = await mount();
  t.after(() => drawer.done());
  await press(document.body, { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
  assert.equal(drawer.calls.materialize, 1);
  assert.deepEqual(drawer.calls.actions, [{ action: "post", documentId: "bill-1" }]);
  assert.deepEqual(globalThis.__kbRouter!.pushes, [NAVIGATION.nextReviewHref]);
  assert.ok(
    globalThis.__kbToasts!.some(
      (toast) => toast.kind === "success" && toast.message === "Bill posted",
    ),
  );
});

test("a posting refusal keeps the draft, pins the refusal and stays on the capture", async (t) => {
  const drawer = await mount({
    postStatus: 422,
    postBody: { error: "The period 2026-10 is closed for AP." },
  });
  t.after(() => drawer.done());
  await press(document.body, { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
  assert.equal(drawer.calls.materialize, 1);
  assert.deepEqual(globalThis.__kbRouter!.pushes, [], "review does not move past a refused post");
  const pinned = [...document.querySelectorAll('[role="alert"]')].map(
    (node) => node.textContent ?? "",
  );
  assert.ok(
    pinned.some((textContent) => textContent.includes("The period 2026-10 is closed for AP.")),
    pinned.join(" | "),
  );
});

test("an approval Flow holding the bill is reported as submitted, not posted", async (t) => {
  const drawer = await mount({
    postStatus: 202,
    postBody: { ok: true, pendingApproval: true, requestId: "run-1" },
  });
  t.after(() => drawer.done());
  await press(document.body, { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
  assert.ok(
    globalThis.__kbToasts!.some(
      (toast) => toast.message === "Draft created and submitted for approval",
    ),
  );
  assert.deepEqual(globalThis.__kbRouter!.pushes, [NAVIGATION.nextReviewHref]);
});

test("create-and-post is unavailable without posting permission", async (t) => {
  const drawer = await mount({ canPost: false });
  t.after(() => drawer.done());
  await press(document.body, { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
  assert.equal(drawer.calls.materialize, 0);
  assert.deepEqual(drawer.calls.actions, []);
});

test("Ctrl+Backspace rejects after confirmation and moves to the next capture awaiting review", async (t) => {
  const drawer = await mount();
  t.after(() => drawer.done());
  await press(document.body, { key: "Backspace", code: "Backspace", ctrlKey: true });
  assert.equal(globalThis.__kbConfirms!.length, 1);
  assert.deepEqual(drawer.calls.bulk, [{ action: "reject", ids: [CAPTURE_ID] }]);
  assert.deepEqual(globalThis.__kbRouter!.pushes, [NAVIGATION.nextReviewHref]);
});

test("Enter in a field jumps to the next field that needs attention, then to Create draft", async (t) => {
  const drawer = await mount({ invoiceNumber: "", total: "" });
  t.after(() => drawer.done());
  await act(async () => {
    await tick(80);
  });
  const invoice = document.querySelector<HTMLInputElement>(
    '[data-capture-field="invoiceNumber"] input',
  )!;
  assert.ok(
    document.activeElement === invoice,
    "focus starts on the first field needing attention",
  );
  await press(invoice, { key: "Enter", code: "Enter" });
  const total = document.querySelector('[data-capture-field="total"] input');
  assert.ok(document.activeElement === total, "Enter skips the confident fields between them");
  await press(total!, { key: "Enter", code: "Enter" });
  assert.equal(
    (document.activeElement as HTMLElement | null)?.hasAttribute("data-capture-primary"),
    true,
    "with every field confirmed, Enter lands on Create draft",
  );
});

test("the vendor's earned trust is shown on the capture", async (t) => {
  const drawer = await mount({
    trust: { trusted: true, cleanStreak: 3, threshold: 3, policyEnabled: true, brokenBy: null },
  });
  t.after(() => drawer.done());
  assert.ok(document.body.textContent?.includes("Trusted: 3 clean bills in a row"));
});
