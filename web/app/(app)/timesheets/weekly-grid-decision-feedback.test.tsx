// Slow decisions must read as working, never as silent failures: Approve (and
// Reject) shows a disabled busy state with a spinner + progress label, a
// second click cannot double-post, and completion pins an explicit success
// status beside the actions (a toast alone vanishes) or the typed refusal.
import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/timesheets?timesheet=emp-1:2026-07-12",
  matchMediaMatches: false,
});

const script = {
  toasts: [] as { kind: string; message: unknown }[],
  posts: [] as { url: string; body: unknown }[],
  resolvers: [] as ((response: Response) => void)[],
};
Object.assign(globalThis, {
  __gridDecision: script,
  __gridDecisionRouter: { push() {}, replace() {}, refresh() {} },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridDecisionRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      "export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
    sonner:
      "export const toast={success(m){globalThis.__gridDecision.toasts.push({kind:'success',message:m})},error(m,o){globalThis.__gridDecision.toasts.push({kind:'error',message:m,options:o})},warning(){},info(){}};export function Toaster(){return null}",
    "../../../lib/confirm":
      "export async function confirmDialog(){return true}",
    "../../../lib/prompt": "export async function promptDialog(){return 'Needs rework before approval'}",
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

function weekPayload() {
  return {
    employeeId: "emp-1",
    week: "2026-07-12",
    days: DAYS,
    rows: [
      {
        projectId: null,
        itemId: null,
        timeTypeId: null,
        departmentId: null,
        isBillable: false,
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
    weekId: "week-1",
    revision: "rev-1",
  } as never;
}

const PICKERS = {
  employees: [{ value: "emp-1", label: "Decision Worker" }],
  projects: [],
  items: [],
  timeTypes: [],
  departments: [],
};

function approvedPayload() {
  const payload = weekPayload() as unknown as Record<string, unknown>;
  return { ...payload, status: "approved", revision: "rev-2", rows: [] };
}

function rejectedPayload() {
  const payload = weekPayload() as unknown as Record<string, unknown>;
  return { ...payload, status: "rejected", revision: "rev-2", rejectionReason: "Needs rework before approval", rows: [] };
}

async function mountGrid() {
  script.toasts = [];
  script.posts = [];
  script.resolvers = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith("/api/timesheets/approve") && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Promise<Response>((resolve) => script.resolvers.push(resolve));
    }
    if (url.startsWith("/api/timesheets/reject") && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Promise<Response>((resolve) => script.resolvers.push(resolve));
    }
    return Response.json({});
  }) as typeof fetch;
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
              employeeId: "emp-1",
              week: "2026-07-12",
              payload: weekPayload(),
              pickers: PICKERS,
              canManage: true,
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

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
}

async function resolveNext(payload: unknown) {
  const resolve = script.resolvers.shift();
  assert.ok(resolve, "a decision request must be in flight");
  await act(async () => {
    resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    await tick(120);
  });
  await tick(120);
}

test("a slow approval shows its busy state, posts once, then pins success", async (t) => {
  const { cleanup } = await mountGrid();
  t.after(cleanup);
  const button = buttonNamed("Approve");
  assert.ok(button, "Approve renders on a submitted week");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  const busyButton = buttonNamed("Approving…");
  assert.ok(busyButton, "Approve flips to its progress label while the request is in flight");
  assert.equal(busyButton.disabled, true, "the decision cannot be re-clicked mid-flight");
  // A second click on the (synthetically reachable) button must not post again.
  await act(async () => {
    busyButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  assert.equal(script.posts.length, 1, "a double click posts exactly once");
  await resolveNext(approvedPayload());
  assert.equal(script.posts.length, 1);
  const toasted = script.toasts.find((toast) => toast.kind === "success");
  assert.ok(toasted, "completion toasts");
  assert.match(String(toasted?.message ?? ""), /Timesheet approved/);
  const status = document.querySelector('[role="status"]');
  assert.ok(status, "completion also pins a success status beside the actions");
  assert.match(status?.textContent ?? "", /Timesheet approved/);
});

test("a slow rejection shows its busy state, then pins success", async (t) => {
  const { cleanup } = await mountGrid();
  t.after(cleanup);
  const button = buttonNamed("Reject");
  assert.ok(button, "Reject renders on a submitted week");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(120);
  });
  const busyButton = buttonNamed("Rejecting…");
  assert.ok(busyButton, "Reject flips to its progress label while the request is in flight");
  assert.equal(busyButton.disabled, true);
  await act(async () => {
    busyButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  assert.equal(script.posts.length, 1, "a double click posts exactly once");
  await resolveNext(rejectedPayload());
  const status = document.querySelector('[role="status"]');
  assert.ok(status, "completion pins a success status beside the actions");
  assert.match(status?.textContent ?? "", /Timesheet rejected/);
});
