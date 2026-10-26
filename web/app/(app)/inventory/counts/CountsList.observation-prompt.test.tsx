import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

// A second count that differs from the first needs its reason before it is
// requested. This file drives the real reason prompt inside the count drawer:
// cancelling or dismissing it must say that nothing was recorded, and
// dismissing it must not close the drawer that holds the typed count.

await bootJsdomEnvironment({ url: "http://localhost:4800/inventory?inventoryView=counts" });

const COUNT_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const LINE_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const BIN_ID = "22222222-2222-4222-8222-222222222222";

const script = {
  posts: [] as Array<Record<string, unknown>>,
};
Object.assign(globalThis, {
  __observationPromptScript: script,
  __observationPromptRouter: {
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
      "export function useRouter(){return globalThis.__observationPromptRouter}" +
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
const { PromptRoot } = await import("../../../../lib/prompt");
const { ConfirmRoot } = await import("../../../../lib/confirm");
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
    blind: true,
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
      secondCountedQuantity: null,
      secondCountRequired: true,
      adjustmentMovementId: null,
      itemCode: "W-1",
      itemName: "Widget",
      stockLocationCode: "BIN-1",
      lotNumber: null,
      serialNumber: null,
      variance: null,
    },
  ],
};

async function mount(t: TestContext): Promise<void> {
  script.posts.length = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/inventory/execution") {
      script.posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const body = script.posts.at(-1)!;
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
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-23">
            <PromptRoot />
            <ConfirmRoot />
            <CountsList
              {...({
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
              } as unknown as React.ComponentProps<typeof CountsList>)}
            />
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

function countInput(): HTMLInputElement | null {
  return document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;
}

async function typeCount(value: string) {
  const input = countInput();
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

function reasonField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>("#prompt-input");
  assert.ok(field, "the reason prompt is open");
  return field;
}

function discardConfirmation(): Element | null {
  return document.querySelector("#confirm-title");
}

async function pressEscape(target: EventTarget) {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  await tick();
}

function notRecordedAlert(): Element | null {
  return (
    [...document.querySelectorAll('[role="alert"]')].find((node) =>
      /not recorded/i.test(node.textContent ?? ""),
    ) ?? null
  );
}

test("cancelling the reason prompt says the second count was not recorded and keeps the typed count", async (t) => {
  await mount(t);
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  reasonField();
  await click(buttonNamed(messages.common.confirm.cancel));
  assert.equal(script.posts.length, 0, "a cancelled reason records nothing");
  assert.ok(countInput(), "the count drawer stays open");
  assert.equal(countInput()!.value, "8", "the typed second count is kept");
  assert.ok(notRecordedAlert(), "the operator is told the second count was not recorded and why");
});

test("dismissing the reason prompt with Escape keeps the count drawer and the typed count", async (t) => {
  await mount(t);
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  const field = reasonField();
  await act(async () => {
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(script.posts.length, 0, "Escape records nothing");
  assert.ok(countInput(), "Escape closes only the prompt, not the count drawer");
  assert.equal(countInput()!.value, "8", "the typed second count survives the dismissal");
  assert.ok(notRecordedAlert(), "the dismissed observation is reported as not recorded");
});

test("a typed reason is submitted with the suggestion request", async (t) => {
  await mount(t);
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  const field = reasonField();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, "Short");
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await act(async () => {
    field.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
  });
  await tick();
  assert.equal(script.posts.length, 1, "a typed reason reaches the suggestion step");
  assert.equal(script.posts[0]!.reason, "Short");
});

test("a reason under the minimum is asked again with the typed text kept", async (t) => {
  await mount(t);
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  const field = reasonField();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, "Shor");
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await act(async () => {
    field.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
  });
  await tick();
  assert.equal(script.posts.length, 0, "a reason under the minimum is not sent");
  assert.equal(reasonField().value, "Shor", "the prompt re-opens with the typed reason");
  await act(async () => {
    setter.call(reasonField(), "Shortage found on the shelf");
    reasonField().dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await act(async () => {
    reasonField().form!.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
  });
  await tick();
  assert.equal(script.posts.length, 1);
  assert.equal(script.posts[0]!.reason, "Shortage found on the shelf");
});

test("Escape with an unsaved typed count asks before discarding it, and cancelling keeps the drawer", async (t) => {
  await mount(t);
  await typeCount("8");
  await pressEscape(document.body);
  assert.ok(discardConfirmation(), "the unsaved count is confirmed before the drawer closes");
  assert.equal(countInput()?.value, "8");
  await pressEscape(document.body);
  const answered = discardConfirmation()?.closest("[data-ui-overlay]");
  assert.ok(
    !answered || answered.hasAttribute("data-overlay-exiting"),
    "Escape answers the confirmation without a second one",
  );
  assert.ok(countInput(), "the count drawer stays open");
  assert.equal(countInput()!.value, "8", "the typed count is kept");
  assert.equal(script.posts.length, 0);
});
