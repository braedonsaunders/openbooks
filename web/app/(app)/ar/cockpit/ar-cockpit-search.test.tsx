import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __arRouter: { push(url: string): void; refresh(): void; replace(url: string): void } | undefined;
  var __arSearch: string | undefined;
}

// the receivables-by-customer search filters the as-of customer
// list client-side. A search that matches nobody must say so — it must not
// reuse the "No open receivables. Everything is collected." empty state,
// which states as fact that nothing is owed.

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/ar", matchMediaMatches: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__arRouter}export function usePathname(){return '/ar'}export function useSearchParams(){return new URLSearchParams(globalThis.__arSearch ?? '')}" });
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
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
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { ArCockpit } = await import("./ArCockpit");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function position(byCustomer: { partyId: string; partyName: string; amount: string; count: number; overdue: string; oldestDue: string | null }[]) {
  return {
    asOf: "2026-09-17",
    horizonWeeks: 12,
    outstanding: "100000.0000",
    overdue: "10000.0000",
    overdueCount: 2,
    expectedThisWeek: "5000.0000",
    expectedNext30: "20000.0000",
    dso: 30,
    summary: { count: 5, openCount: 5, lastDate: null, currencies: [], pctCurrent: '100.0000', buckets: [] },
    weeks: [],
    byCustomer,
    worklist: [],
    categories: [],
    unavailableCategories: [],
    timeline: [],
  } as never;
}

const seedCustomers = [
  "Acme Seed Co",
  "Baker Seed Ltd",
  "Cedar Seed Inc",
  "Dune Seed LLC",
  "Elm Seed Corp",
].map((partyName, i) => ({
  partyId: `00000000-0000-4000-8000-00000000000${i}`,
  partyName,
  amount: "1000.0000",
  count: 1,
  overdue: "0.0000",
  oldestDue: "2026-10-01" as string | null,
}));

async function mount(search: string) {
  globalThis.__arRouter = { push() {}, refresh() {}, replace() {} };
  globalThis.__arSearch = search;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ArCockpit data={position(seedCustomers)} canCollect={false} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return { host, root };
}

test("a customer search with no matches says so instead of claiming everything is collected", async (t) => {
  const { host, root } = await mount("customerQ=T02+Quotecash");
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const text = document.body.textContent ?? "";
  assert.match(text, /No customers match the current filters\./);
  assert.doesNotMatch(text, /No open receivables\. Everything is collected\./);
});

test("an unfiltered empty customer list keeps the collected-in-full message", async (t) => {
  globalThis.__arRouter = { push() {}, refresh() {}, replace() {} };
  globalThis.__arSearch = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ArCockpit data={position([])} canCollect={false} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  const text = document.body.textContent ?? "";
  assert.match(text, /No open receivables\. Everything is collected\./);
});
