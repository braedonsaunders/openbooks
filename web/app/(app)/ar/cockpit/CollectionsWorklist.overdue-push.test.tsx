import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost/ar?view=cockpit",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});
globalThis.requestAnimationFrame = (callback) =>
  Number(setTimeout(() => callback(performance.now()), 16));
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return {push(){},refresh(){},replace(){}}} export function usePathname(){return "/ar"} export function useSearchParams(){return new URLSearchParams(window.location.search)}',
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { CollectionsWorklist } = await import("./CollectionsWorklist");

function entry(id: string, method: string, daysOverdue: number, amount: string) {
  return {
    id,
    docId: `doc-${id}`,
    docKind: "customer_invoice",
    partyName: `Customer ${id}`,
    amount,
    dueDate: "2026-03-01",
    predictedDate: "2026-10-12",
    daysOverdue,
    method,
  };
}

test("the collections worklist states the overdue-push assumption and the age range it covers", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <CollectionsWorklist
            entries={[
              entry("a", "Overdue push", 180, "20000.0000"),
              entry("b", "Overdue push", 360, "15000.0000"),
              entry("c", "Statistical", 0, "5000.0000"),
            ]}
            overdueTotal="35000.0000"
            expectedThisWeek="0.0000"
            unappliedCredits={{ count: 0, total: "0.0000" }}
            canCollect={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });
  const note = document.querySelector('[role="note"]');
  assert.ok(note, "the worklist renders the basis note");
  assert.match(
    note.textContent ?? "",
    /Assumes overdue balances are collected on their forecast date\./,
  );
  assert.match(note.textContent ?? "", /2 invoices aged 180–360 days past due/);
});

test("a worklist with no overdue push shows no assumption note", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <CollectionsWorklist
            entries={[entry("c", "Statistical", 0, "5000.0000")]}
            overdueTotal="0.0000"
            expectedThisWeek="5000.0000"
            unappliedCredits={{ count: 0, total: "0.0000" }}
            canCollect={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });
  assert.equal(document.querySelector('[role="note"]'), null);
});
