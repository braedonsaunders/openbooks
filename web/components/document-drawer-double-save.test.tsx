import assert from "node:assert/strict";
import test from "node:test";

// Save cannot be double-clicked into a duplicate write: save awaits the
// client-script gate (up to 2 s) before execute sets busy, so two rapid
// clicks used to send two PATCHes with the same revision — the second
// 409ing after the first succeeded and pinning its conflict over the
// success. The shared runExclusive guard flips synchronously at click time
// and covers the whole preamble, so the second click sends nothing. Real
// component coverage (only fetch is scripted, deferred to hold the race
// open): double-click Save, resolve the one in flight, count the writes.

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmCalls: unknown[] | undefined;
  var __confirmVerdict: boolean | undefined;
}

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
        url: "data:text/javascript,export async function confirmDialog(o){(globalThis.__confirmCalls??=[]).push(o);return globalThis.__confirmVerdict!==false}",
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
const { randomUUID } = await import("node:crypto");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const SEGMENTS: never[] = [];
const REV0 = "2026-09-17T12:00:00.000000Z";
const REV1 = "2026-09-17T12:00:01.000000Z";

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

test("double-clicking Save sends one write with the loaded revision", async (t) => {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  globalThis.__confirmVerdict = true;
  const writes: { revision: string }[] = [];
  const pending: Array<(response: Response) => void> = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith("/api/documents/") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { expectedUpdatedAt?: string };
      writes.push({ revision: String(body.expectedUpdatedAt) });
      return new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    }
    return Response.json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });

  const doc = {
    id: randomUUID(),
    kind: "customer_invoice",
    status: "draft",
    document_number: "INV-00057",
    currency: "USD",
    updated_at: REV0,
    document_date: "2026-09-17",
    subtotal: "100.00",
    tax_total: "0.00",
    total: "100.00",
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
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
  assert.ok(edit, "a draft invoice must offer Edit");
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  // Two clicks in the same tick, before the first save's preamble settles:
  // the second must be dropped, not sent with the same revision.
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  await tick();
  assert.equal(writes.length, 1, `one double-click must send one write, sent ${writes.length}`);
  assert.equal(writes[0]!.revision, REV0, "the write carries the loaded revision");

  const resolve = pending.shift();
  assert.ok(resolve, "the single write must be in flight");
  await act(async () => {
    resolve(
      new Response(JSON.stringify({ doc: { ...doc, updated_at: REV1 }, lines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await tick();
    await tick();
  });
  await tick();
  assert.equal(writes.length, 1, "the success must not trigger a retry write");
  const alerts = [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "");
  assert.ok(
    !alerts.some((text) => /conflict|409|revision/i.test(text)),
    `no conflict may pin over the success, got ${JSON.stringify(alerts)}`,
  );
  // The success returns the drawer to view mode: Save unmounts, Edit returns,
  // and busy released with it.
  assert.equal(buttonsNamed("Edit").length, 1, "the success must return to view mode");
});
