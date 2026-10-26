import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// Bulk lifecycle on a documents list: keyboard selection, then each selected
// document runs its own submit/post commands with every outcome reported.
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: true });
stubModules({
  navigation: {
    pathname: "/ap/bills",
    routerSource:
      "export function useRouter(){return{push(){},refresh(){globalThis.__listRefreshes=(globalThis.__listRefreshes||0)+1},replace(){},back(){},forward(){},prefetch(){}}}",
  },
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { RecordListBulkTable } = await import("./record-list-bulk");
const { ShortcutProvider } = await import("./shortcuts/shortcut-provider");
const { ConfirmRoot } = await import("../lib/confirm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const rows = [
  { id: "d1", number: "BILL-1", status: "draft" },
  { id: "d2", number: "BILL-2", status: "approved" },
  { id: "d3", number: "BILL-3", status: "draft" },
  { id: "d4", number: "BILL-4", status: "posted" },
];

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ShortcutProvider>
          <RecordListBulkTable
            header={<th>Bill</th>}
            actions={{ submit: true, post: true }}
            rows={rows.map((row) => ({
              ...row,
              cells: (
                <td>
                  <a href={`#${row.id}`}>{row.number}</a>
                </td>
              ),
            }))}
          />
          <ConfirmRoot />
        </ShortcutProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return {
    host,
    async done() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
    await tick();
  });
}

test("j/k move between rows and x / Shift+x select, offering only the actions each row allows", async (t) => {
  const { host, done } = await mount();
  t.after(done);
  await press("j");
  await press("x");
  await press("j");
  await press("j");
  await press("X", { shiftKey: true });
  const checked = [
    ...host.querySelectorAll<HTMLInputElement>('[data-bulk-row] input[type="checkbox"]'),
  ].map((box) => box.checked);
  assert.deepEqual(checked, [true, true, true, false]);
  assert.match(host.textContent ?? "", /3 selected/);
  assert.match(
    host.textContent ?? "",
    /Post 3 documents/,
    "two drafts and one approved bill can post",
  );
  assert.match(host.textContent ?? "", /Submit 2 drafts/, "only drafts can be submitted");
});

test("posting runs each document through its own commands and reports approvals and refusals", async (t) => {
  const calls: { action: string; documentId: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string; documentId: string };
    calls.push(body);
    const respond = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (body.documentId === "d3" && body.action === "post")
      return respond(200, { pendingApproval: true });
    if (body.documentId === "d2" && body.action === "post")
      return respond(422, {
        error: "The period is closed. Reopen it in Close or choose an open date.",
      });
    return respond(200, { ok: true });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { host, done } = await mount();
  t.after(done);
  await act(async () => {
    (host.querySelector('input[aria-label="Select all on this page"]') as HTMLInputElement).click();
    await tick();
  });
  const postButton = [...host.querySelectorAll("button")].find((button) =>
    /^Post \d+ documents$/.test(button.textContent ?? ""),
  )!;
  await act(async () => {
    postButton.click();
    await tick();
  });
  const confirm = [...document.querySelectorAll("button")].find(
    (button) => /^Post 3 documents$/.test(button.textContent ?? "") && button !== postButton,
  )!;
  await act(async () => {
    confirm.click();
    await tick();
    await tick();
    await tick();
  });
  assert.deepEqual(
    calls,
    [
      { action: "post", documentId: "d1" },
      { action: "post", documentId: "d2" },
      { action: "post", documentId: "d3" },
    ],
    "drafts and approved bills use native posting, approval-gated drafts stop at approval, posted bills are untouched",
  );
  assert.match(host.textContent ?? "", /1 posted · 1 sent for approval · 1 refused/);
  assert.match(host.textContent ?? "", /BILL-2 — The period is closed/);
  const stillSelected = [
    ...host.querySelectorAll<HTMLInputElement>('[data-bulk-row] input[type="checkbox"]'),
  ].map((box) => box.checked);
  assert.deepEqual(
    stillSelected,
    [false, true, false, false],
    "only the refused document stays selected",
  );
  assert.ok(
    ((globalThis as { __listRefreshes?: number }).__listRefreshes ?? 0) > 0,
    "the list refreshes after the run",
  );
});
