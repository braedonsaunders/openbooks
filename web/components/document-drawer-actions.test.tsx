import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

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

const AP_CLOSED = "AP is closed for this period and accounting book";

function scriptFetch(handler: (url: string) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountApprovedBill() {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "vendor_bill",
    status: "approved",
    document_number: "BILL-00005",
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
            canCreate
            canPost
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [{ key: "post", visible: true }] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  // Let mount-time panel fetches settle outside act (same discipline as the
  // row-actions suite: a rejection escaping a handler must not poison act).
  await tick();
  await tick();
  return { host, root };
}

function postButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Post",
  );
  assert.equal(buttons.length, 1, `exactly one Post button must render (saw ${buttons.length})`);
  return buttons[0] as HTMLButtonElement;
}

async function clickPost() {
  // The record actions live behind the Actions popover.
  // The drawer shell portals to document.body, outside the mount host.
  const labels = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
  const actions = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"));
  assert.ok(actions, `Actions menu must render (buttons: ${JSON.stringify(labels)})`);
  await act(async () => {
    actions.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  const post = postButton();
  await act(async () => {
    post.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

/** Posting-refusal persistence: the typed 422 reason must persist as a
 * drawer-header role=alert until the next action, in addition to the toast. */
test("a 422 post refusal persists as a drawer-header alert", async (t) => {
  const restore = scriptFetch((url) =>
    url.endsWith("/api/documents/actions")
      ? Response.json({ error: AP_CLOSED }, { status: 422 })
      : null,
  );
  const { host, root } = await mountApprovedBill();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restore();
  });
  await clickPost();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refused post must persist a drawer-header alert");
  assert.match(alert.textContent ?? "", /AP is closed/i);
  const errors = (globalThis.__drawerToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the toast still fires alongside the persistent alert");
});
