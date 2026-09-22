import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmCalls: unknown[] | undefined;
  var __confirmVerdict: boolean | undefined;
}

// The save must round-trip the loader's stable line identity and must never
// send native conversion/capture evidence: the server re-attaches trusted
// evidence from its locked rows, so a description-only drawer save used to
// strip provenance and post received stock twice. Real component coverage
// (only the network is scripted): mount a converted bill line, save, and
// read the wire body the drawer actually sends — then answer with
// replacement identities and prove the next save follows them.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ap/bills",
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ap/bills'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__drawerToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(opts){(globalThis.__confirmCalls??=[]).push(opts);return globalThis.__confirmVerdict ?? true}",
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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

// Stable across renders, like the server-loaded picker arrays production
// passes (see document-drawer-dirty.test.tsx).
const SEGMENTS: never[] = [];

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function freshGlobals() {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  globalThis.__confirmVerdict = true;
}

test("a converted-bill save sends stable line identities and no native evidence", async (t) => {
  freshGlobals();
  const docId = randomUUID();
  const persistedLineId = randomUUID();
  const sourceLineId = randomUUID();
  const replacementLineId = randomUUID();
  const sentBodies: Record<string, unknown>[] = [];
  let revision = "2026-09-17T12:00:00.000000Z";
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/documents/${docId}` && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sentBodies.push(body);
      revision = "2026-09-17T12:00:01.000000Z";
      // Echo the saved row the way the loader does (snake_case, replacement
      // identity): the redraw must rebuild a priced row from it.
      const saved = ((body.lines ?? []) as Record<string, unknown>[])[0] ?? {};
      return Response.json({
        doc: { id: docId, updated_at: revision },
        lines: [
          {
            id: replacementLineId,
            account_id: saved.accountId,
            item_id: saved.itemId,
            description: saved.description,
            quantity: saved.quantity,
            unit: saved.unit,
            unit_price: saved.unitPrice,
            amount: saved.amount,
            stock_location_id: saved.stockLocationId,
            custom: {},
          },
        ],
      });
    }
    return null;
  });
  t.after(restoreFetch);

  const doc = {
    id: docId,
    kind: "vendor_bill",
    status: "draft",
    document_number: "BILL-00071",
    currency: "USD",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    subtotal: "8.00",
    tax_total: "0.00",
    total: "8.00",
  };
  const lines = [
    {
      id: persistedLineId,
      line_number: 1,
      account_id: randomUUID(),
      item_id: randomUUID(),
      description: "Widget",
      quantity: "4",
      unit: "ea",
      unit_price: "2",
      amount: "8",
      stock_location_id: randomUUID(),
      custom: {
        purchaseOrderLineId: sourceLineId,
        convertedFrom: { documentId: randomUUID(), lineId: sourceLineId, quantity: "4" },
      },
    },
  ];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{ doc, lines }}
            config={DOC_KINDS["vendor_bill"]!}
            basePath="/ap/bills"
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
            segments={SEGMENTS}
            canCreate
            canPost
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [] } as never}
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

  const edit = buttonsNamed("Edit")[0];
  assert.ok(edit, "a draft bill must offer Edit");
  await click(edit);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();

  assert.equal(sentBodies.length, 1, "one save must have been sent");
  const firstLines = (sentBodies[0]!.lines ?? []) as Record<string, unknown>[];
  assert.equal(firstLines.length, 1);
  assert.equal(firstLines[0]!.lineId, persistedLineId, "the save round-trips the loader line identity");
  const firstCustom = (firstLines[0]!.custom ?? {}) as Record<string, unknown>;
  assert.equal(firstCustom.purchaseOrderLineId, undefined, "native evidence is never sent");
  assert.equal(firstCustom.convertedFrom, undefined);
  assert.equal(firstCustom.apCaptureEvidence, undefined);

  // The redraw adopts the replacement identities: the next save follows them.
  const editAgain = buttonsNamed("Edit")[0];
  assert.ok(editAgain, "the saved bill must offer Edit again");
  await click(editAgain);
  const saveAgain = buttonsNamed("Save")[0];
  assert.ok(saveAgain, "edit mode must offer Save again");
  await click(saveAgain);
  await tick();
  assert.equal(sentBodies.length, 2, "the second save must have been sent");
  const secondLines = (sentBodies[1]!.lines ?? []) as Record<string, unknown>[];
  assert.equal(secondLines.length, 1);
  assert.equal(
    secondLines[0]!.lineId,
    replacementLineId,
    "after a save the editor follows the replacement identities",
  );
});
