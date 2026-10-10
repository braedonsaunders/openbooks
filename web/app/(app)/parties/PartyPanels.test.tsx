// Customer drawer → Payment methods: the methods and autopay sub-tabs use the
// shared sublist composition, add methods from a drawer, and treat a
// customer without methods as an empty state with its remedy.
import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

// jsdom first: the panels read browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/parties", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}" +
      "export function usePathname(){return '/parties'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}",
    sonner: "export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { PartyPaymentMethodsPanel } = await import("./PartyPaymentMethodsPanel");
const { PartyAutopayPanel } = await import("./PartyAutopayPanel");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function msg(path: string): string {
  let node: unknown = messages;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`missing message ${path}`);
  return node;
}
const AUTOPAY = (key: string) => msg(`parties.drawer.autopay.${key}`);

const ACTIVE_METHOD = {
  id: "method-1", provider: "stripe", providerCustomerId: null, providerMethodId: null,
  brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030, mandateReference: null,
  isDefault: true, fallbackPriority: 0, createdAt: "2026-09-01T00:00:00Z", status: "active",
};

const SETUP_OPTIONS = {
  currencies: [{ value: "CAD", label: "CAD · Canadian Dollar" }, { value: "USD", label: "USD · US Dollar" }],
  defaultCurrency: "CAD",
  providers: ["stripe"],
  recipients: [
    { email: "ap@northwind.test", name: "Northwind Traders", source: "party" },
    { email: "dana@northwind.test", name: "Dana Billing", source: "contact" },
  ],
  emailConfigured: true,
};

type Route = (init?: RequestInit) => Response;

function stubFetch(calls: Array<{ url: string; init?: RequestInit }>, routes: Record<string, Route> = {}) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const route = routes[`${method} ${path}`];
    if (route) return route(init);
    if (path === "/api/autopay/methods") return Response.json({ methods: [] });
    if (path === "/api/autopay/enrollments") return Response.json({ enrollments: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = priorFetch;
  };
}

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
  return {
    host,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function button(name: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((element) => element.textContent?.trim() === name) as HTMLButtonElement | undefined;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("the methods panel loads methods without touching enrollments", async (t) => {
  const calls: Array<{ url: string }> = [];
  t.after(stubFetch(calls));
  const mounted = await mount(<PartyPaymentMethodsPanel partyId="party-1" canManageMethods />);
  t.after(() => mounted.cleanup());

  assert.ok(calls.some(({ url }) => url.includes("/api/autopay/methods")), "the methods panel must load stored methods");
  assert.ok(!calls.some(({ url }) => url.includes("/api/autopay/enrollments")), "the methods panel must not load autopay enrollments");
  assert.doesNotMatch(mounted.host.textContent ?? "", /Autopay/, "the methods panel must not render enrollment copy");
});

test("payment methods follow the sublist archetype: add top right, full-width search, no inline add form", async (t) => {
  const calls: Array<{ url: string }> = [];
  t.after(stubFetch(calls, { "GET /api/autopay/methods": () => Response.json({ methods: [ACTIVE_METHOD] }) }));
  const mounted = await mount(<PartyPaymentMethodsPanel partyId="party-1" canManageMethods />);
  t.after(() => mounted.cleanup());

  const section = mounted.host.querySelector("[data-drawer-sublist]");
  assert.ok(section, "the panel renders the shared sublist");
  const header = section.firstElementChild!;
  const action = header.querySelector("[data-sublist-action]");
  assert.ok(action, "the add action sits in the header row");
  assert.equal(header.lastElementChild, action, "the add action is the header's trailing (top-right) element");
  assert.ok(!header.className.includes("flex-wrap"), "the header never wraps the action under the heading");
  assert.equal(action.textContent?.trim(), AUTOPAY("addMethod"));

  const search = section.querySelector("[data-sublist-search]");
  assert.ok(search, "the list offers a search");
  assert.ok(search.className.split(/\s+/).includes("flex-1"), "the search stretches across the toolbar");
  assert.ok(search.querySelector("input")!.className.split(/\s+/).includes("w-full"), "the search input fills its column");
  assert.ok(section.querySelector("table"), "methods render as a full-width table");
  assert.ok(mounted.host.textContent?.includes("Visa •••• 4242"));

  const inputs = [...mounted.host.querySelectorAll("input")];
  assert.equal(inputs.length, 1, "the only input in the list body is the search — no inline add row");
  assert.equal(button(AUTOPAY("sendSetupLink"), mounted.host), undefined, "sending a setup link lives in the add drawer");
});

test("the add drawer picks an enabled currency, names the recipient and states what is sent", async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.after(stubFetch(calls, {
    "GET /api/autopay/methods/setup-options": () => Response.json(SETUP_OPTIONS),
    "POST /api/autopay/methods": () => Response.json({
      methodId: "method-2", setupUrl: "/pay/setup/abc", redirectUrl: "https://provider.test/x",
      delivery: { status: "sent", recipient: "dana@northwind.test" },
    }),
  }));
  const mounted = await mount(<PartyPaymentMethodsPanel partyId="party-1" canManageMethods />);
  t.after(() => mounted.cleanup());

  const empty = mounted.host.querySelector("[data-sublist-empty]");
  assert.ok(empty, "no methods is an empty state, not an error");
  assert.equal(mounted.host.querySelector('[role="alert"]'), null);

  await click(button(AUTOPAY("addMethod"), mounted.host.querySelector("[data-sublist-action]")!)!);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "Add payment method opens a drawer");
  assert.ok(dialog.textContent?.includes(AUTOPAY("addTitle")));

  const selects = [...dialog.querySelectorAll("select")] as HTMLSelectElement[];
  const currency = selects.find((select) => [...select.options].some((option) => option.value === "USD"));
  assert.ok(currency, "currency is a select");
  assert.deepEqual([...currency.options].map((option) => option.value), ["CAD", "USD"], "the select offers exactly the enabled currencies");
  assert.equal(currency.value, "CAD", "the customer's currency is preselected");
  assert.ok(
    ![...dialog.querySelectorAll("input")].some((input) => !(input as HTMLInputElement).readOnly),
    "no free-text field: currency, provider and recipient are all pickers",
  );

  const recipient = selects.find((select) => [...select.options].some((option) => option.value === "dana@northwind.test"))!;
  assert.ok(recipient, "the recipient picker lists the customer's addresses");
  const send = button(AUTOPAY("sendSetupLink"), dialog)!;
  assert.ok(send.disabled, "sending waits for a recipient");
  await act(async () => {
    setSelect(recipient, "dana@northwind.test");
    setSelect(currency, "USD");
    await tick();
  });
  assert.ok(
    dialog.querySelector("[data-setup-summary]")?.textContent?.includes("dana@northwind.test"),
    "the drawer states who receives the link",
  );
  await click(button(AUTOPAY("sendSetupLink"), dialog)!);

  const post = calls.find(({ url, init }) => url === "/api/autopay/methods" && init?.method === "POST");
  assert.ok(post, "submitting posts one setup request");
  assert.deepEqual(JSON.parse(String(post.init!.body)), {
    partyId: "party-1", provider: "stripe", currency: "USD", recipientEmail: "dana@northwind.test",
  });
  assert.ok(document.body.textContent?.includes("Setup link sent to dana@northwind.test."), "the drawer confirms delivery");
});

