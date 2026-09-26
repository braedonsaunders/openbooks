import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost:4800/entities/employees", matchMediaMatches: false });

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { EmployeeEntitlementBalances } = await import("./EmployeeEntitlementBalances");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("money entitlement balances retain exact decimal cents in localized currency output", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    currency: "USD",
    balances: [{
      planId: "plan-1",
      planCode: "VAC",
      planName: "Vacation bank",
      unit: "money",
      direction: "accrue",
      balance: "12345678901234.1255",
      balanceMoney: null,
      balanceHours: null,
      wage: null,
      maxBalance: null,
      notifyBalance: null,
      limitScope: null,
      overLimit: false,
      nearLimit: false,
      lastMovementDate: null,
    }],
    movements: [],
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });

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
          <EmployeeEntitlementBalances partyId="employee-1" />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });

  const { createMoneyFormatter } = await import("../../../lib/money-format");
  const expected = createMoneyFormatter("en", "USD").money("12345678901234.1255", {
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  assert.ok(
    (document.body.textContent ?? "").includes(expected),
    `the displayed balance should preserve the exact amount and cents: ${expected}`,
  );
});
