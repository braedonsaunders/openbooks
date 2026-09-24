import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CategoryWeekly, WeekRow } from "../../../../lib/cash/core";

const React = await import("react");
// Classic-JSX fallback: the shared tsx cache can serve a classic transform,
// which resolves bare React from the global scope, not the module scope.
Object.assign(globalThis, { React });
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/fr")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { CashTimeline } = await import("./CashTimeline");

// The cash timeline must render its chrome from the banking.cash catalog:
// hardcoded English headers read as untranslated copy under fr/es (F-t05-016).

function week(overrides: Partial<WeekRow> = {}): WeekRow {
  return {
    weekStart: "2026-09-13",
    weekEnd: "2026-09-19",
    label: "Sep 13 – Sep 19",
    inflow: "1000.0000",
    outflow: "400.0000",
    net: "600.0000",
    startingCash: "5000.0000",
    endingCash: "5600.0000",
    arEntries: [],
    apEntries: [],
    arTotal: "1000.0000",
    apTotal: "400.0000",
    arCount: 40,
    apCount: 20,
    dynamicInflow: "0.0000",
    dynamicOutflow: "0.0000",
    deferredOut: "0.0000",
    apCapacity: null,
    ...overrides,
  };
}

function render(ui: ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">{ui}</MoneyProvider>
    </NextIntlClientProvider>,
  );
}

const ENGLISH_HEADERS = ["Week</th>", "Inflows</th>", "Outflows</th>", "Net</th>", "Ending Cash</th>"];

test("cash timeline headers render from the catalog, not hardcoded English", () => {
  const html = render(
    <CashTimeline
      weeks={[week()]}
      categories={[]}
      weeklyCap="0.0000"
      restrictToSafe={false}
      deferredBeyondHorizon="0.0000"
    />,
  );
  assert.match(html, /Semaine<\/th>/, "Week header is French");
  assert.match(html, /Entrées<\/th>/, "Inflows header is French");
  assert.match(html, /Sorties<\/th>/, "Outflows header is French");
  assert.match(html, /Net<\/th>/, "Net header renders");
  assert.match(html, /Trésorerie finale<\/th>/, "Ending Cash header is French");
  for (const leaked of ENGLISH_HEADERS.filter((h) => h !== "Net</th>")) {
    assert.doesNotMatch(html, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${leaked} must not leak English`);
  }
});

test("cash timeline transaction counts and spill banner render from the catalog", () => {
  const cats: CategoryWeekly[] = [
    {
      id: "c1",
      name: "Payroll",
      direction: "outflow",
      method: "manual_recurring",
      weekly: ["0.0000"],
      total: "0.0000",
      logic: "",
      meta: { method: "Manual Recurring" },
      breakdown: [],
    },
  ];
  const html = render(
    <CashTimeline
      weeks={[week()]}
      categories={cats}
      weeklyCap="100.0000"
      restrictToSafe={false}
      deferredBeyondHorizon="250.0000"
    />,
  );
  assert.match(html, /Autres entrées<\/th>/, "Other In header is French");
  assert.match(html, /Autres sorties<\/th>/, "Other Out header is French");
  assert.match(html, /Reportées<\/th>/, "Deferred header is French");
  assert.match(html, /60 transactions/, "txn count is French");
  assert.match(html, /ne peuvent pas être payées/, "spill banner is French");
  assert.doesNotMatch(html, /txns/, "English txn abbreviation is gone");
  assert.doesNotMatch(html, /of payables can/, "English banner is gone");
});
