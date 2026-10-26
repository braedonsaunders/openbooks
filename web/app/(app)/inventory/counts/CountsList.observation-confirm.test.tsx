import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

// A count observation is saved in two steps: Save requests a warehouse
// suggestion, then Confirm records it. The saved quantity must survive the
// confirmation and the refresh that follows it, and a refused confirmation
// must stay on screen with its reason.

await bootJsdomEnvironment({ url: "http://localhost:4800/inventory?inventoryView=counts" });

const COUNT_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const LINE_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const BIN_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

type Line = {
  id: string;
  itemId: string;
  stockLocationId: string;
  lotId: null;
  serialId: null;
  expectedQuantity: string | null;
  countedQuantity: string | null;
  secondCountedQuantity: string | null;
  secondCountRequired: boolean;
  adjustmentMovementId: null;
  itemCode: string;
  itemName: string;
  stockLocationCode: string;
  lotNumber: null;
  serialNumber: null;
  variance: string | null;
};

type Detail = { ok: true; header: Record<string, unknown>; lines: Line[] };

const script = {
  posts: [] as Array<Record<string, unknown>>,
  detail: null as Detail | null,
  confirmRefusals: [] as Array<{ status: number; body: Record<string, unknown> }>,
  promptAnswer: null as string | null,
  promptCalls: [] as Array<Record<string, unknown>>,
  toasts: [] as Array<{ kind: string; message: string }>,
  pendingTask: null as { quantity: string; observation: string; reason?: string } | null,
  barcodeScanning: false,
};
Object.assign(globalThis, {
  __observationConfirmScript: script,
  __observationConfirmRouter: {
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
      "export function useRouter(){return globalThis.__observationConfirmRouter}" +
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
      'export const toast={success(m){globalThis.__observationConfirmScript.toasts.push({kind:"success",message:String(m)})},error(m){globalThis.__observationConfirmScript.toasts.push({kind:"error",message:String(m)})},info(m){globalThis.__observationConfirmScript.toasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
    "@/lib/prompt":
      "export function promptDialog(options){const s=globalThis.__observationConfirmScript;s.promptCalls.push(options);const answer=s.promptAnswer;s.promptAnswer=null;return Promise.resolve(answer)}",
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

function line(overrides: Partial<Line> = {}): Line {
  return {
    id: LINE_ID,
    itemId: ITEM_ID,
    stockLocationId: BIN_ID,
    lotId: null,
    serialId: null,
    expectedQuantity: "10.0000",
    countedQuantity: null,
    secondCountedQuantity: null,
    secondCountRequired: false,
    adjustmentMovementId: null,
    itemCode: "W-1",
    itemName: "Widget",
    stockLocationCode: "BIN-1",
    lotNumber: null,
    serialNumber: null,
    variance: null,
    ...overrides,
  };
}

function detailWith(lines: Line[]): Detail {
  return {
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
    lines,
  };
}

/** The engine's effect of a confirmed observation, as the detail read reports it. */
function applyObservation(task: { quantity: string; observation: string; reason?: string }) {
  const current = script.detail!.lines[0]!;
  if (task.observation === "second") {
    script.detail = detailWith([
      {
        ...current,
        countedQuantity: task.quantity,
        secondCountedQuantity: task.quantity,
        secondCountRequired: false,
      },
    ]);
  } else {
    script.detail = detailWith([
      {
        ...current,
        countedQuantity: task.quantity,
        secondCountRequired: false,
      },
    ]);
  }
}

async function mount(t: TestContext, initial: Detail): Promise<void> {
  script.posts.length = 0;
  script.promptCalls.length = 0;
  script.promptAnswer = null;
  script.toasts.length = 0;
  script.confirmRefusals.length = 0;
  script.pendingTask = null;
  script.barcodeScanning = false;
  script.detail = initial;
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/inventory/execution") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      script.posts.push(body);
      if (body.action === "confirm") {
        const refusal = script.confirmRefusals.shift();
        if (refusal) return Response.json(refusal.body, { status: refusal.status });
        const pending = script.pendingTask!;
        applyObservation(pending);
        return Response.json({ status: "done", taskId: TASK_ID, result: {}, replayed: false });
      }
      script.pendingTask = {
        quantity: String(body.quantity),
        observation: String(body.observation),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      };
      return Response.json({
        task: {
          id: TASK_ID,
          stage: "count",
          status: "open",
          itemLabel: "W-1",
          binCode: "BIN-1",
          quantity: body.quantity,
          unit: null,
          baseQuantity: body.quantity,
          lotNumber: null,
          serialNumber: null,
          barcodeScanning: script.barcodeScanning,
        },
      });
    }
    if (method === "POST" && url === "/api/inventory/counts") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.action === "start") {
        script.detail = {
          ...script.detail!,
          header: { ...script.detail!.header, status: "counting" },
        };
      }
      return Response.json({ ok: true, replayed: false });
    }
    if (method === "GET" && url.includes("counts?id=")) return Response.json(script.detail);
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

function countInput(): HTMLInputElement {
  const input = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;
  assert.ok(input, "the counted-quantity input is rendered");
  return input;
}

async function typeCount(value: string) {
  const input = countInput();
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
  await tick();
}

function suggestionVisible(): boolean {
  return document.querySelector('section[aria-label="Confirm warehouse suggestion"]') !== null;
}

test("a first count saved through the warehouse suggestion is recorded and stays visible after Confirm", async (t) => {
  await mount(t, detailWith([line()]));
  await typeCount("7");
  await click(buttonNamed(messages.inventory.counts.actions.save));
  assert.ok(suggestionVisible(), "Save opens the warehouse suggestion for confirmation");
  assert.equal(script.posts.length, 1);
  assert.equal(script.posts[0]!.observation, "first");
  assert.equal(script.posts[0]!.quantity, "7");

  await click(buttonNamed("Confirm"));
  assert.equal(script.posts.length, 2, "Confirm sends exactly one confirmation");
  assert.equal(script.posts[1]!.action, "confirm");
  assert.equal(script.posts[1]!.taskId, TASK_ID);
  assert.equal(suggestionVisible(), false, "a recorded confirmation leaves the suggestion");
  assert.equal(
    script.detail!.lines[0]!.countedQuantity,
    "7",
    "the server recorded the first count",
  );
  assert.ok(
    script.toasts.some(
      (toast) => toast.kind === "success" && toast.message === messages.inventory.counts.updated,
    ),
    "a recorded first count announces its saved state",
  );
  assert.equal(
    countInput().value,
    "7",
    "the saved quantity remains in the counted input after the refresh",
  );
  assert.equal(
    document.querySelector('[role="alert"]'),
    null,
    "a recorded confirmation shows no refusal",
  );
});

test("a second count that agrees is recorded through the suggestion and stays visible after Confirm", async (t) => {
  await mount(t, detailWith([line({ countedQuantity: "7.0000", secondCountRequired: true })]));
  await typeCount("7");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  assert.equal(script.promptCalls.length, 0, "an agreeing second count asks for no reason");
  assert.ok(suggestionVisible(), "the second observation is offered for confirmation");
  assert.equal(script.posts[0]!.observation, "second");

  await click(buttonNamed("Confirm"));
  assert.equal(script.posts.length, 2);
  assert.equal(
    script.detail!.lines[0]!.secondCountedQuantity,
    "7",
    "the server recorded the second count",
  );
  assert.equal(suggestionVisible(), false);
  assert.ok(
    script.toasts.some(
      (toast) => toast.kind === "success" && toast.message === messages.inventory.counts.updated,
    ),
    "a recorded second count announces its saved state",
  );
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("a differing second count sends its reason and is recorded after Confirm", async (t) => {
  await mount(t, detailWith([line({ countedQuantity: "7.0000", secondCountRequired: true })]));
  script.promptAnswer = "Shelf count was short by one case";
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  assert.equal(script.promptCalls.length, 1, "a differing second count asks for its reason");
  assert.ok(suggestionVisible());
  assert.equal(script.posts[0]!.reason, "Shelf count was short by one case");

  await click(buttonNamed("Confirm"));
  assert.equal(script.posts.length, 2);
  assert.equal(script.posts[1]!.action, "confirm");
  assert.equal(
    script.detail!.lines[0]!.secondCountedQuantity,
    "8",
    "the differing second count is recorded",
  );
  assert.equal(suggestionVisible(), false);
});

test("a refused confirmation keeps its reason on screen with the suggestion", async (t) => {
  await mount(t, detailWith([line({ countedQuantity: "7.0000", secondCountRequired: true })]));
  script.promptAnswer = "Short";
  await typeCount("8");
  await click(buttonNamed(messages.inventory.counts.secondCount));
  script.confirmRefusals.push({
    status: 422,
    body: { error: "Explain why the second count differs from the first (at least 5 characters)" },
  });
  await click(buttonNamed("Confirm"));
  assert.equal(script.posts.length, 2);
  assert.equal(
    script.detail!.lines[0]!.secondCountedQuantity,
    null,
    "nothing is recorded on refusal",
  );
  assert.ok(suggestionVisible(), "the suggestion stays open so the operator can correct it");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal is shown");
  assert.match(alert.textContent ?? "", /at least 5 characters/);
});

test("a first count confirmed with scanned item, bin and quantity keeps the saved quantity visible", async (t) => {
  await mount(t, detailWith([line()]));
  script.barcodeScanning = true;
  await typeCount("7");
  await click(buttonNamed(messages.inventory.counts.actions.save));
  assert.ok(suggestionVisible());
  const scanned = [
    ...document.querySelectorAll('section[aria-label="Confirm warehouse suggestion"] input'),
  ] as HTMLInputElement[];
  assert.equal(scanned.length, 3, "item, bin and quantity scan fields are offered");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  const values = ["W-1", "BIN-1", "7"];
  for (const [index, input] of scanned.entries()) {
    await act(async () => {
      setter.call(input, values[index]);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
  }
  await click(buttonNamed("Confirm"));
  assert.equal(script.posts.length, 2);
  assert.deepEqual(script.posts[1]!.scan, { item: "W-1", bin: "BIN-1", quantity: "7" });
  assert.equal(script.detail!.lines[0]!.countedQuantity, "7");
  assert.equal(countInput().value, "7");
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("a new count started and then counted through the suggestion keeps the saved quantity visible", async (t) => {
  const draft = detailWith([line()]);
  await mount(t, { ...draft, header: { ...draft.header, status: "draft" } });
  await click(buttonNamed(messages.inventory.counts.actions.start));
  assert.equal(countInput().disabled, false, "the started count offers its counted input");
  await typeCount("7");
  await click(buttonNamed(messages.inventory.counts.actions.save));
  assert.ok(suggestionVisible());
  await click(buttonNamed("Confirm"));
  assert.equal(script.detail!.lines[0]!.countedQuantity, "7");
  assert.equal(countInput().value, "7");
  assert.equal(document.querySelector('[role="alert"]'), null);
});
