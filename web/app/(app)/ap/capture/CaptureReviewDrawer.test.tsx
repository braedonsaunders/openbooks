import assert from "node:assert/strict";
import test from "node:test";

// AP capture autosave must serialize overlapping saves: with an 800 ms
// debounce, a slow first PATCH is still in flight when the operator keeps
// typing (or when the debounce fires again). The old code sent a second
// save with the stale revision (409), then discarded the first save's
// fresh revision — wedging every later autosave on 409 until reload — and
// clobbered newer keystrokes with the first response's normalized form.
// Real component coverage (only fetch is scripted): mount the drawer with a
// deferred PATCH, type through the flight, and read what actually goes out.

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __drawerConfirmCalls: unknown[] | undefined;
}

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/ap/capture",
  matchMediaMatches: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ap/capture'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__drawerToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "../../../../lib/confirm") {
      const source =
        "export async function confirmDialog(options){(globalThis.__drawerConfirmCalls??=[]).push(options);return true}";
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
const { CaptureReviewDrawer } = await import("./CaptureReviewDrawer");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const REV0 = "2026-09-17T12:00:00.000000Z";
const REV1 = "2026-09-17T12:00:01.000000Z";
const REV2 = "2026-09-17T12:00:02.000000Z";

const CAPTURE_ID = "cap-test-1";

function initialDetail(invoiceNumber: string | null, priceVariance = false) {
  return {
    id: CAPTURE_ID,
    status: "needs_review",
    updatedAt: REV0,
    file_id: "file-1",
    original_filename: "scan.pdf",
    document_kind: "vendor_bill" as const,
    normalized: {
      vendorName: null,
      vendorTaxId: null,
      invoiceNumber,
      invoiceDate: "2026-09-01",
      dueDate: null,
      purchaseOrderNumber: null,
      currency: "USD",
      subtotal: "100.00",
      taxTotal: "0.00",
      total: "100.00",
      memo: null,
      lines: [],
    },
    validation_issues: priceVariance
      ? [
          {
            code: "po_price_variance",
            severity: "blocking" as const,
            field: "unitPrice",
            lineIndex: 0,
            expected: "10.00",
            actual: "11.00",
            message: "Price exceeds the order tolerance.",
          },
        ]
      : [],
    overall_confidence: null,
    vendor_candidate_id: null,
    purchase_order_id: priceVariance ? "po-1" : null,
    document_id: null,
    last_error: null,
    contentType: "application/pdf",
    sizeBytes: 10,
    resolvedVendor: null,
    purchaseOrderNumber: null,
    evidence: [],
  };
}

type SentSave = { normalized: { invoiceNumber: string | null }; expectedUpdatedAt: string };

