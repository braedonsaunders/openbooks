import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

await bootJsdomEnvironment({
  url: "http://localhost:4800/sync/billing-history",
  matchMediaMatches: false,
});
stubModules({
  navigation: true,
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={error(message){(globalThis.__billingToasts??=[]).push(String(message))},success(){}}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { BillingHistoryClient } = await import("./BillingHistoryClient");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("billing history shows a retryable error instead of the empty state after fetch failure", async (t) => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? response(503, { error: "Billing import history is unavailable." })
      : response(200, []);
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  });

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BillingHistoryClient />
      </NextIntlClientProvider>,
    );
    await tick();
  });

  assert.match(host.textContent ?? "", /Billing import history is unavailable/);
  assert.doesNotMatch(host.textContent ?? "", /No billing imports yet/);
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Retry",
  );
  assert.ok(retry);

  await act(async () => {
    retry.click();
    await tick();
  });

  assert.match(host.textContent ?? "", /No billing imports yet/);
  assert.equal(attempts, 2);
});
