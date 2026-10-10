import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env";
import { stubModules } from "../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost:4800/warehouse" });
stubModules({ intl: false, authz: false, features: false });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { DirectedExecutionForm, useDirectedExecution } =
  await import("./directed-execution");
const suggestion = {
  id: "11111111-1111-4111-8111-111111111111",
  stage: "putaway",
  status: "open",
  itemLabel: "Widget",
  binCode: "A1",
  quantity: "2",
  unit: "ea",
  baseQuantity: "2.0000",
  lotNumber: null,
  serialNumber: null,
  barcodeScanning: true,
};

function Harness({ done }: { done: () => void }) {
  const work = useDirectedExecution("/api/inventory/execution", done);
  return work.task ? (
    <DirectedExecutionForm
      task={work.task}
      busy={work.busy}
      error={work.error}
      onConfirm={work.confirm}
      onBack={work.clear}
    />
  ) : (
    <>
      <button
        onClick={() => work.prepare({ action: "putaway", itemId: "item" })}
      >
        Prepare
      </button>
      {work.error ? <p role="alert">{work.error}</p> : null}
    </>
  );
}
async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
  assert.ok(button, `button ${text} must be visible`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

test("a mismatch retains the original suggestion and task; lost responses retry the same command identity", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host),
    prior = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = prior;
    await act(async () => root.unmount());
    host.remove();
  });
  const requests: Record<string, unknown>[] = [];
  let preparing = 0,
    confirming = 0,
    completed = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (body.action === "putaway") {
      if (++preparing === 1) throw new TypeError("lost suggestion response");
      return Response.json({ task: suggestion });
    }
    if (++confirming === 1)
      return Response.json({
        status: "exception",
        reason: "Bin scan does not match the suggested bin",
      });
    if (confirming === 2) throw new TypeError("lost confirmation response");
    return Response.json({ status: "done", replayed: true });
  }) as typeof fetch;
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Harness
          done={() => {
            completed++;
          }}
        />
      </NextIntlClientProvider>,
    ),
  );
  await click(host, "Prepare");
  assert.match(host.textContent!, /lost suggestion/);
  await click(host, "Prepare");
  assert.equal(requests[0]!.commandKey, requests[1]!.commandKey);
  const inputs = [...host.querySelectorAll("input")];
  assert.equal(inputs.length, 3);
  await enter(inputs[0]!, "Widget");
  await enter(inputs[1]!, "WRONG");
  await enter(inputs[2]!, "2");
  await click(host, "Confirm");
  assert.match(
    host.querySelector('[role="alert"]')!.textContent!,
    /does not match/,
  );
  assert.equal(
    host.querySelector("dd.font-mono")!.textContent,
    "A1",
    "scan never replaces the suggested bin",
  );
  assert.equal(completed, 0);
  await enter(inputs[1]!, "A1");
  await click(host, "Confirm");
  assert.match(host.textContent!, /lost confirmation/);
  await click(host, "Confirm");
  assert.equal(completed, 1);
  const confirms = requests.filter((body) => body.action === "confirm");
  assert.ok(confirms.every((body) => body.taskId === suggestion.id));
  assert.ok(
    confirms.every(
      (body) =>
        !("toBinId" in body) && !("itemId" in body) && !("quantity" in body),
    ),
    "confirmation carries observations and task identity, never replacement suggestion coordinates",
  );
});

test("an HTTP refusal keeps the suggestion and displays an actionable error before parsing success", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host),
    prior = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = prior;
    await act(async () => root.unmount());
    host.remove();
  });
  globalThis.fetch = (async (_input, init) =>
    JSON.parse(String(init?.body)).action === "putaway"
      ? Response.json({ task: { ...suggestion, barcodeScanning: false } })
      : Response.json(
          { error: "Putaway rule changed; refresh the suggestion" },
          { status: 409 },
        )) as typeof fetch;
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Harness done={() => assert.fail("refusal cannot complete work")} />
      </NextIntlClientProvider>,
    ),
  );
  await click(host, "Prepare");
  assert.equal(host.querySelectorAll("input").length, 0);
  await click(host, "Confirm");
  assert.match(
    host.querySelector('[role="alert"]')!.textContent!,
    /Putaway rule changed/,
  );
  assert.equal(host.querySelector("dd.font-mono")!.textContent, "A1");
});
