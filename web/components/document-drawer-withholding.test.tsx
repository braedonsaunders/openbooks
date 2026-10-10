import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
}

// Country neutrality on the vendor-bill line grid: contractor-withholding
// treatment and direct-materials columns (and their scheme guidance) render
// only behind an active withholding registration for the bill's scope. A
// company with no registration — the ordinary US bill — sees neither the
// columns nor the guidance, never by default.

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
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
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

function columnHeaders(): string[] {
  return [...document.querySelectorAll('[role="columnheader"]')].map(
    (node) => (node.textContent ?? "").trim(),
  );
}

async function renderBill(
  schemes: { code: string }[] | undefined,
  t: import("node:test").TestContext,
): Promise<void> {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
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
    kind: "vendor_bill",
    status: "draft",
    document_number: "BILL-00001",
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
            segments={[]}
            canCreate
            canPost={false}
            initialMode="edit"
            withholdingSchemes={schemes}
            layout={{ header: { groups: [] }, lines: { columns: [] }, actions: [] } as never}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
}

test("a bill with no withholding registration hides the withholding columns", async (t) => {
  await renderBill(undefined, t);
  const headers = columnHeaders();
  assert.ok(headers.some((header) => header.includes("Amount")), "the line grid itself renders");
  assert.ok(!headers.some((header) => header.includes("Withholding treatment")), "no treatment column without a registration");
  assert.ok(!headers.some((header) => header.includes("Direct materials cost")), "no materials column without a registration");
  assert.ok(!String(document.body.textContent).includes("direct cost of materials"), "no scheme guidance without a registration");
});

test("an empty registration list hides the withholding columns", async (t) => {
  await renderBill([], t);
  const headers = columnHeaders();
  assert.ok(!headers.some((header) => header.includes("Withholding treatment")), "an empty scope is the same as no registration");
  assert.ok(!headers.some((header) => header.includes("Direct materials cost")), "an empty scope is the same as no registration");
});

test("an active registration shows the withholding columns and neutral guidance", async (t) => {
  await renderBill([{ code: "GB_CIS" }], t);
  const headers = columnHeaders();
  assert.ok(headers.some((header) => header.includes("Withholding treatment")), "the treatment column renders behind a registration");
  assert.ok(headers.some((header) => header.includes("Direct materials cost")), "the materials column renders behind a registration");
});
