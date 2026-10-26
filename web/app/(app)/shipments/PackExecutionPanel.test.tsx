import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";
import { stubModules } from "../../../testing/stub-modules.ts";

await bootJsdomEnvironment({ url: "http://localhost/shipments" });
stubModules({ navigation: true });

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../components/business-date-provider.tsx");
const { PackExecutionPanel } = await import("./PackExecutionPanel.tsx");

const shipment = {
  id: "shipment-1",
  lines: [
    {
      lineId: "line-1",
      itemId: "item-1",
      itemLabel: "Widget",
      quantity: "1",
      unit: "ea",
      binId: null,
      binCode: "",
    },
    {
      lineId: "line-2",
      itemId: "item-2",
      itemLabel: "Gadget",
      quantity: "1",
      unit: "ea",
      binId: null,
      binCode: "",
    },
  ],
} as never;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("creating another carton clears the prior line selection and uses an available bin", async () => {
  const previousFetch = globalThis.fetch;
  const writes: Array<{ code: string; binId: string; lineIds: string[] }> = [];
  let units: Array<{
    id: string;
    code: string;
    status: string;
    binId: string;
    binCode: string;
    version: string;
    lines: Array<{ lineId: string; itemId: string; quantity: string; confirmed: boolean }>;
  }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        code: string;
        binId: string;
        lineIds: string[];
      };
      writes.push(body);
      const id = `unit-${writes.length}`;
      units = [
        ...units,
        {
          id,
          code: body.code,
          status: "open",
          binId: body.binId,
          binCode: "A1",
          version: "1",
          lines: body.lineIds.map((lineId) => ({
            lineId,
            itemId: lineId,
            quantity: "1",
            confirmed: false,
          })),
        },
      ];
      return Response.json({ id });
    }
    return Response.json({ units, bins: [{ id: "bin-1", code: "A1" }] });
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selectValue = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
    });
  };
  const setTextInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  const createCarton = async (code: string, itemLabel: string) => {
    const codeInput = host.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    assert.ok(codeInput, "carton code field should be available");
    await setTextInput(codeInput, code);
    const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent?.includes(itemLabel),
    );
    assert.ok(checkbox, `${itemLabel} should be available for packing`);
    await act(async () => {
      checkbox.click();
      await tick();
    });
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Create handling unit",
    );
    assert.ok(button);
    await act(async () => {
      button.click();
      await tick();
      await tick();
    });
  };

  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <BusinessDateProvider today="2026-10-19">
            <PackExecutionPanel shipment={shipment} canManage canMove={false} />
          </BusinessDateProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await createCarton("BOX-1", "Widget");
    await selectValue(host.querySelector<HTMLSelectElement>("select")!, "");
    await createCarton("BOX-2", "Gadget");

    assert.deepEqual(writes, [
      {
        action: "create",
        shipmentId: "shipment-1",
        code: "BOX-1",
        binId: "bin-1",
        lineIds: ["line-1"],
      },
      {
        action: "create",
        shipmentId: "shipment-1",
        code: "BOX-2",
        binId: "bin-1",
        lineIds: ["line-2"],
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previousFetch;
  }
});
