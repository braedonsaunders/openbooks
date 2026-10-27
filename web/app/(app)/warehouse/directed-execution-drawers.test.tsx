import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ReactNode } from "react";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost:4800/warehouse", matchMediaMatches: false });
const navigations: string[] = [];
let refreshes = 0;
Object.assign(globalThis, {
  __executionDrawerRouter: {
    push: (href: string) => navigations.push(href),
    replace: (href: string) => navigations.push(href),
    refresh: () => {
      refreshes++;
    },
  },
});
stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__executionDrawerRouter}" +
      "export function usePathname(){return window.location.pathname}" +
      "export function useSearchParams(){return new URLSearchParams(window.location.search)}",
  },
  intl: false,
  authz: false,
  features: false,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = {
  common: (await import("../../../messages/en/common.json", { with: { type: "json" } })).default,
  ui: (await import("../../../messages/en/ui.json", { with: { type: "json" } })).default,
  warehouse: (await import("../../../messages/en/warehouse.json", { with: { type: "json" } }))
    .default,
};
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { ReceiptQueue } = await import("./ReceiptQueue");
const { PutawayQueue } = await import("./PutawayQueue");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function mount(t: TestContext, node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-10-15">{node}</BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  assert.ok(found, `${label} must be available`);
  return found;
}
async function press(node: HTMLElement) {
  await act(async () => {
    node.click();
    await tick();
  });
}
async function escape() {
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
}
async function waitForDismissal() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (document.querySelector('[role="dialog"]') === null) return;
    await act(async () => {
      await tick();
    });
  }
  assert.fail("the native execution dialog must finish its exit after authorized dismissal");
}
type RequestBody = {
  action: string;
  commandKey?: string;
  taskId?: string;
  lineId?: string;
  quantity?: string;
  lotId?: string | null;
  serialId?: string | null;
  date?: string;
};
const task = {
  id: "9fc77626-3d28-44e9-bab1-270cb23810da",
  stage: "receipt",
  status: "suggested",
  itemLabel: "Tracked widget",
  binCode: "RECEIVE-1",
  quantity: "3.0000",
  unit: "ea",
  baseQuantity: "3.0000",
  lotNumber: "LOT-17",
  serialNumber: null,
  barcodeScanning: false,
};

