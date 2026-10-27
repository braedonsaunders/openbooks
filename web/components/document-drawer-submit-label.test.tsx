import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// Approvals are optional Flows. A saved draft's submit action is named for
// what it will do: "Submit for approval" when an approval flow would park
// the record, "Approve" when none applies and the same submission releases
// it directly.

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
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

async function mountDraftBill(submitRoutesForApproval: boolean | undefined) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const prior = globalThis.fetch;
  const actions: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.endsWith("/api/documents/actions")) {
      actions.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, requestId: null, autoApproved: true });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "vendor_bill",
    status: "draft",
    document_number: "BILL-00006",
    currency: "USD",
    party_id: randomUUID(),
    party_name: "usd vendor",
    updated_at: "2026-10-20T12:00:00.000000Z",
    document_date: "2026-10-20",
    subtotal: "200.00",
    tax_total: "0.00",
    total: "200.00",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc,
              lines: [{ id: randomUUID(), account_id: "supplies", amount: "200.00" }],
            }}
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
            {...(submitRoutesForApproval === undefined ? {} : { submitRoutesForApproval })}
            layout={
              {
                header: { groups: [] },
                lines: { columns: [] },
                actions: [{ key: "submit", visible: true }],
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
  return {
    actions,
    async done() {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = prior;
    },
  };
}

const buttonsNamed = (name: string) =>
  [...document.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement[];

test("a draft no approval flow governs offers Approve, which releases it through submit", async (t) => {
  const { actions, done } = await mountDraftBill(false);
  t.after(done);
  assert.equal(buttonsNamed("Submit for approval").length, 0);
  const [approve] = buttonsNamed("Approve");
  assert.ok(approve, "the header names the direct approval");
  assert.equal(approve.disabled, false);
  await act(async () => {
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.equal(actions.length, 1);
  assert.equal((actions[0] as { action: string }).action, "submit");
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message === "Approved",
    ),
    "the released draft is reported as approved, not as submitted",
  );
});

test("a draft an approval flow governs, or whose routing is unknown, offers Submit for approval", async () => {
  for (const routes of [true, undefined]) {
    const { done } = await mountDraftBill(routes);
    try {
      assert.equal(buttonsNamed("Submit for approval").length, 1, String(routes));
      assert.equal(buttonsNamed("Approve").length, 0, String(routes));
    } finally {
      await done();
    }
  }
});
