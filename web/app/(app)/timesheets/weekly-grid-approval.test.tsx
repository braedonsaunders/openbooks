// A gate-owned week arrives with Approve disabled and its reason, and a
// refused direct approval pins beside the actions with its remedy —
// neither reads as nothing happening.
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
  approveStatus: 200 as number,
  approveBody: {} as Record<string, unknown>,
};
Object.assign(globalThis, {
  __gridApproval: script,
  __gridApprovalRouter: { push() {}, replace() {}, refresh() {} },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridApprovalRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      "export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
    sonner:
      "export const toast={success(m){globalThis.__gridApproval.toasts.push({kind:'success',message:m})},error(m,o){globalThis.__gridApproval.toasts.push({kind:'error',message:m,options:o})},warning(){},info(){}};export function Toaster(){return null}",
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

function payload() {
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
  employees: [{ value: "emp-1", label: "Approval Worker" }],
  projects: [],
  items: [],
  timeTypes: [],
  departments: [],
};

async function mountGrid(approveBlockedReason: string | null) {
  script.toasts = [];
  script.posts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.startsWith("/api/timesheets/approve") && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(script.approveBody), {
        status: script.approveStatus,
        headers: { "content-type": "application/json" },
      });
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
              payload: payload(),
              pickers: PICKERS,
              canManage: true,
              canApprove: true,
              canReopen: false,
              approveBlockedReason,
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

function approveButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Approve",
  ) as HTMLButtonElement | undefined;
}

test("a gate-owned week renders Approve disabled with its reason", async (t) => {
  const { cleanup } = await mountGrid("This week is owned by a pending approval flow — decide it there.");
  t.after(cleanup);
  const button = approveButton();
  assert.ok(button, "Approve still renders so the state is visible");
  assert.equal(button.disabled, true, "a gate-owned week cannot approve from the drawer");
  assert.match(document.body.textContent ?? "", /pending approval flow/);
  assert.equal(script.posts.length, 0, "a disabled button posts nothing");
});

test("a refused approval pins beside the actions with its remedy", async (t) => {
  script.approveStatus = 409;
  script.approveBody = {
    error: "this week is owned by a pending approval workflow — its gates must resolve first",
    code: "week_owned_by_workflow",
    remedy: "Decide the week through its approval flow instead of approving it directly.",
  };
  const { cleanup } = await mountGrid(null);
  t.after(cleanup);
  t.after(() => {
    script.approveStatus = 200;
    script.approveBody = {};
  });
  const button = approveButton();
  assert.ok(button, "Approve renders when no advance reason is known");
  assert.equal(button.disabled, false);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(120);
  });
  await tick(120);
  assert.equal(script.posts.length, 1, "Approve posts once");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal pins beside the actions, not only in a toast");
  assert.match(alert?.textContent ?? "", /pending approval workflow/);
  assert.match(alert?.textContent ?? "", /approval flow instead/);
  const toasted = script.toasts.find((toast) => toast.kind === "error");
  assert.ok(toasted, "the toast still fires");
});
