import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({ url: "http://localhost:4800/admin/page-layouts" });
stubModules({ navigation: true, intl: false, authz: false, features: false });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { PaymentLinksPanel } = await import("./payment-links-panel");
const { LayoutDrawer } = await import("../app/(app)/admin/page-layouts/LayoutDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return { host, root };
}

async function unmount(t: test.TestContext, host: HTMLElement, root: { unmount(): void }) {
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
}

function scriptFetch(handler: (url: string, init?: RequestInit) => Response) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

const layout = {
  specVersion: 1,
  route: "/ar/invoices",
  layout: "list",
  header: [],
  body: [],
};

function layoutData() {
  return {
    route: "/ar/invoices",
    builtIn: layout,
    override: layout,
    overrideId: "layout-1",
    overrideScope: "org",
    fields: [],
    fieldsTruncated: false,
    unavailable: null,
    requiredSegments: [],
    segments: {},
  } as never;
}

test("payment-link load refusals stay visible when no providers were returned", async (t) => {
  const restoreFetch = scriptFetch((url) => {
    assert.match(url, /\/api\/payments\/links\?documentId=invoice-1/);
    return Response.json(
      { error: "Payment providers are temporarily unavailable" },
      { status: 503 },
    );
  });
  t.after(restoreFetch);
  const { host, root } = await mount(<PaymentLinksPanel documentId="invoice-1" canManage />);
  await unmount(t, host, root);
  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? "",
    /Payment providers are temporarily unavailable/,
  );
});

test("payment-link void refusals show the API reason and do not reload as if successful", async (t) => {
  let reads = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (init?.method === "DELETE") {
      return Response.json({ error: "This link has already been accepted" }, { status: 422 });
    }
    reads += 1;
    return Response.json({
      providers: ["stripe"],
      links: [
        {
          id: "link-1",
          token: "token-1",
          tokenState: "ok",
          provider: "stripe",
          amount: "12.00",
          surchargeAmount: "0.00",
          currency: "USD",
          status: "active",
          expiresOn: null,
          paidPaymentDocumentId: null,
        },
      ],
    });
  });
  t.after(restoreFetch);
  const { host, root } = await mount(<PaymentLinksPanel documentId="invoice-1" canManage />);
  await unmount(t, host, root);
  const voidButton = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Void",
  );
  assert.ok(voidButton, "an active link has a Void action");
  await act(async () => {
    voidButton.click();
    await tick();
  });
  assert.equal(reads, 1, "a refused void must not reload the still-active link");
  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? "",
    /This link has already been accepted/,
  );
});

test("layout history refusals show the server message instead of an empty history", async (t) => {
  const restoreFetch = scriptFetch((url) => {
    assert.match(url, /history=1/);
    return Response.json({ error: "History is not available to this role" }, { status: 403 });
  });
  t.after(restoreFetch);
  const { host, root } = await mount(<LayoutDrawer drawer={layoutData()} />);
  await unmount(t, host, root);
  const historyTab = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "History",
  );
  assert.ok(historyTab, "the layout drawer exposes its History tab");
  await act(async () => {
    historyTab.click();
    await tick();
  });
  assert.match(document.body.textContent ?? "", /History is not available to this role/);
  assert.doesNotMatch(document.body.textContent ?? "", /No saved versions/);
});

test("layout removal uses the selected personal scope and preserves the refusal", async (t) => {
  let deleteUrl = "";
  const restoreFetch = scriptFetch((url, init) => {
    if (init?.method === "DELETE") {
      deleteUrl = url;
      return Response.json({ error: "The personal layout is still in use" }, { status: 409 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.after(restoreFetch);
  const { host, root } = await mount(<LayoutDrawer drawer={layoutData()} />);
  await unmount(t, host, root);
  const scopes = document.body.querySelectorAll<HTMLInputElement>(
    'input[name="page-layout-scope"]',
  );
  assert.equal(scopes.length, 2, "the editor offers organization and personal scopes");
  await act(async () => {
    scopes[1]!.click();
  });
  const removeButton = [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Remove customization"),
  );
  assert.ok(removeButton, "an override can be removed");
  await act(async () => {
    removeButton.click();
    await tick();
  });
  assert.match(deleteUrl, /scope=user/, "removal follows the currently selected scope");
  assert.match(document.body.textContent ?? "", /The personal layout is still in use/);
});
