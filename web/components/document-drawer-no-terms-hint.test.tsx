import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// A customer with no terms and no company default leaves the due date blank,
// so the drawer names the customer beside the field with the remedy; when
// terms resolve (party or company default) no hint shows.

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
          { key: "due_date", visible: true, required: null, labelOverride: null, colSpan: null },
        ],
      },
    ],
  },
  lines: { columns: [] },
  actions: [],
} as never;

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

const UNSAVED_INVOICE = {
  id: "",
  kind: "customer_invoice",
  status: "draft",
  document_number: null,
  currency: "USD",
  party_id: CUSTOMER_ID,
  party_name: null,
  updated_at: "",
  document_date: "2026-11-15",
  due_date: null,
  subtotal: "0",
  tax_total: "0",
  total: "0",
};

const PARTIES = [{ id: CUSTOMER_ID, display_name: "Lakeview Plaza" }];

async function mountInvoice(defaultsBody: unknown) {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/api/documents/defaults")) return Response.json(defaultsBody);
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            canPost={false}
            payload={{ doc: { ...UNSAVED_INVOICE }, lines: [] }}
            config={DOC_KINDS["customer_invoice"]!}
            basePath="/ar/invoices"
            parties={PARTIES}
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

test("no usable terms names the customer beside the blank due date", async (t) => {
  const mounted = await mountInvoice({ terms: null, lines: [] });
  t.after(mounted.done);
  const hint = [...document.querySelectorAll("p")].find((el) =>
    (el.textContent ?? "").includes("No payment terms on Lakeview Plaza"),
  );
  assert.ok(hint, "the drawer names the customer and the remedy when no terms resolve");
});

test("resolved terms show no no-terms hint", async (t) => {
  const mounted = await mountInvoice({
    terms: {
      termsId: "22222222-2222-4222-8222-222222222222",
      termsName: "Net 30",
      netDays: 30,
      dueDate: "2026-12-15",
      source: "company",
    },
    lines: [],
  });
  t.after(mounted.done);
  const hint = [...document.querySelectorAll("p")].find((el) =>
    (el.textContent ?? "").includes("No payment terms on"),
  );
  assert.ok(!hint, "a company-default due date needs no hint");
});
