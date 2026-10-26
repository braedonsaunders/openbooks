import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";

const { bootJsdomEnvironment } = await import("../testing/jsdom-env");
await bootJsdomEnvironment({ event: "jsdom" });
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const { DataTransferPicker } = await import("./data-transfer-picker");

const messages = Object.fromEntries(
  ["common", "data", "ui"].map((namespace) => [
    namespace,
    JSON.parse(readFileSync(new URL(`../messages/en/${namespace}.json`, import.meta.url), "utf8")),
  ]),
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a failed recent-transfer load offers a retry that reloads the list", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    assert.equal(url, "/api/data/transfers");
    requests++;
    return requests === 1
      ? new Response("<html>Bad gateway</html>", { status: 502 })
      : Response.json({
          jobs: [{ id: "job-1", kind: "import", filename: "invoices.csv", state: "ready" }],
        });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <DataTransferPicker kind="import" job={null} onChange={() => {}} />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    assert.match(host.textContent ?? "", /Could not load recent transfers\. \(status 502\)/);
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === messages.common.actions.retry,
    );
    assert.ok(retry, "the failed load offers a retry action");
    await act(async () => {
      retry.click();
      await tick();
    });
    assert.equal(requests, 2, "retry issues a new list request");
    assert.match(host.textContent ?? "", /invoices\.csv/);
    assert.doesNotMatch(
      host.textContent ?? "",
      /Could not load/,
      "the failure copy clears after a successful retry",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
