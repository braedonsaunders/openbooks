import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// An empty posting date posts on the document date, so the drawer says so
// under the blank input before posting; an explicit date needs no hint.

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

const LAYOUT = {
  header: {
    groups: [
      {
        id: "primary",
        label: null,
        fields: [
          {
            key: "posting_date",
            visible: true,
            required: null,
            labelOverride: null,
            colSpan: null,
          },
        ],
      },
    ],
  },
  lines: { columns: [] },
  actions: [],
} as never;

const UNSAVED_INVOICE = {
  id: "",
  kind: "customer_invoice",
  status: "draft",
  document_number: null,
  currency: "USD",
  party_id: null,
  party_name: null,
  updated_at: "",
  document_date: "2026-11-15",
  due_date: null,
  subtotal: "0",
  tax_total: "0",
  total: "0",
};

async function mountInvoice(doc: Record<string, unknown>) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
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
            createMode
            initialMode="edit"
            layout={LAYOUT}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    host,
    root,
    done: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("a blank posting date shows the document date it will post on", async (t) => {
  const mounted = await mountInvoice({ ...UNSAVED_INVOICE });
  t.after(mounted.done);
  const hint = [...document.querySelectorAll("p")].find((el) =>
    (el.textContent ?? "").includes("Posts 2026-11-15 when empty"),
  );
  assert.ok(hint, "the drawer names the effective posting date before posting");
});

test("an explicit posting date shows no fallback hint", async (t) => {
  const mounted = await mountInvoice({ ...UNSAVED_INVOICE, posting_date: "2026-11-20" });
  t.after(mounted.done);
  const hint = [...document.querySelectorAll("p")].find((el) =>
    (el.textContent ?? "").includes("when empty"),
  );
  assert.ok(!hint, "an explicit posting date needs no fallback hint");
});
