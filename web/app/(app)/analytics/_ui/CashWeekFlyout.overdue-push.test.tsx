import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/analytics",
  matchMediaMatches: false,
  scrollIntoView: false,
});
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/analytics" } });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { CashWeekFlyout } = await import("./CashWeekFlyout");
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");

const ASSUMPTION = "Assumes overdue balances are collected on their forecast date.";
const PILL_TITLE = "Overdue push: assumes overdue balances are collected on their forecast date";

function arEntry(id: string, method: string, daysOverdue: number, amount: string) {
  return {
    id,
    entryId: id,
    docKind: "customer_invoice",
    docNumber: `INV-${id}`,
    docId: `doc-${id}`,
    partyId: `party-${id}`,
    partyName: `Customer ${id}`,
    amount,
    tranDate: "2026-02-01",
    dueDate: "2026-03-01",
    predictedDate: "2026-10-12",
    weekStart: "2026-10-12",
    daysOverdue,
    method,
  };
}

function weekWith(arEntries: ReturnType<typeof arEntry>[]) {
  const total = arEntries.reduce((sum, entry) => sum + Number(entry.amount), 0).toFixed(4);
  return {
    weekStart: "2026-10-12",
    weekEnd: "2026-10-18",
    label: "Oct 12–18",
    inflow: total,
    outflow: "0.0000",
    net: total,
    startingCash: "1000.0000",
    endingCash: "1000.0000",
    arEntries,
    apEntries: [],
    arTotal: total,
    apTotal: "0.0000",
    arCount: arEntries.length,
    apCount: 0,
    dynamicInflow: "0.0000",
    dynamicOutflow: "0.0000",
    deferredOut: "0.0000",
    apCapacity: null,
  };
}

async function render(
  t: { after: (fn: () => Promise<void> | void) => void },
  week: ReturnType<typeof weekWith>,
) {
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
          <BusinessDateProvider today="2026-10-11">
            <CashWeekFlyout
              week={week as never}
              categories={[]}
              initialSide="ar"
              canCollectionRun={false}
              onClose={() => {}}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

test("the AR week names the overdue-push assumption and the age range of the invoices behind it", async (t) => {
  await render(
    t,
    weekWith([
      arEntry("a", "Overdue push", 180, "20000.0000"),
      arEntry("b", "Overdue push", 360, "15000.0000"),
      arEntry("c", "Statistical", 0, "5000.0000"),
    ]),
  );
  const note = document.querySelector('[role="note"]');
  assert.ok(note, "the basis note renders on the AR tab");
  assert.match(note.textContent ?? "", new RegExp(ASSUMPTION.replace(".", "\\.")));
  assert.match(note.textContent ?? "", /2 invoices aged 180–360 days past due/);
  assert.ok(
    document.querySelector(`span[title="${PILL_TITLE}"]`),
    "the pushed method pill carries the assumption",
  );
});

test("a single pushed age reads as one day count, and weeks with no push show no basis note", async (t) => {
  await render(t, weekWith([arEntry("a", "Overdue push", 75, "250.0000")]));
  const note = document.querySelector('[role="note"]');
  assert.ok(note, "the single pushed invoice still states its basis");
  assert.match(note.textContent ?? "", /1 invoice aged 75 days past due/);
});

test("a week without an overdue push shows no assumption note", async (t) => {
  await render(t, weekWith([arEntry("c", "Statistical", 0, "5000.0000")]));
  assert.equal(document.querySelector('[role="note"]'), null);
  assert.ok(!document.body.textContent?.includes(ASSUMPTION));
});
