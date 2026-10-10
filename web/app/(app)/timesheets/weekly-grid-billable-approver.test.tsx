// An approver (time.approve, no time.manage) can retarget the billable flag
// on submitted lines in the review grid before approval: the BILL checkbox
// stays enabled although the row is otherwise immutable, the flag posts
// immediately through the native billable route, and a typed refusal
// (approved/invoiced) pins beside the actions with its remedy.
import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/timesheets?timesheet=emp-9:2026-07-12",
  matchMediaMatches: false,
});

const script = {
  toasts: [] as { kind: string; message: unknown }[],
  posts: [] as { url: string; body: unknown }[],
  billableStatus: 200 as number,
  billableBody: {} as Record<string, unknown>,
};
Object.assign(globalThis, {
  __gridBillableApprover: script,
  __gridBillableApproverRouter: { push() {}, replace() {}, refresh() {} },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridBillableApproverRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      "export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
    sonner:
      "export const toast={success(m){globalThis.__gridBillableApprover.toasts.push({kind:'success',message:m})},error(m,o){globalThis.__gridBillableApprover.toasts.push({kind:'error',message:m,options:o})},warning(){},info(){}};export function Toaster(){return null}",
    "../../../lib/confirm":
      "export async function confirmDialog(){return true}",
    "../../../lib/prompt": "export async function promptDialog(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { WeeklyGrid } = await import("./WeeklyGrid");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const DAYS = ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"];

function submittedPayload() {
  return {
    employeeId: "emp-9",
    week: "2026-07-12",
    days: DAYS,
    rows: [
      {
        projectId: "proj-9",
        itemId: "item-9",
        timeTypeId: "tt-9",
        departmentId: null,
        isBillable: true,
        memo: null,
        hours: ["", "", "", "8", "", "", ""],
        entryStatuses: ["submitted"],
        custom: {},
        amendsEntryId: null,
        immutable: true,
      },
    ],
    status: "submitted",
    hasApproved: false,
    lockReasons: [],
    lockedCount: 0,
    rejectionReason: null,
    weekId: "week-9",
    revision: "rev-1",
  } as never;
}

const PICKERS = {
  employees: [{ value: "emp-9", label: "Billable Approver Worker" }],
  projects: [{ value: "proj-9", label: "Client job" }],
  items: [{ value: "item-9", label: "Service" }],
  timeTypes: [{ value: "tt-9", label: "Regular" }],
  departments: [],
};

async function mountGrid(status: string, entryStatuses: string[]) {
  script.toasts = [];
  script.posts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith("/api/timesheets/billable") && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(script.billableBody), {
        status: script.billableStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  const payload = submittedPayload() as unknown as Record<string, unknown>;
  payload.status = status;
  (payload.rows as Record<string, unknown>[])[0]!.entryStatuses = entryStatuses;
  (payload.rows as Record<string, unknown>[])[0]!.immutable = entryStatuses.some((s) => s === "approved" || s === "submitted");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(
        BusinessDateProvider,
        { today: "2026-07-14" },
        React.createElement(
          NextIntlClientProvider,
          { locale: "en", messages, timeZone: "UTC" },
          React.createElement(
            MoneyProvider,
            { currency: "USD" },
            React.createElement(WeeklyGrid, {
              employeeId: "emp-9",
              week: "2026-07-12",
              payload,
              pickers: PICKERS,
              canManage: false,
              canApprove: true,
              canReopen: false,
              approveBlockedReason: null,
            }),
          ),
        ),
      ),
    );
    await tick();
  });
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

function billableBox(): HTMLInputElement {
  const box = document.querySelector('input[aria-label="Line 1 billable"]') as HTMLInputElement | null;
  assert.ok(box, "the review grid offers the line billable checkbox");
  return box;
}

function flippedPayload() {
  const payload = submittedPayload() as unknown as Record<string, unknown>;
  (payload.rows as Record<string, unknown>[])[0]!.isBillable = false;
  payload.revision = "rev-2";
  return payload;
}

test("an approver retargets billable on a submitted line through the billable route", async (t) => {
  script.billableStatus = 200;
  script.billableBody = flippedPayload();
  const { cleanup } = await mountGrid("submitted", ["submitted"]);
  t.after(cleanup);
  const box = billableBox();
  assert.equal(box.disabled, false, "the approver's BILL checkbox stays enabled on a submitted line");
  assert.equal(box.checked, true);
  // Hours stay read-only: only the flag is approver-editable.
  const hourInputs = [...document.querySelectorAll('input[type="number"]')];
  assert.equal(hourInputs.length, 0, "submitted hour cells render as text, never as inputs");
  await act(async () => {
    box.click();
    await tick(120);
  });
  await tick(120);
  assert.equal(script.posts.length, 1, "the flag posts immediately, never as a local draft");
  const sent = script.posts[0]!.body as { employee: string; week: string; line: Record<string, unknown>; isBillable: boolean };
  assert.equal(sent.employee, "emp-9");
  assert.equal(sent.week, "2026-07-12");
  assert.equal(sent.isBillable, false, "unchecking marks the write-off");
  assert.equal(sent.line.projectId, "proj-9");
  const toasted = script.toasts.find((toast) => toast.kind === "success");
  assert.ok(toasted, "completion toasts");
  assert.match(String(toasted?.message ?? ""), /Billable flag updated/);
  const status = document.querySelector('[role="status"]');
  assert.ok(status, "completion pins a success status beside the actions");
});

test("a refused billable change pins with its remedy and flips nothing", async (t) => {
  script.billableStatus = 409;
  script.billableBody = {
    error: "this line is already approved — reopen or amend the week to change it",
    code: "line_approved",
    remedy: "Reopen or amend the week to change approved hours.",
  };
  const { cleanup } = await mountGrid("submitted", ["submitted"]);
  t.after(cleanup);
  t.after(() => {
    script.billableStatus = 200;
    script.billableBody = {};
  });
  const box = billableBox();
  await act(async () => {
    box.click();
    await tick(120);
  });
  await tick(120);
  assert.equal(script.posts.length, 1);
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal pins beside the actions, not only in a toast");
  assert.match(alert?.textContent ?? "", /already approved/);
  assert.match(alert?.textContent ?? "", /Reopen or amend/);
  assert.equal(billableBox().checked, true, "the refused toggle flips nothing");
});

test("an approved week's BILL checkbox is withdrawn from the approver", async (t) => {
  const { cleanup } = await mountGrid("approved", ["approved"]);
  t.after(cleanup);
  const box = billableBox();
  assert.equal(box.disabled, true, "approved lines refuse the flag change in the grid; the route refuses it too");
  box.click();
  await tick(60);
  assert.equal(script.posts.length, 0, "a disabled checkbox posts nothing");
});
