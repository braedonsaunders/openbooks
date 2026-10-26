import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { stubModules } from "../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";

await bootJsdomEnvironment({ url: "http://localhost:4800/ar/returns" });
stubModules({ navigation: true, intl: false, authz: false, features: false });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}",
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
const { ReturnWorkflowPanel } = await import("./ReturnWorkflowPanel");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(currency: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ReturnWorkflowPanel
            authorization={{
              id: "return-1",
              documentNumber: "RMA-1",
              customerId: null,
              subsidiaryId: null,
              sourceDocumentId: null,
              status: "posted",
              stage: "receiving",
              customerCreditId: null,
              lines: [
                {
                  lineId: "11111111-1111-4111-8111-111111111111",
                  lineNumber: 1,
                  itemId: null,
                  lotId: null,
                  serialId: null,
                  sourceIssueMovementId: null,
                  authorized: "5",
                  received: "5",
                  accepted: "5",
                  disposition: null,
                  dispositionLocationId: null,
                  vendorCreditId: null,
                  scrapMovementId: null,
                },
              ],
            }}
            canInspect
            canManage
            currency={currency}
            stockLocations={[]}
            vendors={[]}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

function mockFeePreview(currency: string, minorUnits: number) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      lines: [
        {
          key: "fee-1",
          policyId: "policy-1",
          policyName: "Standard fee",
          scope: "default",
          feeMinor: "1234",
          capped: false,
          incomeAccountId: null,
        },
      ],
      totalMinor: "1234",
      currency,
      minorUnits,
    })) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

for (const example of [
  { currency: "JPY", minorUnits: 0, displayed: "1,234", incorrect: "12.34" },
  { currency: "KWD", minorUnits: 3, displayed: "1.234", incorrect: "12.34" },
]) {
  test(`restocking fee preview formats ${example.currency} with its currency precision`, async (t) => {
    const restoreFetch = mockFeePreview(example.currency, example.minorUnits);
    t.after(restoreFetch);
    const { host, root } = await mount(example.currency);
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const previewButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Preview fee",
    );
    assert.ok(previewButton, "the receiving stage offers a fee preview");
    await act(async () => {
      previewButton.click();
      await tick();
    });
    const text = host.textContent ?? "";
    assert.ok(
      text.includes(example.displayed),
      `expected ${example.displayed} in ${JSON.stringify(text)}`,
    );
    assert.ok(
      !text.includes(example.incorrect),
      `must not use a two-decimal conversion: ${JSON.stringify(text)}`,
    );
  });
}
