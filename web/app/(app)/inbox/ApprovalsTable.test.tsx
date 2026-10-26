import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";
import type { ApprovalRow } from "./ApprovalsTable";

await bootJsdomEnvironment({ url: "http://localhost:4800/inbox" });
const notices: string[] = [];
Object.assign(globalThis, { __approvalNotices: notices });
stubModules({ navigation: { pathname: "/inbox" } });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={error(message){globalThis.__approvalNotices.push(message)},warning(message){globalThis.__approvalNotices.push(message)},success(message){globalThis.__approvalNotices.push(message)}}",
      };
    return next(specifier, context);
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { ApprovalsTable } = await import("./ApprovalsTable");

function row(
  key: string,
  gateId: string | null,
  signatureRequired = false,
  overrides: Partial<ApprovalRow> = {},
): ApprovalRow {
  return {
    key,
    gateId,
    documentNumber: key,
    kind: "vendor_bill",
    kindLabel: "Bill",
    href: null,
    party: "Vendor",
    amount: "$10.00",
    approvalTitle: "Release payment",
    engineName: "Approval flow",
    requestedAt: "2026-09-29T12:00:00Z",
    assignee: "Approver",
    canDecide: true,
    canDelegate: false,
    quorumAll: false,
    signatureRequired,
    ...overrides,
  };
}

async function mount(
  t: TestContext,
  rows: ApprovalRow[],
  options: { bulk?: boolean; timeZone?: string; users?: { id: string; name: string }[] } = {},
) {
  notices.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone={options.timeZone ?? "UTC"}>
        <ApprovalsTable
          rows={rows}
          users={options.users ?? []}
          bulk={options.bulk ?? true}
          showAssignee
          actionsEnabled
        />
      </NextIntlClientProvider>,
    ),
  );
  return host;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
function approve(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find((node) =>
    /Approve selected/i.test(node.textContent ?? ""),
  );
  assert.ok(button, "the bulk approve action must remain available");
  return button;
}

test("selection and partial results operate only on flow gates in the server window", async (t) => {
  let payload: { items: { gateId: string }[] } | undefined;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return Response.json({
      results: [{ ok: true }, { ok: false, error: "The submitter cannot approve this payment." }],
    });
  });
  const host = await mount(t, [
    row("gate:first", "00000000-0000-4000-8000-000000000001"),
    row("doc:invoice", null),
    row("payrun:run", null),
    row("gate:second", "00000000-0000-4000-8000-000000000002"),
  ]);
  const boxes = [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
  assert.equal(boxes.length, 3, "documents and pay runs cannot enter a gate-scoped bulk decision");
  await click(boxes[0]!);
  await click(approve(host));
  assert.deepEqual(
    payload?.items.map((item) => item.gateId),
    ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
  );
  assert.ok(notices.some((notice) => notice.includes("submitter cannot approve")));
  assert.equal(boxes[1]!.checked, false, "confirmed success clears its selection");
  assert.equal(boxes[2]!.checked, true, "a refused record remains selected");
});

test("signature-required gates retain individual approval and refuse bulk approval", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ results: [{ ok: true }] });
  });
  const host = await mount(t, [row("gate:signed", "00000000-0000-4000-8000-000000000001", true)]);
  await click(host.querySelector<HTMLInputElement>("input[type=checkbox]")!);
  await click(approve(host));
  assert.equal(requests, 0);
  assert.ok(notices.some((notice) => /signature/i.test(notice)));
  assert.ok(
    [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Approve"),
    "the individual action named by the remedy must exist",
  );
});

test("an unreadable error response releases busy state and retains selection", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>Unavailable</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
  );
  const host = await mount(t, [row("gate:pending", "00000000-0000-4000-8000-000000000001")]);
  await click(host.querySelector<HTMLInputElement>("input[type=checkbox]")!);
  await click(approve(host));
  assert.equal(approve(host).disabled, false);
  assert.equal(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!.checked, true);
  assert.ok(notices.length > 0);
  assert.ok(notices.every((notice) => !/JSON|Unexpected token|SyntaxError/.test(notice)));
});

test("a missing bulk receipt never reports successful approval", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ results: [] }));
  const host = await mount(t, [row("gate:pending", "00000000-0000-4000-8000-000000000001")]);
  await click(host.querySelector<HTMLInputElement>("input[type=checkbox]")!);
  await click(approve(host));
  assert.ok(notices.length > 0);
  assert.ok(notices.every((notice) => !/^Approved/.test(notice)));
  assert.equal(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!.checked, true);
});