async function mount(
  invoiceNumber: string | null,
  onPatch: (sent: SentSave[]) => void,
  options: { priceVariance?: boolean; canApprovePriceOverride?: boolean } = {},
) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__drawerConfirmCalls = [];
  const sent: SentSave[] = [];
  const materializeBodies: unknown[] = [];
  const pending: Array<(response: Response) => void> = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url === `/api/ap-capture/${CAPTURE_ID}` && init?.method === "PATCH") {
      sent.push(JSON.parse(String(init.body)) as SentSave);
      onPatch(sent);
      return new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    }
    if (url === `/api/ap-capture/${CAPTURE_ID}/materialize` && init?.method === "POST") {
      materializeBodies.push(init.body ? JSON.parse(String(init.body)) : null);
      return Response.json({ documentId: "draft-1" });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let finished = false;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CaptureReviewDrawer
          initial={initialDetail(invoiceNumber, options.priceVariance)}
          vendors={[]}
          accounts={[]}
          purchaseOrders={[]}
          canCreate
          canApprovePriceOverride={options.canApprovePriceOverride}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    sent,
    materializeBodies,
    respond(status: number, body: unknown) {
      const next = pending.shift();
      assert.ok(next, "a PATCH must be in flight to respond to");
      return act(async () => {
        next(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
        await tick(50);
      });
    },
    async done() {
      if (finished) return;
      finished = true;
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("price variance override requires approval permission and sends explicit confirmation", async (t) => {
  const denied = await mount("INV-OVERRIDE-DENIED", () => {}, { priceVariance: true });
  t.after(() => denied.done());
  assert.equal(
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Approve variance and create draft"),
    ),
    false,
  );

  await denied.done();
  const approved = await mount("INV-OVERRIDE", () => {}, {
    priceVariance: true,
    canApprovePriceOverride: true,
  });
  t.after(() => approved.done());
  const button = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Approve variance and create draft"),
  );
  assert.ok(
    button,
    "an approver can create a draft with only purchase-order price variance blocking",
  );
  await act(async () => {
    button.click();
    await tick();
  });
  assert.deepEqual(globalThis.__drawerConfirmCalls, [
    "This approves the purchase-order price variance for this bill and creates an AP draft. Continue?",
  ]);
  assert.deepEqual(approved.materializeBodies, [{ priceOverride: true }]);
});

function invoiceInput(value: string): HTMLInputElement {
  // The drawer renders through a portal to document.body, so query the whole
  // document rather than the mount host.
  const found = [...document.querySelectorAll("input")].find(
    (el) => (el as HTMLInputElement).value === value,
  );
  assert.ok(found, `an input holding ${JSON.stringify(value)} must exist`);
  return found as HTMLInputElement;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

/** Wait out the 800 ms autosave debounce. */
async function settleDebounce() {
  await act(async () => {
    await tick(950);
  });
  await tick(50);
}

function normalized(invoiceNumber: string | null, updatedAt: string) {
  return {
    normalized: {
      vendorName: null,
      vendorTaxId: null,
      invoiceNumber,
      invoiceDate: "2026-09-01",
      dueDate: null,
      purchaseOrderNumber: null,
      currency: "USD",
      subtotal: "100.00",
      taxTotal: "0.00",
      total: "100.00",
      memo: null,
      lines: [],
    },
    validationIssues: [],
    vendorId: null,
    purchaseOrderId: null,
    status: "needs_review",
    updatedAt,
  };
}

test("a slow first save neither 409s nor clobbers newer keystrokes", async (t) => {
  const drawer = await mount("INV-1", () => {});
  t.after(() => drawer.done());

  assert.ok(
    [
      "Document type",
      "Vendor",
      "Invoice number",
      "Invoice date",
      "Due date",
      "Currency",
      "Purchase order",
      "Memo",
    ].every((text) =>
      [...document.querySelectorAll("label")].some(
        (label) =>
          label.textContent?.trim() === text &&
          (label.htmlFor
            ? document.getElementById(label.htmlFor)
            : label.id && document.querySelector(`[aria-labelledby="${label.id}"]`)),
      ),
    ),
    "visible invoice labels name their controls",
  );

  await typeInto(invoiceInput("INV-1"), "INV-1a");
  await settleDebounce();
  assert.equal(drawer.sent.length, 1, "the debounce sends the first save");
  assert.equal(drawer.sent[0]!.normalized.invoiceNumber, "INV-1a");
  assert.equal(drawer.sent[0]!.expectedUpdatedAt, REV0);

  // Still typing while the first save is in flight: no second request may go
  // out — it would carry the stale revision and 409.
  await typeInto(invoiceInput("INV-1a"), "INV-1b");
  await settleDebounce();
  assert.equal(drawer.sent.length, 1, "no concurrent second save while one is in flight");

  // The slow first save returns a normalized form and a fresh revision.
  await drawer.respond(200, normalized("SERVER-N", REV1));
  await tick(150);
  assert.equal(drawer.sent.length, 2, "the newer keystrokes are persisted by a follow-up save");
  assert.equal(
    drawer.sent[1]!.expectedUpdatedAt,
    REV1,
    "the follow-up uses the adopted revision, not the stale one",
  );
  assert.equal(
    drawer.sent[1]!.normalized.invoiceNumber,
    "INV-1b",
    "newer keystrokes survive the first response",
  );

  await drawer.respond(200, normalized("SERVER-FINAL", REV2));
  await tick(150);
  assert.equal(drawer.sent.length, 2, "no retry storm once clean");
  assert.equal(
    invoiceInput("SERVER-FINAL").value,
    "SERVER-FINAL",
    "with nothing newer typed, the server normalization is adopted",
  );
});

test("a revision conflict surfaces the remedy once and pauses retries until the next edit", async (t) => {
  const drawer = await mount("INV-9", () => {});
  t.after(() => drawer.done());

  await typeInto(invoiceInput("INV-9"), "INV-9a");
  await settleDebounce();
  assert.equal(drawer.sent.length, 1);

  const remedy = "This capture changed after you opened it; reload and reapply your corrections";
  await drawer.respond(409, { error: remedy });
  await tick(100);
  const errors = (globalThis.__drawerToasts ?? []).filter((toast) => toast.kind === "error");
  assert.ok(
    errors.some((toast) => toast.message === remedy),
    `the server remedy must toast, got ${JSON.stringify(globalThis.__drawerToasts)}`,
  );

  await act(async () => {
    await tick(1200);
  });
  await tick(50);
  assert.equal(drawer.sent.length, 1, "no 409 retry storm while nothing new is typed");

  await typeInto(invoiceInput("INV-9a"), "INV-9b");
  await settleDebounce();
  assert.equal(drawer.sent.length, 2, "the next edit retries the save");
});
