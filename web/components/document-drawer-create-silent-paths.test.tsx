import assert from "node:assert/strict";

import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmCalls: unknown[] | undefined;
}

// Every way an unsaved create's Save can end must reach the operator: a
// refusal names its reason, a dead connection keeps the entries and says so,
// and a success that names no record is refused rather than navigated or
// toasted. Each case also proves the form stays in create mode with Save
// released, so the operator can correct and retry.

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ar/invoices", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ar/invoices'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
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
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(o){(globalThis.__confirmCalls??=[]).push(o);return true}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
      };
    }
    if (specifier.endsWith("/lib/client-scripts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function runClientScripts(){return {ok:true,warnings:[]}}",
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
const PARTY_ID = "33333333-3333-4333-8333-333333333333";

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response> | null;

/** Routes fetch through one responder; a responder may throw to model a dead connection. */
function installFetch(responder: Responder) {
  const prior = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, init });
    if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
    return (await responder(url, init)) ?? Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

function blankCreateDoc() {
  return {
    id: "",
    kind: "customer_invoice",
    status: "draft",
    document_number: null,
    currency: "USD",
    party_id: PARTY_ID,
    party_name: "Meridian Dynamics",
    updated_at: "",
    document_date: "2026-09-17",
    reference_number: null,
    memo: null,
    subtotal: "100.00",
    tax_total: "0.00",
    total: "100.00",
  };
}

async function mountCreate() {
  const pushed: string[] = [];
  globalThis.__drawerRouter = {
    push(url: string) {
      pushed.push(url);
    },
    refresh() {},
  };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc: blankCreateDoc(),
              lines: [
                {
                  id: "",
                  account_id: "income-1",
                  item_id: null,
                  description: "Services",
                  quantity: "1",
                  unit_price: "100",
                  amount: "100.00",
                },
              ],
            }}
            config={DOC_KINDS["customer_invoice"]!}
            basePath="/ar/invoices"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            bankAccounts={[]}
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
            createMode
            initialMode="edit"
            layout={
              {
                header: { groups: [] },
                lines: { columns: [] },
                actions: [
                  { key: "submit", visible: true },
                  { key: "post", visible: true },
                ],
              } as never
            }
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return { host, root, pushed };
}

function saveButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll("button")].filter((b) =>
    ["Save", "Save draft"].includes(b.textContent?.trim() ?? ""),
  );
  assert.equal(buttons.length, 1, `exactly one Save button must render (saw ${buttons.length})`);
  return buttons[0] as HTMLButtonElement;
}

async function pressSave() {
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

function createPosts(calls: { url: string; init?: RequestInit }[]) {
  return calls.filter((call) => call.url === "/api/documents" && call.init?.method === "POST");
}

/** Shared assertions: the refusal pins beside the record, the drawer stays in create mode, Save releases. */
function assertStaysOnForm(pushed: string[], message: RegExp) {
  assert.deepEqual(pushed, [], "a refused or unconfirmed create must not navigate");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the outcome must pin an alert on the record");
  assert.match(alert.textContent ?? "", message);
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "error" && message.test(toast.message),
    ),
    "the outcome must also toast as an error",
  );
  assert.ok(
    !(globalThis.__drawerToasts ?? []).some((toast) => toast.kind === "success"),
    "no success toast may claim a document was saved",
  );
  assert.equal(saveButton().disabled, false, "Save must release so the operator can retry");
}

test("a server refusal of an untouched create shows its reason and keeps the form", async (t) => {
  const net = installFetch((url, init) => {
    if (url === "/api/documents" && init?.method === "POST") {
      return Response.json(
        { error: "A new document needs at least one line before it can be saved." },
        { status: 422 },
      );
    }
    return null;
  });
  t.after(net.restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressSave();
  assert.equal(createPosts(net.calls).length, 1, "the create is attempted exactly once");
  assertStaysOnForm(pushed, /needs at least one line before it can be saved/);
});

test("a dead connection during create keeps the entries and says the save is unconfirmed", async (t) => {
  const net = installFetch((url, init) => {
    if (url === "/api/documents" && init?.method === "POST") throw new TypeError("Failed to fetch");
    return null;
  });
  t.after(net.restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressSave();
  assertStaysOnForm(pushed, /connection failed before the save was confirmed/);
});

test("a 2xx create response that names no record is refused, never navigated or toasted", async (t) => {
  const net = installFetch((url, init) => {
    if (url === "/api/documents" && init?.method === "POST") return Response.json({});
    return null;
  });
  t.after(net.restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressSave();
  assertStaysOnForm(pushed, /did not confirm the new record/);
});

test("a 2xx create response with a blank record id is refused the same way", async (t) => {
  const net = installFetch((url, init) => {
    if (url === "/api/documents" && init?.method === "POST") {
      return Response.json(
        { doc: { id: "", document_number: null, status: "draft" }, lines: [] },
        { status: 201 },
      );
    }
    return null;
  });
  t.after(net.restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressSave();
  assertStaysOnForm(pushed, /did not confirm the new record/);
});

test("a retried create after a changed payload shows the localized reload remedy, not a raw token", async (t) => {
  const net = installFetch((url, init) => {
    if (url === "/api/documents" && init?.method === "POST") {
      return Response.json({ code: "document_create_conflict" }, { status: 409 });
    }
    return null;
  });
  t.after(net.restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressSave();
  assertStaysOnForm(pushed, /already saved with different details/);
  assert.doesNotMatch(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /document_create_conflict|invalid_idempotency_key/,
  );
});

test("an unsaved create offers no Submit or Post before the record exists", async (t) => {
  const net = installFetch(() => null);
  t.after(net.restore);
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const labels = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
  // Save & new and Post & new act only after the save has created the record.
  assert.ok(labels.includes("Save") || labels.includes("Save draft"), "create mode offers Save");
  assert.ok(
    !labels.some((label) => /^(Post|Submit for approval)$/.test(label)),
    `no lifecycle action may run before the record exists (saw: ${labels.join(" | ")})`,
  );
  assert.equal(createPosts(net.calls).length, 0, "rendering a create writes nothing");
});
