import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the workspace reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/admin/setup/shipping?tab=adjustments", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { AdjustmentImportClient } = await import("./AdjustmentImportClient");

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const native = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  native?.call(textarea, value);
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function mount(calls: { url: string; body?: unknown }[]): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot>; restore: () => void }> {
  const prior = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = prior;
  };
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    calls.push({ url, body });
    if (url.endsWith("/api/shipping/accounts")) {
      return Response.json(
        { accounts: [{ id: "a0000000-0000-0000-0000-000000000001", provider: "easypost", displayName: "Main", status: "active" }] },
        { status: 200 },
      );
    }
    if (url.endsWith("/api/shipping/adjustments")) {
      return Response.json({ adjustments: { imported: 2, skipped: 1 } }, { status: 200 });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AdjustmentImportClient />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await act(async () => { await tick(); });
  return {
    host,
    root,
    restore,
  };
}

async function unmount(host: HTMLDivElement, root: ReturnType<typeof createRoot>, restore: () => void): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  restore();
}

test("a pasted export previews its rows and imports them against the account", async (t) => {
  const calls: { url: string; body?: unknown }[] = [];
  const { host, root, restore } = await mount(calls);
  t.after(async () => {
    await unmount(host, root, restore);
  });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  assert.ok(textarea, "the paste box renders once accounts load");
  await act(async () => {
    setTextarea(textarea, JSON.stringify([
      { providerAdjustmentId: "adj_1", providerShipmentId: "shp_1", kind: "weight_correction", amount: "2.50", currency: "USD", reason: "reweigh" },
      { providerAdjustmentId: "adj_2", providerShipmentId: "shp_2", kind: "fuel", amount: "1.10", currency: "USD" },
    ]));
  });
  const previewButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Preview");
  assert.ok(previewButton, "the preview action is offered");
  await act(async () => {
    previewButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  const body = host.textContent ?? "";
  assert.ok(body.includes("adj_1"), "parsed rows preview with their provider ids");
  assert.ok(body.includes("Weight correction"), "kinds render with their labels");
  const importButton = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Import 2"));
  assert.ok(importButton, "the import action names its row count");
  await act(async () => {
    importButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  const posted = calls.find((call) => call.url.endsWith("/api/shipping/adjustments"));
  assert.deepEqual(posted?.body, {
    accountId: "a0000000-0000-0000-0000-000000000001",
    items: [
      { providerAdjustmentId: "adj_1", providerShipmentId: "shp_1", kind: "weight_correction", amount: "2.50", currency: "USD", reason: "reweigh", occurredAt: null },
      { providerAdjustmentId: "adj_2", providerShipmentId: "shp_2", kind: "fuel", amount: "1.10", currency: "USD", reason: null, occurredAt: null },
    ],
  });
  assert.match(host.textContent ?? "", /Imported 2.*skipped 1/i, "the result names imported and skipped rows");
});

test("an unusable paste refuses by name before anything posts", async (t) => {
  const calls: { url: string; body?: unknown }[] = [];
  const { host, root, restore } = await mount(calls);
  t.after(async () => {
    await unmount(host, root, restore);
  });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    setTextarea(textarea, "not json at all");
  });
  const previewButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Preview");
  assert.ok(previewButton);
  await act(async () => {
    previewButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  assert.match(host.textContent ?? "", /not valid JSON/, "the paste error names the fix");
  assert.ok(!calls.some((call) => call.url.endsWith("/api/shipping/adjustments")), "nothing posts on a refused paste");
});