test("every refused gate is named with its own remedy", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      results: [
        {
          ok: false,
          error: "Choose another approver; the submitter cannot approve.",
        },
        {
          ok: false,
          error: "Approve the signature-required gate individually.",
        },
      ],
    }),
  );
  const host = await mount(t, [
    row("BILL-101", "00000000-0000-4000-8000-000000000001"),
    row("BILL-202", "00000000-0000-4000-8000-000000000002"),
  ]);
  await click(host.querySelector<HTMLInputElement>("input[type=checkbox]")!);
  await click(approve(host));
  assert.ok(
    notices.some(
      (notice) =>
        notice.includes("BILL-101: Choose another approver") &&
        notice.includes("BILL-202: Approve the signature-required gate individually"),
    ),
  );
  assert.ok(
    [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].every(
      (box) => box.checked,
    ),
  );
});

test("a null receipt shows the decision refusal rather than an internal type error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(null));
  const host = await mount(t, [row("gate:pending", "00000000-0000-4000-8000-000000000001")]);
  await click(host.querySelector<HTMLInputElement>("input[type=checkbox]")!);
  await click(approve(host));
  assert.ok(notices.includes("Decision failed"));
  assert.equal(approve(host).disabled, false);
});

function buttonsIn(host: HTMLElement, documentNumber: string): string[] {
  const tableRow = [...host.querySelectorAll("tr")].find((node) =>
    node.textContent?.includes(documentNumber),
  );
  assert.ok(tableRow, `row ${documentNumber} renders`);
  return [...tableRow.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
}

test("the organization view offers decisions only on rows the viewer may decide", async (t) => {
  const host = await mount(
    t,
    [
      row("MINE-1", "00000000-0000-4000-8000-000000000001"),
      row("OTHER-1", "00000000-0000-4000-8000-000000000002", false, {
        canDecide: false,
        assignee: "Dana Approver",
      }),
      row("OTHER-2", "00000000-0000-4000-8000-000000000003", false, {
        canDecide: false,
        canDelegate: true,
        assignee: "Controllers",
      }),
      row("SOD-1", "00000000-0000-4000-8000-000000000004", false, {
        awaitingAnotherApprover: true,
      }),
      row("WEEK-1", null, false, { kind: "timesheet_week", canDecide: false }),
    ],
    {
      bulk: false,
      users: [{ id: "00000000-0000-4000-8000-0000000000aa", name: "Riley Delegate" }],
    },
  );
  assert.deepEqual(buttonsIn(host, "MINE-1"), ["Approve", "Reject"]);
  assert.deepEqual(buttonsIn(host, "OTHER-1"), [], "another approver's gate offers no decision");
  assert.deepEqual(buttonsIn(host, "OTHER-2"), ["Delegate"], "an admin may still hand the gate on");
  assert.deepEqual(buttonsIn(host, "SOD-1"), []);
  assert.match(host.textContent ?? "", /Awaiting another approver/);
  assert.deepEqual(
    buttonsIn(host, "WEEK-1"),
    [],
    "a week the viewer cannot approve offers no Approve",
  );
  assert.match(host.textContent ?? "", /Dana Approver/);
  assert.match(host.textContent ?? "", /Controllers/);
});

test("undecidable gates never enter the bulk selection", async (t) => {
  const host = await mount(t, [
    row("MINE-1", "00000000-0000-4000-8000-000000000001"),
    row("OTHER-1", "00000000-0000-4000-8000-000000000002", false, { canDecide: false }),
  ]);
  assert.equal(
    host.querySelectorAll("input[type=checkbox]").length,
    2,
    "select-all plus the one decidable gate",
  );
});

test("the requested date renders in the viewer locale and time zone", async (t) => {
  // 02:00 UTC on 30 September is still 29 September in Toronto.
  const host = await mount(
    t,
    [
      row("LATE-1", "00000000-0000-4000-8000-000000000001", false, {
        requestedAt: "2026-09-30T02:00:00.000Z",
      }),
    ],
    {
      timeZone: "America/Toronto",
    },
  );
  const text = host.textContent ?? "";
  assert.match(text, /Sep 29, 2026/);
  assert.doesNotMatch(text, /2026-09-30/, "never the raw ISO instant");
});
