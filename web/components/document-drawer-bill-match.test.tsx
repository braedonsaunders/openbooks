import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// An unsaved new-bill drawer probed GET /api/documents//bill-match with its
// blank id and logged a 404: matching links persisted bill lines to purchase
// orders, so there is nothing to match before the first save. The probe must
// run only for a persisted bill whose edit grant the role holds; a persisted
// draft keeps its candidates banner.

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

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

async function mountBill(doc: Record<string, unknown>, createMode: boolean) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            canPost={false}
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
            createMode={createMode}
            initialMode="edit"
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [] } as never}
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

const UNSAVED = {
  id: "",
  kind: "vendor_bill",
  status: "draft",
  document_number: null,
  currency: "USD",
  party_id: null,
  party_name: null,
  updated_at: "",
  document_date: "2026-09-17",
  due_date: null,
  subtotal: "0",
  tax_total: "0",
  total: "0",
};

test("an unsaved new bill never probes the match route", async (t) => {
  const probe = scriptFetch(() => null);
  t.after(probe.restore);
  const { host, root } = await mountBill({ ...UNSAVED }, true);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.ok(
    probe.calls.every((url) => !url.includes("/bill-match")),
    `no bill-match probe for doc=new (saw ${JSON.stringify(probe.calls)})`,
  );
});

test("a persisted draft bill still probes and shows its candidates banner", async (t) => {
  const billId = randomUUID();
  const probe = scriptFetch((url) => {
    if (url === `/api/documents/${billId}/bill-match`) {
      return Response.json({
        lines: [{ matched: false, candidates: [{ orderId: randomUUID() }] }],
      });
    }
    return null;
  });
  t.after(probe.restore);
  const { host, root } = await mountBill(
    {
      ...UNSAVED,
      id: billId,
      document_number: "BILL-00001",
      updated_at: "2026-09-17T12:00:00.000000Z",
    },
    false,
  );
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.ok(
    probe.calls.includes(`/api/documents/${billId}/bill-match`),
    "a persisted draft bill probes its match candidates",
  );
  const banner = [...document.querySelectorAll('[role="alert"]')].find((el) =>
    (el.textContent ?? "").includes("purchase order"),
  );
  assert.ok(banner, "match candidates surface the match banner beside the draft");
});
