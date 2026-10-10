import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmNext: boolean | undefined;
  var __confirmCalls: unknown[] | undefined;
}

// Saving a NEW invoice gave no success state — the drawer pushed back into
// edit mode with the editing caption and needed a second save before Submit
// appeared, so operators re-entered invoices. A create save now lands on the
// persisted record in view mode with a saved toast, and a possible duplicate
// warns (with the existing number linked) before the write — confirming
// still saves.

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ar/invoices", matchMediaMatches: false });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return \'/ar/invoices\'}export function useSearchParams(){return new URLSearchParams()}' }, intl: false, authz: false, features: false });

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
        url: "data:text/javascript,export async function confirmDialog(o){(globalThis.__confirmCalls??=[]).push(o);const next=globalThis.__confirmNext;globalThis.__confirmNext=undefined;return next??true}",
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
const PARTY_ID = "33333333-3333-4333-8333-333333333333";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = prior; } };
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
    push(url: string) { pushed.push(url); },
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
                  id: "", account_id: "income-1", item_id: null, description: "Services",
                  quantity: "1", unit_price: "100", amount: "100.00",
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
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [{ key: "submit", visible: true }] } as never}
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
  const buttons = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Save",
  );
  assert.equal(buttons.length, 1, `exactly one Save button must render (saw ${buttons.length})`);
  return buttons[0] as HTMLButtonElement;
}

test("create save lands on the persisted record in view mode with a saved toast", async (t) => {
  const savedId = randomUUID();
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
      if (url === "/api/documents") {
        return Response.json({
          doc: {
            id: savedId, kind: "customer_invoice", status: "draft", document_number: "INV-00004",
            currency: "USD", party_id: PARTY_ID, updated_at: "2026-09-17T12:00:01.000000Z",
            document_date: "2026-09-17", subtotal: "100.00", tax_total: "0.00", total: "100.00",
          },
          lines: [],
        });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "create save must POST the collection once",
  );
  assert.deepEqual(pushed, [`/ar/invoices?doc=${savedId}`], "create save must land on the record in view mode, not back in edit mode");
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("INV-00004"),
    ),
    "create save must toast the allocated document number",
  );
});

test("a possible duplicate warns with the existing number and cancelling keeps the draft", async (t) => {
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) {
        assert.ok(url.includes("kind=customer_invoice"), `probe names the kind: ${url}`);
        assert.ok(url.includes(`partyId=${PARTY_ID}`), `probe names the party: ${url}`);
        return Response.json({ duplicates: [{ id: "existing-1", documentNumber: "INV-00001" }] });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  globalThis.__confirmNext = false;
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const dialogs = (globalThis.__confirmCalls ?? []) as { title?: unknown; confirmLabel?: unknown }[];
  assert.equal(dialogs.length, 1, "a match must raise the duplicate confirm");
  assert.equal(dialogs[0]?.title, "Possible duplicate");
  assert.equal(dialogs[0]?.confirmLabel, "Save anyway");
  assert.ok(
    !calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "declining the warning must not write",
  );
});

test("edit-save of a draft lands in view mode with Submit and a saved toast", async (t) => {
  const docId = randomUUID();
  const restore = scriptFetch((url, init) => {
    if (url === `/api/documents/${docId}` && init?.method === "PATCH") {
      return Response.json({
        doc: {
          id: docId, kind: "customer_invoice", status: "draft", document_number: "INV-00004",
          currency: "USD", party_id: PARTY_ID, updated_at: "2026-09-17T12:00:01.000000Z",
          document_date: "2026-09-17", subtotal: "100.00", tax_total: "0.00", total: "100.00",
        },
        lines: [],
      });
    }
    return null;
  }).restore;
  t.after(restore);
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    ...blankCreateDoc(),
    id: docId,
    document_number: null,
    updated_at: "2026-09-17T12:00:00.000000Z",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc,
              lines: [
                {
                  id: "", account_id: "income-1", item_id: null, description: "Services",
                  quantity: "1", unit_price: "100", amount: "100.00",
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
            initialMode="edit"
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [{ key: "submit", visible: true }] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const body = document.body.textContent ?? "";
  assert.ok(
    !body.includes("Editing — Save to apply changes."),
    "a saved draft must leave edit mode",
  );
  const actionsMenu = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"));
  assert.ok(actionsMenu, "Actions menu must render");
  await act(async () => {
    actionsMenu.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.ok(
    [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Submit for approval"),
    "Submit must be available without a second save",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("INV-00004"),
    ),
    "edit save must toast the document number",
  );
});

test("confirming the duplicate warning saves anyway", async (t) => {
  const savedId = randomUUID();
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) {
        return Response.json({ duplicates: [{ id: "existing-1", documentNumber: "INV-00001" }] });
      }
      if (url === "/api/documents") {
        return Response.json({
          doc: {
            id: savedId, kind: "customer_invoice", status: "draft", document_number: "INV-00004",
            currency: "USD", party_id: PARTY_ID, updated_at: "2026-09-17T12:00:01.000000Z",
            document_date: "2026-09-17", subtotal: "100.00", tax_total: "0.00", total: "100.00",
          },
          lines: [],
        });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  globalThis.__confirmNext = true;
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "confirming the warning must proceed with the save",
  );
});
