import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost:4800/receipts", matchMediaMatches: false });
const state = { reason: "Receipt projection configuration reviewed and corrected", refreshes: 0 };
Object.assign(globalThis, { __paymentEffectUi: state });
stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){globalThis.__paymentEffectUi.refreshes++}}};export function usePathname(){return '/receipts'};export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
  },
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/prompt"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return globalThis.__paymentEffectUi.reason}",
      };
    return next(specifier, context);
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
// The application shell supplies the organization's business day.
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { PaymentDrawer } = await import("./PaymentDrawer");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement[];

async function mount(
  options: { effect?: string; canRetry?: boolean; status?: string; side?: "ar" | "ap" } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ rates: [], flows: [], gates: [], events: [] })) as typeof fetch;
  const side = options.side ?? "ar";
  const doc = {
    id: randomUUID(),
    kind: side === "ar" ? "customer_payment" : "vendor_payment",
    status: options.status ?? "posted",
    currency: "CAD",
    total: "100.0000",
    document_number: "RCPT-00008",
    party_id: randomUUID(),
    party_name: "Maple Construction",
    document_date: "2026-07-15",
    reference_number: "CARD-100",
    memo: null,
    updated_at: "8",
    entry_id: randomUUID(),
    bank_account_number: "1040",
    bank_account_name: "Processor clearing",
    posting_effect_status: options.effect ?? "terminal_failed",
    posting_effect_error: "Receipt projection could not complete",
    posting_effect_updated_at: "2026-07-15 12:00:00+00",
  };
  const render = async (next = doc) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <BusinessDateProvider today="2026-07-15">
            <MoneyProvider currency="CAD">
              <PaymentDrawer
                payment={{
                  doc: next,
                  bankAccountId: null,
                  allocations: [],
                  applied: [],
                  canRetryPostingEffects: options.canRetry ?? true,
                }}
                initialOpenItems={[]}
                parties={[]}
                bankAccounts={[]}
                side={side}
                basePath={side === "ar" ? "/receipts" : "/payments"}
              />
            </MoneyProvider>
          </BusinessDateProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
  };
  await render();
  return {
    doc,
    render,
    done: async () => {
      globalThis.fetch = priorFetch;
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("posted receipts and vendor payments show one reasoned native retry while retaining their existing Actions menu", async () => {
  for (const side of ["ar", "ap"] as const) {
    state.refreshes = 0;
    state.reason = "Receipt projection configuration reviewed and corrected";
    const f = await mount({ side });
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
      return Response.json({ payment: { doc: { ...f.doc, posting_effect_status: "pending" } } });
    }) as typeof fetch;
    try {
      assert.equal(buttons("Retry posting effects").length, 1);
      assert.equal(
        buttons("Actions").length,
        1,
        "recovery retains the existing closed lifecycle menu",
      );
      assert.match(document.body.textContent ?? "", /Receipt projection could not complete/);
      const shells = document.querySelectorAll('[role="dialog"]').length;
      await act(async () => {
        buttons("Retry posting effects")[0]!.click();
        await tick();
      });
      assert.deepEqual(calls, [
        { url: `/api/payments/${f.doc.id}/retry-effects`, body: { reason: state.reason } },
      ]);
      assert.equal(
        buttons("Retry posting effects").length,
        0,
        "the same drawer observes pending effects without offering another reset",
      );
      assert.equal(
        buttons("Actions").length,
        1,
        "recovery retains the existing closed lifecycle menu",
      );
      assert.ok(state.refreshes > 0);
      assert.equal(
        document.querySelectorAll('[role="dialog"]').length,
        shells,
        "retry preserves one URL drawer shell",
      );
      assert.match(document.body.textContent ?? "", /queued/i);
      await f.render({
        ...f.doc,
        posting_effect_status: "terminal_failed",
        posting_effect_updated_at: "2026-07-15 12:30:00+00",
      });
      assert.equal(
        buttons("Retry posting effects").length,
        1,
        "new native terminal evidence restores the available recovery action",
      );
    } finally {
      await f.done();
    }
  }
});

test("retry requires terminal posted evidence and a server-resolved payment recovery grant", async () => {
  for (const options of [
    { effect: "pending" },
    { effect: "failed" },
    { effect: "running" },
    { effect: "succeeded" },
    { status: "voided" },
    { status: "draft" },
    { canRetry: false },
  ]) {
    const f = await mount(options);
    try {
      assert.equal(buttons("Retry posting effects").length, 0);
    } finally {
      await f.done();
    }
  }
});

test("invalid reasons and API refusals retain the receipt and its recoverable action without another posting command", async () => {
  state.reason = "short";
  const f = await mount();
  let writes = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes++;
      return Response.json(
        { error: "This receipt remains posted; resolve the projection cause before retrying" },
        { status: 422 },
      );
    }
    return Response.json({ rates: [], flows: [], gates: [] });
  }) as typeof fetch;
  try {
    await act(async () => {
      buttons("Retry posting effects")[0]!.click();
      await tick();
    });
    assert.equal(writes, 0);
    state.reason = "Receipt projection configuration reviewed and corrected";
    await act(async () => {
      buttons("Retry posting effects")[0]!.click();
      await tick();
    });
    assert.equal(writes, 1);
    assert.match(document.body.textContent ?? "", /resolve the projection cause before retrying/);
    assert.equal(buttons("Retry posting effects")[0]!.disabled, false);
    assert.equal(
      buttons("Actions").length,
      1,
      "recovery retains the existing closed lifecycle menu",
    );
  } finally {
    await f.done();
  }
});
