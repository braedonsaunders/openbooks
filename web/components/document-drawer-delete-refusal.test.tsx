import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmCalls: unknown[] | undefined;
  var __confirmVerdict: boolean | undefined;
}

// A refused document delete toasted without pinning: once the toast went,
// the drawer sat unchanged with no reason on screen. Through useAppAction
// the refusal pins as a record-level alert until the next action AND toasts.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ar/invoices",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ar/invoices'}export function useSearchParams(){return new URLSearchParams()}",
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

test("a refused delete pins the reason instead of toasting into the void", async (t) => {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  globalThis.__confirmVerdict = true;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/documents/") && init?.method === "DELETE") {
      return Response.json({ error: "Draft has payments applied" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const doc = {
    id: randomUUID(),
    kind: "customer_invoice",
    status: "draft",
    document_number: "INV-00057",
    currency: "USD",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    subtotal: "100.00",
    tax_total: "0.00",
    total: "100.00",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{ doc, lines: [] }}
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
            segments={SEGMENTS}
            canCreate
            canPost
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [{ key: "delete", visible: true }] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const del = buttonsNamed("Delete")[0];
  assert.ok(del, "a draft invoice must offer Delete");
  await click(del);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the delete refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Draft has payments applied/, "the alert must carry the server reason");
  const toasts = globalThis.__drawerToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /payments applied/.test(toast.message)),
    "the delete refusal must also toast",
  );
});
