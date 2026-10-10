// Withdrawing a submitted week offers the submitter's own recall beside the
// approver verbs, confirms first, and applies the server's draft payload with
// a toast — the same contract the submit and reopen buttons keep.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the grid reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/timesheets?timesheet=emp-7:2026-07-12",
  matchMediaMatches: false,
});

const script = { refreshed: 0, withdrawBodies: [] as Record<string, unknown>[], confirms: 0, confirmNext: false };
Object.assign(globalThis, {
  __gridWithdraw: script,
  __gridWithdrawRouter: {
    push() {},
    replace() {},
    refresh() { script.refreshed++; },
  },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridWithdrawRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
    "../../../lib/confirm":
      "export async function confirmDialog(){const s=globalThis.__gridWithdraw;s.confirms++;return s.confirmNext}",
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

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, 30));

const DAYS = ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"];

const PICKERS = {
  employees: [{ value: "emp-7", label: "Recall Worker" }],
  projects: [{ value: "proj-7", label: "DAY · Day job" }],
  items: [],
  timeTypes: [{ value: "tt-1", label: "Regular", classification: "regular", costMultiplier: "1", isBillableDefault: true, isDefault: true }],
  departments: [],
};

const PAYLOAD = {
  employeeId: "emp-7",
  week: "2026-07-12",
  days: DAYS,
  rows: [
    {
      projectId: "proj-7",
      itemId: null,
      timeTypeId: "tt-1",
      departmentId: null,
      isBillable: true,
      memo: null,
      hours: ["8", "", "", "", "", "", ""],
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
  weekId: "week-7",
  revision: "rev-7",
} as never;

async function mountGrid() {
  script.withdrawBodies = [];
  script.confirms = 0;
  script.confirmNext = false;
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/timesheets/withdraw" && init?.method === "POST") {
      script.withdrawBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ...PAYLOAD, status: "draft", revision: "rev-8" });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <BusinessDateProvider today="2026-07-14">
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <WeeklyGrid
              employeeId="emp-7"
              week="2026-07-12"
              payload={PAYLOAD}
              pickers={PICKERS as never}
              canManage
              canApprove={false}
              canReopen={false}
            />
          </MoneyProvider>
        </NextIntlClientProvider>
      </BusinessDateProvider>,
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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

test("a submitted week offers Withdraw beside the approver verbs", async (t) => {
  const { cleanup } = await mountGrid();
  t.after(cleanup);

  const withdraw = buttonsNamed("Withdraw")[0];
  assert.ok(withdraw, "the submitted week must offer its own recall");
  assert.equal(withdraw.disabled, false, "the recall is available while dirty-free");
  assert.equal(script.withdrawBodies.length, 0, "nothing posts before confirmation");

  script.confirmNext = false;
  await act(async () => {
    withdraw.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  await tick(60);
  assert.equal(script.confirms, 1, "the recall confirms first");
  assert.equal(script.withdrawBodies.length, 0, "dismissing the confirm posts nothing");

  script.confirmNext = true;
  await act(async () => {
    withdraw.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  await tick(60);
  assert.equal(script.withdrawBodies.length, 1, "confirming recalls the week once");
  assert.deepEqual(
    script.withdrawBodies[0],
    { employee: "emp-7", week: "2026-07-12" },
    "the recall carries the week identity",
  );
});