for (const kind of ["receipt", "putaway"] as const) {
  test(`${kind} keeps one dialog through a lost response and retry, blocks busy dismissal and confirms the retained task`, async (t) => {
    const requests: RequestBody[] = [];
    const first = deferred<Response>(),
      retry = deferred<Response>(),
      confirmation = deferred<Response>();
    const originalFetch = globalThis.fetch;
    const overflow = document.body.style.overflow;
    navigations.length = 0;
    refreshes = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/inventory/execution");
      assert.equal(init?.method, "POST");
      requests.push(JSON.parse(String(init?.body)) as RequestBody);
      return requests.length === 1
        ? first.promise
        : requests.length === 2
          ? retry.promise
          : requests.at(-1)?.action === "confirm"
            ? confirmation.promise
            : Response.json({ task: { ...task, stage: kind } });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    await mount(
      t,
      kind === "receipt" ? (
        <ReceiptQueue
          rows={[
            {
              lineId: "receipt-line-1",
              number: "GR-17",
              itemLabel: "Tracked widget",
              binCode: "RECEIVE-1",
              quantity: "3.0000",
              confirmed: false,
            },
          ]}
          canPost
        />
      ) : (
        <PutawayQueue
          rows={[
            {
              warehouseId: "warehouse-1",
              warehouseCode: "MAIN",
              stagingLocationId: "stage-1",
              stagingCode: "RECEIVE-1",
              itemId: "item-1",
              itemLabel: "Tracked widget",
              subsidiaryId: "sub-1",
              quantity: "3.0000",
              lotId: "lot-17",
              serialId: null,
              lotNumber: "LOT-17",
              serialNumber: null,
            },
          ]}
          canPost
        />
      ),
    );
    const trigger = button(
      kind === "receipt" ? "Confirm receipt" : messages.warehouse.putaway.action,
    );
    trigger.focus();
    await press(trigger);
    let shell = document.querySelector('[role="dialog"]');
    assert.ok(shell);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(shell.querySelector('[aria-busy="true"]'));
    assert.equal(document.body.style.overflow, "hidden");
    await escape();
    assert.ok(
      document.querySelector('[role="dialog"]') === shell,
      "a pending native command cannot be dismissed",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.action, kind === "receipt" ? "receive" : "putaway");
    assert.ok(requests[0]!.commandKey);
    if (kind === "putaway") {
      assert.equal(requests[0]!.quantity, "3.0000");
      assert.equal(requests[0]!.lotId, "lot-17");
      assert.equal(requests[0]!.date, "2026-10-15");
    } else assert.equal(requests[0]!.lineId, "receipt-line-1");

    await act(async () => {
      first.reject(new Error("Warehouse response was lost"));
      await tick();
    });
    assert.ok(
      document.querySelector('[role="dialog"]') === shell,
      "request phases must retain the same dialog element",
    );
    assert.match(shell.textContent ?? "", /Warehouse response was lost/);
    await press(button(messages.common.actions.retry));
    assert.deepEqual(
      requests[1],
      requests[0],
      "transport retry keeps the original command and financial subject",
    );
    assert.ok(
      document.querySelector('[role="dialog"]') === shell,
      "request phases must retain the same dialog element",
    );
    await act(async () => {
      retry.resolve(Response.json({ task: { ...task, stage: kind } }));
      await tick();
    });
    assert.ok(
      document.querySelector('[role="dialog"]') === shell,
      "request phases must retain the same dialog element",
    );
    assert.match(shell.textContent ?? "", /LOT-17/);
    await escape();
    await waitForDismissal();
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "an idle command uses the native local dismissal callback",
    );
    assert.equal(document.body.style.overflow, overflow);
    assert.ok(
      document.activeElement === trigger,
      "idle dismissal restores focus to the selected row action",
    );
    await press(trigger);
    shell = document.querySelector('[role="dialog"]');
    assert.ok(shell);
    assert.deepEqual(
      requests[2],
      requests[0],
      "reopening the same prepared subject retains its native command identity",
    );
    await press(button("Confirm"));
    assert.deepEqual(requests[3], { action: "confirm", taskId: task.id });
    await escape();
    assert.ok(
      document.querySelector('[role="dialog"]') === shell,
      "confirmation retains the same busy-close gate",
    );
    await act(async () => {
      confirmation.resolve(Response.json({ status: "done" }));
      await tick();
    });
    await waitForDismissal();
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "no execution dialog may remain after completion or without authority",
    );
    assert.equal(refreshes, 1);
    assert.deepEqual(
      navigations,
      [],
      "local execution does not navigate to a fabricated URL destination",
    );
    assert.equal(window.location.pathname, "/warehouse");
    assert.equal(document.body.style.overflow, overflow);
    assert.ok(
      document.activeElement === trigger,
      "native dismissal restores focus to the selected row action",
    );
  });
}

test("receipt and putaway readers without the posting grant cannot open an execution dialog", async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("read-only queues must not issue commands");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await mount(
    t,
    <>
      <ReceiptQueue
        rows={[
          {
            lineId: "line-1",
            number: "GR-17",
            itemLabel: "Widget",
            binCode: "RECEIVE",
            quantity: "3",
            confirmed: false,
          },
        ]}
        canPost={false}
      />
      <PutawayQueue
        rows={[
          {
            warehouseId: "warehouse-1",
            warehouseCode: "MAIN",
            stagingLocationId: "stage-1",
            stagingCode: "RECEIVE",
            itemId: "item-1",
            itemLabel: "Widget",
            subsidiaryId: "sub-1",
            quantity: "3",
            lotId: null,
            serialId: null,
            lotNumber: null,
            serialNumber: null,
          },
        ]}
        canPost={false}
      />
    </>,
  );
  assert.ok(
    document.querySelector('[role="dialog"]') === null,
    "no execution dialog may remain after completion or without authority",
  );
  assert.equal(
    [...document.querySelectorAll("button")].filter((node) =>
      ["Confirm receipt", messages.warehouse.putaway.action].includes(
        node.textContent?.trim() ?? "",
      ),
    ).length,
    0,
  );
  assert.equal(calls, 0);
});
