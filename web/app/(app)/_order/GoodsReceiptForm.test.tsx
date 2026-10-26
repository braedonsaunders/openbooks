import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";
import { stubModules } from "../../../testing/stub-modules.ts";

await bootJsdomEnvironment({ url: "http://localhost/purchase-orders" });
stubModules({ navigation: true });

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { GoodsReceiptForm } = await import("./GoodsReceiptForm.tsx");

test("warehouse prefill refusal shows its supported remedy", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: "No default warehouse is available for this entity",
        code: "warehouse_required",
        details: {
          remedy: "Assign a warehouse to each purchase order line or mark a default warehouse.",
        },
      },
      { status: 409 },
    )) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <GoodsReceiptForm
            orderId="order-1"
            apiBase="/api/purchase-orders"
            warehouses={[]}
            onSubmit={async () => ({ ok: true })}
            onClose={() => {}}
          />
        </NextIntlClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const alert = document.body.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent ?? "", /No default warehouse is available/);
    assert.match(
      alert.textContent ?? "",
      /Assign a warehouse to each purchase order line or mark a default warehouse/,
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previousFetch;
  }
});
