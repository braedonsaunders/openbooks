import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";

await bootJsdomEnvironment({
  url: "http://localhost:4800/manufacturing/work-orders",
  matchMediaMatches: false,
});
stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){}}}export function usePathname(){return '/manufacturing/work-orders'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { ProcessRunPanel } = await import("./ProcessRunPanel");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a completed work order's process run renders its recorded balance", async () => {
  const data = {
    record: {
      id: "wo-5",
      number: "WO-00005",
      status: "done",
      productionMode: "order",
      campaignReference: null,
      plannedStart: "2025-10-06",
      plannedEnd: "2025-10-08",
      startedAt: null,
      completedAt: null,
    },
    sections: {
      materialBalance: [
        {
          id: "kg",
          unit: "kg",
          inputQuantity: "12.5000",
          outputQuantity: "12.0000",
          difference: "0.5000",
        },
      ],
    },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const errors: unknown[] = [];
  const priorError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <ProcessRunPanel data={data as never} onOpen={() => {}} />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    const text = host.textContent ?? "";
    assert.ok(text.includes("Production order"), text.slice(0, 400));
    assert.ok(text.includes("12.5"), "the recorded input renders");
  } finally {
    console.error = priorError;
    await act(async () => root.unmount());
    host.remove();
  }
  assert.deepEqual(errors, []);
});
