import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
}

// Posting dates of posted documents are immutable history: the
// posted-correction classification treats them as financial, so the
// posted-document edit form must show the stored date without offering it.
// Offering the input used to record no-change corrections against the
// posted record.

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

const SEGMENTS: never[] = [];
const LAYOUT_WITH_POSTING_DATE = {
  header: {
    groups: [{ id: "dates", label: "", fields: [{ key: "posting_date", visible: true }] }],
  },
  lines: { columns: [] },
  actions: [],
} as never;

function postingDateCell(): HTMLElement | null {
  const label = [...document.querySelectorAll("label")].find(
    (el) => el.textContent?.trim() === "Posting date",
  ) as HTMLElement | undefined;
  return (label?.closest("div") as HTMLElement | null) ?? null;
}

async function mountInvoice(t: import("node:test").TestContext, status: "draft" | "posted") {
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
    kind: "customer_invoice",
    status,
    document_number: "INV-00912",
    currency: "USD",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    posting_date: "2026-07-15",
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
            layout={LAYOUT_WITH_POSTING_DATE}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
}

async function clickEdit() {
  const edit = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Edit",
  ) as HTMLButtonElement | undefined;
  assert.ok(edit, "the record must offer Edit");
  await act(async () => {
    edit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("a posted invoice edit shows the posting date without offering it", async (t) => {
  await mountInvoice(t, "posted");
  await clickEdit();
  const cell = postingDateCell();
  assert.ok(cell, "the stored posting date must still render");
  assert.match(cell.textContent ?? "", /2026-07-15/, "the stored date stays visible");
  assert.equal(
    cell.querySelector("input"),
    null,
    "no posting-date input may be offered on a posted edit",
  );
});

test("a draft invoice edit still offers the posting date", async (t) => {
  await mountInvoice(t, "draft");
  await clickEdit();
  const cell = postingDateCell();
  assert.ok(cell, "the posting date field must render on a draft");
  const input = cell.querySelector("input[data-date-field]") as HTMLInputElement | null;
  assert.ok(input, "drafts keep the posting-date input");
});
