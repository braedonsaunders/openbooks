import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

// A second observation that agrees with the first records straight away; one
// that differs asks for its reason first, and cancelling that prompt records
// nothing. Both paths run through the directed-execution endpoint.

await bootJsdomEnvironment({ url: "http://localhost:4800/inventory?inventoryView=counts" });

const COUNT_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const LINE_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const BIN_ID = "22222222-2222-4222-8222-222222222222";

const script = {
  executionBodies: [] as Array<Record<string, unknown>>,
  promptCalls: [] as Array<Record<string, unknown>>,
  promptAnswer: null as string | null,
};
Object.assign(globalThis, { __secondObservationScript: script });
Object.assign(globalThis, {
  __secondObservationRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
});
stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__secondObservationRouter}" +
      'export function usePathname(){return "/inventory"}' +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      'export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
    sonner:
      "export const toast={success(){},error(){},info(){}};export function Toaster(){return null}",
    "@/lib/prompt":
      "export function promptDialog(options){const s=globalThis.__secondObservationScript;s.promptCalls.push(options);const answer=s.promptAnswer;s.promptAnswer=null;return Promise.resolve(answer)}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { CountsList } = await import("./CountsList");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const detail = {
  ok: true,
  header: {
    id: COUNT_ID,
    status: "counting",
    locationId: "loc-main",
    subsidiaryId: "sub-1",
    countedOn: "2026-09-23",
    memo: null,
    locationName: "Main",
    subsidiaryName: "Sub",
    blind: false,
  },
  lines: [
    {
      id: LINE_ID,
      itemId: ITEM_ID,
      stockLocationId: BIN_ID,
      lotId: null,
      serialId: null,
      expectedQuantity: "10.0000",
      countedQuantity: "7.0000",
      adjustmentMovementId: null,
      itemCode: "W-1",
      itemName: "Widget",
      stockLocationCode: "BIN-1",
      lotNumber: null,
      serialNumber: null,
      variance: "-3.0000",
      secondCountRequired: true,
    },
  ],
};

function props() {
  return {
    counts: [],
    totalCount: 0,
    nextCursor: null,
    locations: [{ id: "loc-main", name: "Main" }],
    subsidiaries: [{ id: "sub-1", name: "Sub" }],
    items: [{ id: ITEM_ID, code: "W-1", name: "Widget" }],
    stockLocations: [{ id: BIN_ID, code: "BIN-1", locationId: "loc-main" }],
    lots: [],
    canPost: true,
    canManageStockLocations: true,
    canManageItems: true,
    itemsExcludedCount: 0,
    createRequested: false,
    selectedCountId: COUNT_ID,
  };
}

async function mount(t: TestContext): Promise<void> {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url === "/api/inventory/execution") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      script.executionBodies.push(body);
      return Response.json({
        task: {
          id: LINE_ID,
          stage: "count",
          status: "open",
          itemLabel: "W-1",
          binCode: "BIN-1",
          quantity: body.quantity,
          unit: null,
          baseQuantity: body.quantity,
          lotNumber: null,
          serialNumber: null,
          barcodeScanning: false,
        },
      });
    }
    if (url.includes("counts?id=")) return Response.json(detail);
    if (url.includes("/api/inventory/tracking-options"))
      return Response.json({ tracking: "none", lots: [], serials: [] });
    return Response.json({ counts: [], totalCount: 0, nextCursor: null });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const rootHandle = createRoot(document.body);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    for (const node of [...document.body.children]) node.remove();
  });
  script.executionBodies.length = 0;
  script.promptCalls.length = 0;
  script.promptAnswer = null;
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-23">
            <CountsList {...(props() as unknown as React.ComponentProps<typeof CountsList>)} />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
    await tick();
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === name,
  );
  assert.ok(button, `button "${name}" is rendered`);
  return button;
}

async function typeCount(value: string) {
  const input = document.querySelector('input[placeholder="7.0000"]') as HTMLInputElement | null;
  assert.ok(input, "the second observation input is rendered");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("an agreeing second observation is recorded without a reason prompt", async (t) => {
  await mount(t);
  await typeCount("7");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  assert.equal(script.promptCalls.length, 0, "no reason is asked for an agreeing count");
  assert.equal(script.executionBodies.length, 1);
  assert.equal(script.executionBodies[0]!.observation, "second");
  assert.equal("reason" in script.executionBodies[0]!, false);
});

test("an agreeing second observation retains optional source context without a difference prompt", async (t) => {
  await mount(t);
  await typeCount("7");
  const context = document.querySelector(
    'input[aria-label="Observation context for W-1 (optional)"]',
  ) as HTMLInputElement | null;
  assert.ok(context, "the real row offers observation context even when quantities agree");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      context,
      "Modeled source review; not a physical count",
    );
    context.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await click(buttonNamed(messages.inventory.counts.secondCount));
  assert.equal(script.promptCalls.length, 0);
  assert.equal(script.executionBodies.length, 1);
  assert.equal(script.executionBodies[0]!.reason, "Modeled source review; not a physical count");
});

test("a differing second observation asks for its reason, and cancelling records nothing", async (t) => {
  await mount(t);
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  assert.equal(script.promptCalls.length, 1, "a differing count asks for its reason");
  assert.equal(script.executionBodies.length, 0, "a cancelled reason abandons the observation");
});

test("a differing second observation sends the entered reason with the suggestion", async (t) => {
  await mount(t);
  script.promptAnswer = "Shelf count was short by one case";
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  assert.equal(script.promptCalls.length, 1);
  assert.equal(script.executionBodies.length, 1);
  assert.equal(script.executionBodies[0]!.observation, "second");
  assert.equal(script.executionBodies[0]!.reason, "Shelf count was short by one case");
});
