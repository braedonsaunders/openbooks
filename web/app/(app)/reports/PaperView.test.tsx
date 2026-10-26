import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: `export function usePathname(){return '/reports/custom/run/1'}export function useSearchParams(){return new URLSearchParams()}export function useRouter(){return {}}`,
  intl: false,
  authz: false,
  features: false,
});

const React = await import("react");
// Classic-JSX fallback: the shared tsx cache can serve a classic transform,
// which resolves bare React from the global scope, not the module scope.
Object.assign(globalThis, { React });
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { MoneyProvider } = await import("../../../components/money-provider");
const { PaperView } = await import("./PaperView");
const { resultGroupsForPaper } = await import("./custom/paper-groups");

function paperHtml(locale: string): string {
  const groups = resultGroupsForPaper(
    {
      groups: [
        {
          kind: "summary",
          title: "Summary",
          columns: ["Holder", "Outstanding shares", "Fully diluted %", "Note", "Issued"],
          rows: [["Avery Quinn", "4500000", "42.4528", "1200", "2026-03-01"]],
          align: ["left", "right", "right", "left", "left"],
          numberFormats: [null, "number", "percent", null, null],
          dates: [false, false, false, false, true],
        },
      ],
      summary: [],
      rowCount: 1,
    },
    { kind: "ledger", label: "General ledger", to: "2025-10-01", mode: "balance" },
  );
  return renderToString(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{}}>
      <MoneyProvider currency="USD">
        <PaperView
          company="Northstar Cloud"
          emptyLabel="No rows"
          data={{
            title: "Cap table as of a date",
            summary: [{ label: "Total fully diluted", value: "6320000", number: true }],
            groups,
          }}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  );
}

test("the report paper prints quantity columns in the viewer locale and leaves untyped text as written", () => {
  const english = paperHtml("en");
  assert.match(english, />4,500,000</);
  assert.match(english, />42\.4528%</);
  assert.match(english, />6,320,000</, "the summary band formats its quantity total");
  assert.match(english, />1200</, "an untyped column is not reformatted");
  assert.match(english, />Mar 1, 2026</, "typed civil dates use the viewer locale");
  const german = paperHtml("de");
  assert.match(german, />4\.500\.000</);
  assert.match(german, />42,4528\s%</);
  assert.ok(
    german.includes(
      new Intl.DateTimeFormat("de", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date("2026-03-01T12:00:00Z")),
    ),
  );
});

test("per-share report cells read under the per-share rule on screen and in print", async () => {
  const { paperQuantity } = await import("./PaperView");
  const { pdfQuantity } = await import("../../../lib/report-pdf");
  for (const render of [
    (value: string, locale: string) => paperQuantity(value, locale, "per_share"),
    (value: string, locale: string) => pdfQuantity(value, locale, "per_share"),
  ]) {
    assert.equal(render("1.8814382581", "en"), "1.8814");
    assert.equal(render("0.0500000000", "en"), "0.0500");
    assert.equal(render("0.0001000000", "en"), "0.0001");
    assert.equal(render("0.0000100000", "de"), "0,00001");
    assert.equal(render("2.8446389082", "de"), "2,8446");
  }
});
