import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// A draft line can be entered in another currency: the line panel converts
// it at the dated exchange rate the API quotes, the grid shows the converted
// amount locked, and Save sends the original statement for the server to
// convert again. A stored foreign line reopens with its original amount.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/expenses/reports",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return {push(){},refresh(){},replace(){},back(){},prefetch(){}}}export function usePathname(){return "/expenses/reports"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
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
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { ExpenseDrawer } = await import("./ExpenseDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const REPORT_ID = "019f0000-0000-4000-8000-0000000000f1";
const ACCOUNT_ID = "019f0000-0000-4000-8000-0000000000f2";

function doc(): Record<string, unknown> {
  return {
    id: REPORT_ID,
    kind: "expense_report",
    status: "draft",
    party_id: "",
    employee_name: "Riley Traveller",
    document_number: "EXP-00010",
    document_date: "2026-07-15",
    memo: "",
    currency: "CAD",
    subtotal: "0",
    tax_total: "0",
    total: "0",
    custom: {},
    extra_dims: {},
    updated_at: "2026-09-01T10:00:00.000000Z",
  };
}

const domesticLine = {
  id: "line-1",
  line_number: 1,
  account_id: ACCOUNT_ID,
  description: "Hotel",
  amount: "0",
  settlement_type: "out_of_pocket",
  tax_overridden: false,
  tax_amount: "0",
};

async function mount(
  t: TestContext,
  lines: Record<string, unknown>[],
  initialMode: "edit" | "view",
) {
  const requests: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/flows/manual")) return Response.json({ buttons: [] });
    if (url.startsWith("/api/flows/record-state"))
      return Response.json({
        approvalState: { status: "draft", pendingWith: [], myActions: null },
        history: [],
      });
    if (url.startsWith("/api/expenses/fx-rate")) {
      return Response.json({
        reportCurrency: "CAD",
        minorUnits: 2,
        allowRateOverride: false,
        refusal: null,
        quote: {
          rate: "1.3650000000",
          rateType: "spot",
          observationDate: "2026-07-14",
          source: "manual",
        },
      });
    }
    if (url === `/api/expenses/${REPORT_ID}` && method === "GET")
      return Response.json({ doc: doc(), lines });
    if (url === `/api/expenses/${REPORT_ID}` && method === "PATCH") {
      return Response.json({
        doc: { ...doc(), updated_at: "2026-09-02T10:00:00.000000Z" },
        lines,
        revision: "2026-09-02T10:00:00.000000Z",
      });
    }
    if (url.startsWith(`/api/expenses/${REPORT_ID}/receipts`)) {
      return Response.json({
        captures: [],
        reportCurrency: "CAD",
        canScan: true,
        captureOperational: false,
        canConfigure: false,
        configureHref: "/admin/ai",
      });
    }
    return Response.json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ExpenseDrawer
            report={{ doc: doc(), lines } as never}
            initialMode={initialMode}
            employees={[]}
            accounts={[{ id: ACCOUNT_ID, number: "6200", name: "Travel" }]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            segments={[]}
            headerDefs={[]}
            lineDefs={[]}
            canSubmit
            canPost={false}
            canRecall={false}
            closeHref="/expenses/reports"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 4; i++) await tick();
  });
  return { requests };
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

async function click(button: HTMLButtonElement | undefined, label: string) {
  assert.ok(button, `${label} must render`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
}

function setInput(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
    element,
    value,
  );
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("a line entered in another currency converts at the quoted rate and saves its original statement", async (t) => {
  const { requests } = await mount(t, [domesticLine], "edit");
  await click(findButton("Other currency"), "the currency cell action");
  assert.match(document.body.textContent ?? "", /Line 1 currency/);
  await click(findButton("Enter in another currency"), "the foreign-currency start");
  const amount = document.querySelector<HTMLInputElement>("#line-0-original-amount")!;
  await act(async () => {
    setInput(amount, "100");
    for (let i = 0; i < 6; i++) await tick();
  });
  const quote = requests.find((request) => request.url.startsWith("/api/expenses/fx-rate"));
  assert.ok(quote, "the dated rate is quoted for the line");
  assert.match(quote.url, /currency=USD/);
  assert.match(quote.url, /date=2026-07-15/, "the expense date starts at the report date");
  assert.match(
    document.body.textContent ?? "",
    /Converts to CA\$136\.50 at 1 USD = 1\.3650000000 CAD\./,
  );
  assert.match(
    document.body.textContent ?? "",
    /USD\s100\.00/,
    "the grid shows the original amount",
  );

  await click(findButton("Actions"), "the actions menu");
  await click(findButton("Save"), "Save");
  const patch = requests.find(
    (request) => request.url === `/api/expenses/${REPORT_ID}` && request.method === "PATCH",
  );
  assert.ok(patch, "Save PATCHes the draft");
  const line = (patch.body!.lines as Record<string, unknown>[])[0]!;
  assert.equal(line.amount, "136.5000");
  assert.deepEqual(line.foreignCurrency, {
    currency: "USD",
    amount: "100",
    taxAmount: null,
    rateDate: "2026-07-15",
    method: "rate_table",
    rate: "1.3650000000",
    reason: null,
    billedAmount: null,
  });
});

test("a stored foreign line reopens with its original amount and converted figure", async (t) => {
  await mount(
    t,
    [
      {
        ...domesticLine,
        amount: "136.5000",
        original_currency: "USD",
        original_amount: "100.0000",
        original_tax_amount: null,
        original_fx_rate: "1.3650000000",
        original_fx_evidence: {
          version: 1,
          method: "rate_table",
          rate: "1.3650000000",
          fromCurrency: "USD",
          toCurrency: "CAD",
          rateDate: "2026-07-15",
        },
      },
    ],
    "view",
  );
  assert.match(document.body.textContent ?? "", /USD\s100\.00/);
  assert.match(document.body.textContent ?? "", /CA\$136\.50/);
});
