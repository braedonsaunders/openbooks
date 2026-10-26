import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";
import { stubModules } from "../../../testing/stub-modules.ts";

await bootJsdomEnvironment({ url: "http://localhost/estimates" });
stubModules({
  navigation: true,
  extra: { sonner: "export const toast={success(){},error(){}}" },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider.tsx");
const { QuoteCashSection } = await import("./QuoteCashSection.tsx");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("failed subscription terms load shows the refusal and a working retry", async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1)
      return Response.json(
        { error: "Subscription terms are not available to this user" },
        { status: 403 },
      );
    return Response.json({
      quote: {
        id: "quote-1",
        documentNumber: "EST-1",
        status: "draft",
        currency: "USD",
      },
      terms: [],
      tcv: "0.0000",
      listTcv: "0.0000",
      discountPct: "0.00",
      floorBreached: false,
      signature: null,
      settings: { autoActivateOnSign: false },
      advancedSubscriptions: false,
      revenueContracts: false,
    });
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <QuoteCashSection
              quoteId="quote-1"
              currency="USD"
              canManage={false}
              docStatus="draft"
              lines={[]}
            />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
      await tick();
    });

    assert.match(
      host.querySelector('[role="alert"]')?.textContent ?? "",
      /Subscription terms are not available/,
    );
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    assert.ok(retry, "a failed load must offer a retry");
    await act(async () => {
      retry.click();
      await tick();
      await tick();
    });

    assert.equal(requests, 2);
    assert.match(host.textContent ?? "", /Total contract value/);
    assert.doesNotMatch(host.textContent ?? "", /Loading subscription terms/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previousFetch;
  }
});
