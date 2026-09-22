import assert from "node:assert/strict";
import test from "node:test";

// The control surface for settling a credit without cash. The engine is proven
// against a real database in credit-settlement.integration.test.ts and the
// route in its own test; what is exercised here is the panel's own behaviour —
// what it renders for each state, and that Apply and Release send the request
// bodies those endpoints validate.
//
// Only the network is doubled. React, next-intl, the real English catalog and
// the real money formatter all run.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ar/invoices",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "Event", "self"]) {
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
void React;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { BusinessDateProvider } = await import("./business-date-provider");
const { CreditApplicationsPanel } = await import("./credit-applications-panel");

const DOC = "00000000-0000-4000-8000-0000000000c1";
const PARTY = "00000000-0000-4000-8000-0000000000c2";
const CREDIT_LINE = "00000000-0000-4000-8000-0000000000c3";
const INVOICE_LINE = "00000000-0000-4000-8000-0000000000c4";
const APPLICATION = "00000000-0000-4000-8000-0000000000c5";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * React ignores a plain `.value =`; the native setter is what it observes.
 * Both the setter and the event must come from JSDOM's own window — Node
 * supplies a global `Event` that this document will not dispatch as its own.
 */
const win = dom.window as unknown as Window & typeof globalThis;
function nativeSetValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

type Sent = { url: string; method: string; body: unknown };

/** Script the endpoints the panel talks to and record what it sent. */
function scriptFetch(
  routes: (url: string, method: string) => Response | null,
): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    sent.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return routes(url, method) ?? Response.json({});
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = prior; } };
}

const stateBody = (open: string, settlements: unknown[] = []) =>
  Response.json({
    state: {
      lineId: CREDIT_LINE,
      amount: "250.0000",
      applied: "0.0000",
      open,
      currency: "USD",
      settlements,
    },
  });

async function mount(canApply = true) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-17">
            <CreditApplicationsPanel
              documentId={DOC}
              side="ar"
              partyId={PARTY}
              canApply={canApply}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await tick(); });
  return { host, root };
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === label,
    ) as HTMLButtonElement | undefined
  ) ?? null;
}

