import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __drawerPrompt: string | null | undefined;
}

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return \'/ap/bills\'}export function useSearchParams(){return new URLSearchParams()}' }, intl: false, authz: false, features: false });

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
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__drawerPrompt ?? null}",
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

const REASON = "approved the wrong bill batch";

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

async function mountBill(options: { status?: string; canPost?: boolean } = {}) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  globalThis.__drawerPrompt = undefined;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "vendor_bill",
    status: options.status ?? "approved",
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
            canPost={options.canPost ?? true}
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [{ key: "post", visible: true }] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return { host, root };
}

async function openActionsMenu() {
  const actions = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Actions"));
  assert.ok(actions, "Actions menu must render");
  await act(async () => {
    actions.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function returnToDraftButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Return to draft",
  ) as HTMLButtonElement | undefined;
}

async function clickReturnToDraft() {
  await openActionsMenu();
  const button = returnToDraftButton();
  assert.ok(button, "Return to draft must render in Actions");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

/** An approved, never-posted bill offers Return to draft beside Post/Void. */
test("an approved bill offers Return to draft in Actions", async (t) => {
  const restore = scriptFetch(() => null);
  t.after(restore);
  const { host, root } = await mountBill();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await openActionsMenu();
  assert.ok(returnToDraftButton(), "an approved bill must offer Return to draft");
});

/** Posted bills and unauthorized operators see no Return to draft. */
test("posted bills and unauthorized operators see no Return to draft", async (t) => {
  const restore = scriptFetch(() => null);
  t.after(restore);
  for (const options of [{ status: "posted" }, { status: "approved", canPost: false }] as const) {
    const { host, root } = await mountBill(options);
    try {
      await openActionsMenu();
      assert.ok(!returnToDraftButton(), `no Return to draft for ${JSON.stringify(options)}`);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

/** The reason prompt travels to the native action with the drawer revision. */
test("Return to draft posts the prompted reason with the drawer revision", async (t) => {
  const seen: { action: string; reason: string; expectedUpdatedAt: unknown }[] = [];
  const restore = scriptFetch((url, init) => {
    if (!url.endsWith("/api/documents/actions")) return null;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.action === "return_to_draft") {
      seen.push({ action: body.action, reason: body.reason, expectedUpdatedAt: body.expectedUpdatedAt });
      return Response.json({ ok: true, supersededRunIds: [] });
    }
    return null;
  });
  globalThis.__drawerPrompt = REASON;
  const { host, root } = await mountBill();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restore();
  });
  await clickReturnToDraft();
  assert.equal(seen.length, 1, "exactly one return_to_draft call posts");
  assert.equal(seen[0]!.reason, REASON);
  assert.ok(typeof seen[0]!.expectedUpdatedAt === "string" && (seen[0]!.expectedUpdatedAt as string).length > 0,
    "the drawer revision travels for optimistic concurrency");
  assert.ok((globalThis.__drawerToasts ?? []).some((toast) => toast.kind === "success"),
    "a success toast confirms the return");
  void doc;
});

/** A refused return pins the remedy as a drawer-header alert, not just a toast. */
test("a refused return persists its remedy as a drawer-header alert", async (t) => {
  const restore = scriptFetch((url, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}"));
    return url.endsWith("/api/documents/actions") && body.action === "return_to_draft"
      ? Response.json({ error: "BILL-00005 has live payment instructions against it — settle or cancel the payments before returning to draft", code: "applied" }, { status: 422 })
      : null;
  });
  globalThis.__drawerPrompt = REASON;
  const { host, root } = await mountBill();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restore();
  });
  await clickReturnToDraft();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refused return must persist a drawer-header alert");
  assert.match(alert.textContent ?? "", /settle or cancel the payments/i);
  const errors = (globalThis.__drawerToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the toast still fires alongside the persistent alert");
});
