import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../testing/stub-modules";

stubModules({
  navigation: { pathname: "/purchasing" },
  intl: false,
  authz: false,
  features: false,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { default: messages } = await import("../../../../messages/en");
const { MoneyProvider } = await import("../../../../components/money-provider");
const { TrendChart } = await import("./charts");

function render(series: { name: string; data: (number | null)[] }[], emptyLabel?: string): string {
  return renderToString(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MoneyProvider currency="CAD">
        <TrendChart
          labels={["Aug 3", "Aug 10"]}
          series={series}
          height={170}
          emptyLabel={emptyLabel}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  );
}

test("a trend with no activity shows its empty message instead of a flat line", () => {
  const html = render(
    [{ name: "Billed", data: [0, null] }],
    "No posted vendor bills in the last 13 weeks.",
  );
  assert.match(html, /No posted vendor bills in the last 13 weeks\./);
});

test("a trend with activity, or without an empty message, still draws the chart", () => {
  const empty = "No posted vendor bills in the last 13 weeks.";
  assert.doesNotMatch(
    render([{ name: "Billed", data: [0, 125.5] }], empty),
    /No posted vendor bills/,
  );
  assert.doesNotMatch(render([{ name: "Billed", data: [0, 0] }]), /No posted vendor bills/);
});