test("the autopay sub-tab reads its enrollments and the methods it charges", async (t) => {
  const calls: Array<{ url: string }> = [];
  t.after(stubFetch(calls));
  const mounted = await mount(<PartyAutopayPanel partyId="party-1" canManageAutopay />);
  t.after(() => mounted.cleanup());
  assert.ok(calls.some(({ url }) => url.includes("/api/autopay/enrollments")));
  assert.ok(calls.some(({ url }) => url.includes("/api/autopay/methods")));
  assert.match(mounted.host.textContent ?? "", /Autopay/, "the autopay panel keeps the enrollment heading");
});

test("autopay without a payment method is an empty state with the remedy, never an error", async (t) => {
  t.after(stubFetch([], { "GET /api/autopay/methods/setup-options": () => Response.json(SETUP_OPTIONS) }));
  const mounted = await mount(<PartyAutopayPanel partyId="party-1" canManageAutopay canManageMethods />);
  t.after(() => mounted.cleanup());

  assert.equal(mounted.host.querySelector('[role="alert"]'), null, "no methods is not a failure");
  assert.doesNotMatch(mounted.host.textContent ?? "", new RegExp(AUTOPAY("loadFailed")));
  const empty = mounted.host.querySelector("[data-sublist-empty]");
  assert.ok(empty?.textContent?.includes(AUTOPAY("needsMethodTitle")), "the empty state says to add a payment method first");
  assert.equal(button(AUTOPAY("enroll"), mounted.host), undefined, "autopay cannot be turned on without a method");
  const remedy = button(AUTOPAY("addMethod"), empty!);
  assert.ok(remedy, "the empty state carries the add action");
  await click(remedy);
  assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes(AUTOPAY("addTitle")), "the remedy opens the add drawer");
});

test("a real autopay load failure names the server's reason", async (t) => {
  t.after(stubFetch([], {
    "GET /api/autopay/enrollments": () => Response.json({ error: "autopay is not enabled for this organization" }, { status: 403 }),
  }));
  const mounted = await mount(<PartyAutopayPanel partyId="party-1" canManageAutopay />);
  t.after(() => mounted.cleanup());
  const alert = mounted.host.querySelector('[role="alert"]');
  assert.ok(alert, "a refused read is an error");
  assert.match(alert.textContent ?? "", /autopay is not enabled for this organization/);
});

test("with an active method, turning autopay on opens a drawer from the top-right action", async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.after(stubFetch(calls, {
    "GET /api/autopay/methods": () => Response.json({ methods: [ACTIVE_METHOD] }),
    "POST /api/autopay/enrollments": () => Response.json({ enrollment: { id: "enrollment-1" } }),
  }));
  const mounted = await mount(<PartyAutopayPanel partyId="party-1" canManageAutopay />);
  t.after(() => mounted.cleanup());
  const action = mounted.host.querySelector("[data-sublist-action]");
  assert.equal(action?.textContent?.trim(), AUTOPAY("enroll"));
  await click(button(AUTOPAY("enroll"), action!)!);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "turning autopay on asks in a drawer");
  await click(button(AUTOPAY("enroll"), dialog)!);
  const post = calls.find(({ url, init }) => url === "/api/autopay/enrollments" && init?.method === "POST");
  assert.deepEqual(JSON.parse(String(post?.init?.body)), { partyId: "party-1", chargeOnIssue: false });
});