test("a credit with nothing left and nothing settled renders nothing", async () => {
  const net = scriptFetch(() => stateBody("0.0000"));
  try {
    const { host, root } = await mount();
    assert.equal(host.textContent, "", "an exhausted credit must not show an empty panel");
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("an unposted credit renders nothing", async () => {
  // creditSettlementState returns null when no posted open-item line exists.
  const net = scriptFetch(() => Response.json({ state: null }));
  try {
    const { host, root } = await mount();
    assert.equal(host.textContent, "");
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("a credit this reader cannot see renders nothing instead of an error", async () => {
  const net = scriptFetch(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
  try {
    const { host, root } = await mount();
    assert.equal(host.textContent, "");
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("applying sends the credit's own line and the entered amount", async () => {
  const net = scriptFetch((url, method) => {
    if (url.includes("/api/payments/open-items")) {
      return Response.json({
        items: [
          {
            lineId: INVOICE_LINE,
            documentNumber: "INV-4001",
            entryNumber: "JE-1",
            dueDate: "2026-08-01",
            open: "400.0000",
            currency: "USD",
          },
        ],
      });
    }
    if (url.includes("/api/payments/credit-applications") && method === "POST") {
      return Response.json({ applicationIds: [APPLICATION], amount: "150.0000" });
    }
    return stateBody("250.0000");
  });
  try {
    const { host, root } = await mount();
    assert.match(host.textContent ?? "", /Credit applications/);
    assert.match(host.textContent ?? "", /250\.00 remaining/);

    await act(async () => { button(host, "Apply to open items")!.click(); });
    await act(async () => { await tick(); });
    assert.match(host.textContent ?? "", /INV-4001/, "the open item must be offered");

    const input = host.querySelector("input[type=number]") as HTMLInputElement;
    // React tracks the input's value node-side; assigning `.value` directly is
    // ignored, so drive it through the native setter the way the browser does.
    await act(async () => {
      nativeSetValue(input, "150");
    });
    await act(async () => { button(host, "Apply credit")!.click(); });
    await act(async () => { await tick(); });

    const posted = net.sent.find((s) => s.method === "POST");
    assert.ok(posted, "Apply must POST");
    assert.deepEqual(posted.body, {
      partyId: PARTY,
      side: "ar",
      // The application date has no input to correct it: it must be the org's
      // business day from the server, never the browser's UTC day.
      appliedOn: "2026-09-17",
      credits: [
        {
          fromLineId: CREDIT_LINE,
          toLineId: INVOICE_LINE,
          amount: "150",
          sourceDocumentId: DOC,
        },
      ],
    });
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("applying nothing is refused in the panel, without a request", async () => {
  const net = scriptFetch((url) => {
    if (url.includes("/api/payments/open-items")) {
      return Response.json({
        items: [
          {
            lineId: INVOICE_LINE, documentNumber: "INV-4002", entryNumber: "JE-2",
            dueDate: null, open: "90.0000", currency: "USD",
          },
        ],
      });
    }
    return stateBody("250.0000");
  });
  try {
    const { host, root } = await mount();
    await act(async () => { button(host, "Apply to open items")!.click(); });
    await act(async () => { await tick(); });
    await act(async () => { button(host, "Apply credit")!.click(); });
    await act(async () => { await tick(); });

    assert.equal(net.sent.filter((s) => s.method === "POST").length, 0);
    assert.match(host.textContent ?? "", /Enter an amount on at least one open item/);
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("a refused application shows the server's reason verbatim", async () => {
  const refusal = "AR is closed for this period and accounting book";
  const net = scriptFetch((url, method) => {
    if (url.includes("/api/payments/open-items")) {
      return Response.json({
        items: [
          {
            lineId: INVOICE_LINE, documentNumber: "INV-4003", entryNumber: "JE-3",
            dueDate: null, open: "90.0000", currency: "USD",
          },
        ],
      });
    }
    if (method === "POST") {
      return new Response(JSON.stringify({ error: refusal }), { status: 422 });
    }
    return stateBody("250.0000");
  });
  try {
    const { host, root } = await mount();
    await act(async () => { button(host, "Apply to open items")!.click(); });
    await act(async () => { await tick(); });
    const input = host.querySelector("input[type=number]") as HTMLInputElement;
    await act(async () => {
      nativeSetValue(input, "10");
    });
    await act(async () => { button(host, "Apply credit")!.click(); });
    await act(async () => { await tick(); });

    // The engine's refusal is the whole product of refusing; it must reach the
    // operator rather than being replaced by a generic failure.
    assert.match(host.textContent ?? "", new RegExp(refusal));
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("a settled credit lists what it paid and releases it by id", async () => {
  const net = scriptFetch((url, method) => {
    if (url.includes("/api/payments/credit-applications") && method === "DELETE") {
      return Response.json({ amount: "150.0000" });
    }
    return stateBody("100.0000", [
      {
        applicationId: APPLICATION,
        documentId: null,
        documentNumber: "INV-4001",
        documentKind: "customer_invoice",
        documentDate: "2026-07-01",
        amount: "150.0000",
        appliedOn: "2026-07-15",
      },
    ]);
  });
  try {
    const { host, root } = await mount();
    assert.match(host.textContent ?? "", /INV-4001/);
    assert.match(host.textContent ?? "", /2026-07-15/);

    await act(async () => { button(host, "Release")!.click(); });
    await act(async () => { await tick(); });
    const released = net.sent.find((s) => s.method === "DELETE");
    assert.ok(released, "Release must DELETE");
    assert.deepEqual(released.body, { applicationId: APPLICATION, side: "ar" });
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});

test("a reader without the pay permission sees the state but no controls", async () => {
  const net = scriptFetch(() =>
    stateBody("100.0000", [
      {
        applicationId: APPLICATION, documentId: null, documentNumber: "INV-4001",
        documentKind: "customer_invoice", documentDate: "2026-07-01",
        amount: "150.0000", appliedOn: "2026-07-15",
      },
    ]),
  );
  try {
    const { host, root } = await mount(false);
    assert.match(host.textContent ?? "", /INV-4001/);
    assert.equal(button(host, "Apply to open items"), null);
    assert.equal(button(host, "Release"), null);
    await act(async () => { root.unmount(); });
  } finally {
    net.restore();
  }
});
