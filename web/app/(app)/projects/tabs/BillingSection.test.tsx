import assert from "node:assert/strict";
import test from "node:test";

// Billing actions must never wedge disabled or swallow the server's reason:
// the old submit/createInvoice/cancelRequest set busy, awaited fetch, and
// parsed the body before checking the status — a dead network left the
// buttons disabled forever, and a proxy HTML error page threw out as a
// parse error. All three now run on the shared action path (busy in a
// finally, ok-first read, refusal pinned beside the section). Real
// component coverage (only fetch and the router are scripted).

declare global {
  var __billingRouter: { push(url: string): void; refresh(): void } | undefined;
  var __billingToasts: { kind: string; message: string }[] | undefined;
}

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/projects?project=p1",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__billingRouter}export function usePathname(){return '/projects'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__billingToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__billingToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__billingToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { BillingSection } = await import("./BillingSection");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const REQUEST = {
  id: "11111111-1111-4111-8111-111111111111",
  requestNumber: "BR-1",
  invoiceType: "progress",
  basis: "draw_amount",
  drawAmount: null,
  startDate: null,
  cutoffDate: null,
  backupRequired: false,
  backupType: "none",
  status: "open",
  hasBackup: false,
  invoiceDocumentId: null,
  invoiceNumber: null,
  invoiceStatus: null,
  invoiceTotal: null,
  fieldTicketCount: 0,
};

function props() {
  return {
    projectId: "22222222-2222-4222-8222-222222222222",
    unbilled: { revenue: "0", cost: "0", hours: 0, timeEntryCount: 0, costLineCount: 0 },
    requests: [{ ...REQUEST }],
    fieldTickets: [],
    invoicing: {
      billingProcedure: "standard" as const,
      allowedBases: ["draw_amount"],
      defaultBasis: "draw_amount",
      backupRequired: false,
      backupType: "none",
      allowedBackupTypes: [],
      source: { basis: "", backupRequired: "", backupType: "", template: "" },
    },
    canManage: true,
    applicationPermissions: { canRead: false, canCreate: false, canApprove: false, canInvoice: false },
    applicationIncomeAccounts: [],
    formOpen: false,
    onFormOpenChange() {},
  };
}

async function mount(fetchImpl: typeof fetch) {
  globalThis.__billingRouter = { push() {}, refresh() {} };
  globalThis.__billingToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BillingSection {...props()} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    async done() {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function createInvoiceButton(host: HTMLElement): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Create invoice");
  assert.ok(found, "an open request must offer Create invoice");
  return found as HTMLButtonElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("a dead network releases the button and toasts the fallback", async (t) => {
  const drawer = await mount((async () => {
    throw new Error("network down");
  }) as typeof fetch);
  t.after(() => drawer.done());
  const button = createInvoiceButton(drawer.host);
  await click(button);
  assert.equal(button.disabled, false, "the button must not wedge disabled when fetch throws");
  const errors = (globalThis.__billingToasts ?? []).filter((toast) => toast.kind === "error");
  assert.ok(
    errors.some((toast) => toast.message === "Could not create invoice"),
    `the fallback must toast, got ${JSON.stringify(globalThis.__billingToasts)}`,
  );
});

test("a 422 pins the server reason beside the section", async (t) => {
  const reason = "This billing request has already been invoiced";
  const drawer = await mount((async () =>
    new Response(JSON.stringify({ error: reason }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
  t.after(() => drawer.done());
  const button = createInvoiceButton(drawer.host);
  await click(button);
  assert.equal(button.disabled, false, "the button must release after a refusal");
  const alert = drawer.host.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must pin beside the section, not live only in a toast");
  // \x5c is the backslash member: the class stays a regex literal with no
  // double-backslash run, so the escape ratchet keeps scanning it.
  assert.match(alert!.textContent ?? "", new RegExp(reason.replace(/[.*+?^${}()|[\]\x5c]/g, "\\$&")));
});

test("a created invoice navigates to its edit page", async (t) => {
  const drawer = await mount((async () =>
    Response.json({ documentId: "doc-9", documentNumber: "INV-9" })) as typeof fetch);
  t.after(() => drawer.done());
  let pushed = "";
  // Mutate (don't replace): the component captured this router object at render.
  globalThis.__billingRouter!.push = (url: string) => {
    pushed = url;
  };
  await click(createInvoiceButton(drawer.host));
  assert.equal(pushed, "/ar/invoices?doc=doc-9&mode=edit");
});
