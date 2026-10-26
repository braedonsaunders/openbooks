import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";
import { recordApprovalState } from "../../../testing/record-approval-state";

await bootJsdomEnvironment({ url: "http://localhost/inbox", matchMediaMatches: false });
stubModules({
  navigation: `export function useRouter(){return{push(){},replace(){},refresh(){}}}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function usePathname(){return window.location.pathname}`,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { ApprovalRequestHost } = await import("./ApprovalRequestHost");
const ID = "00000000-0000-4000-8000-000000000001";
const detail = {
  subjectKind: "customer_change_order",
  subjectId: ID,
  fields: [
    { key: "number", label: "Change order", type: "text", value: "CO-12" },
    { key: "amount", label: "Amount", type: "number", value: "9007199254740993.1250" },
  ],
  submittedAt: "2026-10-01T10:00:00Z",
  changed: false,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function mount(reply: () => Promise<Response>) {
  window.history.replaceState(
    {},
    "",
    `/inbox?tab=mine&reviewKind=customer_change_order&review=${ID}`,
  );
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input) =>
    String(input).startsWith("/api/flows/record-state")
      ? Response.json(recordApprovalState({ status: "draft", gateId: "gate-1", canDecide: true }))
      : reply()) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalRequestHost />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return {
    async close() {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = previous;
    },
  };
}

test("request terms replace loading within one drawer and preserve exact decimals", async () => {
  let finish!: (response: Response) => void;
  const view = await mount(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const shell = document.querySelector("[role=dialog]")!;
    assert.ok(shell);
    assert.equal(document.querySelectorAll("[role=dialog]").length, 1);
    await act(async () => {
      finish(Response.json(detail));
      await tick();
    });
    assert.equal(document.querySelector("[role=dialog]"), shell);
    assert.match(shell.textContent ?? "", /CO-12/);
    assert.match(shell.textContent ?? "", /9,007,199,254,740,993\.125/);
    assert.ok(
      [...shell.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Approve",
      ),
    );
  } finally {
    await view.close();
  }
});

test("a missing request remains a named refusal in the selected drawer", async () => {
  const view = await mount(async () =>
    Response.json({ error: "The requested record is unavailable." }, { status: 404 }),
  );
  try {
    const shell = document.querySelector("[role=dialog]")!;
    assert.ok(shell);
    assert.match(shell.textContent ?? "", /requested record is unavailable/);
    assert.equal(document.querySelectorAll("[role=dialog]").length, 1);
    assert.equal(
      [...shell.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Retry",
      ),
      false,
    );
    assert.equal(
      [...shell.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Approve",
      ),
      false,
    );
  } finally {
    await view.close();
  }
});

test("changed terms retain the request and require fresh review before a decision", async () => {
  const view = await mount(async () => Response.json({ ...detail, changed: true }));
  try {
    const shell = document.querySelector("[role=dialog]")!;
    assert.match(shell.textContent ?? "", /changed after submission/);
    const approve = [...shell.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Approve",
    )!;
    assert.ok(approve);
    assert.equal(approve.disabled, true);
  } finally {
    await view.close();
  }
});

test("a record with no submitted request labels its current terms truthfully", async () => {
  const view = await mount(async () => Response.json({ ...detail, submittedAt: null }));
  try {
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /Current terms/);
  } finally {
    await view.close();
  }
});
