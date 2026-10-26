import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// A foreign-currency bill or invoice is entered in the shared drawer: with
// Multi-currency on, the header offers the organization's currencies, a new
// document follows the picked vendor's role currency until the operator
// chooses one, and the save names the currency so the document is written
// in it. With Multi-currency off the drawer offers nothing and names no
// currency, so the server keeps its base-currency default.

await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ap/bills'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

const { registerHooks } = await import("node:module");
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
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
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const US_VENDOR = "33333333-3333-4333-8333-333333333333";
const LOCAL_VENDOR = "44444444-4444-4444-8444-444444444444";
const SAVED_ID = "55555555-5555-4555-8555-555555555555";
const CURRENCIES = [
  { value: "CAD", label: "CAD · Canadian Dollar" },
  { value: "EUR", label: "EUR · Euro" },
  { value: "USD", label: "USD · US Dollar" },
];
const PARTIES = [
  { id: US_VENDOR, display_name: "Harbor Freight Lines", currency: "USD" },
  { id: LOCAL_VENDOR, display_name: "Northside Supply", currency: null },
];

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  const writes: { url: string; method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (init?.method === "POST" || init?.method === "PATCH") {
      writes.push({
        url,
        method: init.method,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
    }
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return {
    writes,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

function savedBill(currency: string) {
  return {
    doc: {
      id: SAVED_ID,
      kind: "vendor_bill",
      status: "draft",
      document_number: "BILL-00007",
      currency,
      party_id: US_VENDOR,
      updated_at: "2026-10-26T12:00:01.000000Z",
      document_date: "2026-10-26",
      subtotal: "250.00",
      tax_total: "0.00",
      total: "250.00",
    },
    lines: [],
  };
}

async function mountBill(
  t: test.TestContext,
  {
    currencyOptions,
    doc = {},
    createMode = true,
  }: {
    currencyOptions?: { value: string; label: string }[];
    doc?: Record<string, unknown>;
    createMode?: boolean;
  },
) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <DocumentDrawer
            payload={{
              doc: {
                id: "",
                kind: "vendor_bill",
                status: "draft",
                document_number: null,
                currency: "CAD",
                party_id: null,
                party_name: null,
                updated_at: "",
                document_date: "2026-10-26",
                reference_number: null,
                memo: null,
                subtotal: "250.00",
                tax_total: "0.00",
                total: "250.00",
                ...doc,
              },
              lines: [
                {
                  id: "",
                  account_id: "expense-1",
                  item_id: null,
                  description: "Freight",
                  quantity: "1",
                  unit_price: "250",
                  amount: "250.00",
                },
              ],
            }}
            config={DOC_KINDS["vendor_bill"]!}
            basePath="/ap/bills"
            parties={PARTIES}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            canCreate
            canPost
            createMode={createMode}
            initialMode="edit"
            currencyOptions={currencyOptions}
            layout={
              {
                header: {
                  groups: [
                    {
                      id: "main",
                      label: "",
                      fields: [{ key: "party_id", visible: true, required: true }],
                    },
                  ],
                },
                lines: { columns: [] },
                actions: [],
              } as never
            }
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
}

/** The control a field label names, or null when the label is absent. */
function controlFor(label: string): HTMLButtonElement | null {
  const element = [...document.querySelectorAll("label")].find(
    (node) => node.textContent?.replace("*", "").trim() === label,
  );
  const id = element?.getAttribute("for");
  return id ? (document.getElementById(id) as HTMLButtonElement | null) : null;
}

async function choose(label: string, optionText: string) {
  const trigger = controlFor(label);
  assert.ok(trigger, `the ${label} picker must render`);
  await act(async () => {
    trigger.click();
    await tick();
  });
  const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
    (node.textContent ?? "").includes(optionText),
  ) as HTMLElement | undefined;
  assert.ok(option, `${label} must offer ${optionText}`);
  await act(async () => {
    option.click();
    await tick();
  });
}

async function save() {
  const button = [...document.querySelectorAll("button")].find((node) =>
    ["Save", "Save draft"].includes(node.textContent?.trim() ?? ""),
  );
  assert.ok(button, "the drawer must offer Save");
  await act(async () => {
    button.click();
    await tick();
  });
  await tick();
  await tick();
}

const createWrites = (writes: { url: string; method: string; body: Record<string, unknown> }[]) =>
  writes.filter((write) => write.url === "/api/documents" && write.method === "POST");

test("with Multi-currency off the drawer offers no currency and the save names none", async (t) => {
  const fetches = scriptFetch((url) =>
    url === "/api/documents" ? Response.json(savedBill("CAD"), { status: 201 }) : null,
  );
  t.after(fetches.restore);
  await mountBill(t, {});
  assert.equal(controlFor("Currency"), null, "no currency field without Multi-currency");
  await choose("Vendor", "Harbor Freight Lines");
  await save();
  const [create] = createWrites(fetches.writes);
  assert.ok(create, "the bill must be created");
  assert.equal(Object.hasOwn(create.body, "currency"), false);
});

test("picking a vendor with a role currency sets it and the create names it", async (t) => {
  const fetches = scriptFetch((url) =>
    url === "/api/documents" ? Response.json(savedBill("USD"), { status: 201 }) : null,
  );
  t.after(fetches.restore);
  await mountBill(t, { currencyOptions: CURRENCIES });
  const currency = controlFor("Currency");
  assert.ok(currency, "Multi-currency offers the currency field");
  assert.match(currency.textContent ?? "", /CAD/, "a new bill opens in the base currency");
  await choose("Vendor", "Harbor Freight Lines");
  assert.match(controlFor("Currency")?.textContent ?? "", /USD/);
  await choose("Vendor", "Northside Supply");
  assert.match(
    controlFor("Currency")?.textContent ?? "",
    /CAD/,
    "a vendor without a role currency returns the bill to the base currency",
  );
  await choose("Vendor", "Harbor Freight Lines");
  await save();
  const [create] = createWrites(fetches.writes);
  assert.ok(create, "the bill must be created");
  assert.equal(create.body.kind, "vendor_bill");
  assert.equal(create.body.currency, "USD");
});

test("an explicitly chosen currency is kept when the vendor changes", async (t) => {
  const fetches = scriptFetch((url) =>
    url === "/api/documents" ? Response.json(savedBill("EUR"), { status: 201 }) : null,
  );
  t.after(fetches.restore);
  await mountBill(t, { currencyOptions: CURRENCIES });
  await choose("Currency", "EUR");
  await choose("Vendor", "Harbor Freight Lines");
  assert.match(controlFor("Currency")?.textContent ?? "", /EUR/);
  await save();
  assert.equal(createWrites(fetches.writes)[0]?.body.currency, "EUR");
});

test("a saved draft names its currency only when it changes, and a refusal is shown", async (t) => {
  const fetches = scriptFetch((url, init) =>
    url === `/api/documents/${SAVED_ID}` && init?.method === "PATCH"
      ? Response.json({ error: "invalid currency" }, { status: 422 })
      : null,
  );
  t.after(fetches.restore);
  await mountBill(t, {
    currencyOptions: CURRENCIES,
    createMode: false,
    doc: savedBill("USD").doc,
  });
  await choose("Currency", "EUR");
  await save();
  const patches = fetches.writes.filter((write) => write.method === "PATCH");
  assert.equal(patches.length, 1, "the save sends one document write");
  assert.equal(patches[0]!.body.currency, "EUR");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refused save pins its reason on the record");
  assert.match(alert.textContent ?? "", /invalid currency/);
});
