import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/analytics",
  scrollIntoView: false,
  resizeObserver: false,
});

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/analytics" } });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const { MoneyProvider } = await import("../../../../components/money-provider");
const messages = (await import("../../../../messages/en")).default;
const { EntityDrawer } = await import("./EntityDrawer");

const ENTITY = {
  avgDays: 12,
  currency: "CAD",
  totalPaid: "5000.00",
  paymentCount: 2,
  openBalance: "1200.00",
  overdueCount: 1,
  reliability: 90,
  openItems: [],
  recentPayments: [],
};

async function mountDrawer(side: "ar" | "ap") {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(ENTITY)) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <EntityDrawer party="customer-9" name="Corner Bakery" side={side} onClose={() => {}} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = priorFetch;
    },
  };
}

test("the customer drawer links the statement, its PDF, and Send", async () => {
  const { done } = await mountDrawer("ar");
  try {
    const view = document.querySelector('a[href="/reports/statements/customer-9?side=ar"]');
    assert.ok(view, "the AR drawer links the customer statement report");
    assert.equal(view.textContent, "View statement");
    const pdf = document.querySelector(
      'a[href="/api/reports/statement/partner-statement/export?format=pdf&party=customer-9&side=ar"]',
    );
    assert.ok(pdf, "the AR drawer links the statement PDF export");
    const send = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Send",
    );
    assert.ok(send, "the AR drawer offers Send through the shared composer");
  } finally {
    await done();
    window.close();
  }
});

test("the vendor drawer shows no statement actions", async () => {
  const { done } = await mountDrawer("ap");
  try {
    assert.equal(document.querySelector('a[href^="/reports/statements/"]'), null);
    assert.equal(document.querySelector('a[href*="partner-statement/export"]'), null);
    assert.equal(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Send"),
      false,
    );
  } finally {
    await done();
    window.close();
  }
});
