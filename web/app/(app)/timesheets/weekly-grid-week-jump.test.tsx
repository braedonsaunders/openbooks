// The week picker jumps straight to any week: a picked date snaps to its
// Sunday and navigates through the same shareable drawer id the Prev/Next
// buttons use (?timesheet=<employee>:<weekStart>). Partial typing navigates
// nowhere; dirty drafts still confirm first.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the grid reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/timesheets?timesheet=emp-6:2026-07-12",
  matchMediaMatches: false,
});

const script = { pushes: [] as string[] };
Object.assign(globalThis, {
  __gridWeekJump: script,
  __gridWeekJumpRouter: {
    push(url: string) { script.pushes.push(url); },
    replace() {},
    refresh() {},
  },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridWeekJumpRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
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

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, 30));

const DAYS = ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"];

const PICKERS = {
  employees: [{ value: "emp-6", label: "Jump Worker" }],
  projects: [],
  items: [],
  timeTypes: [{ value: "tt-1", label: "Regular", classification: "regular", costMultiplier: "1", isBillableDefault: true, isDefault: true }],
  departments: [],
};

const PAYLOAD = {
  employeeId: "emp-6",
  week: "2026-07-12",
  days: DAYS,
  rows: [],
  status: "draft",
  hasApproved: false,
  lockReasons: [],
  lockedCount: 0,
  rejectionReason: null,
  weekId: "week-6",
  revision: "rev-6",
} as never;

test("picking a date jumps to its Sunday through the drawer id", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <BusinessDateProvider today="2026-07-14">
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <WeeklyGrid
              employeeId="emp-6"
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
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });

  const picker = document.querySelector('input[aria-label="Go to week"]') as HTMLInputElement | null;
  assert.ok(picker, "the grid header offers the week picker");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    // A Wednesday: the jump snaps back to its Sunday.
    setter.call(picker, "2026-06-10");
    picker.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick(60);
  assert.equal(script.pushes.length, 1, "a valid picked date navigates once");
  assert.ok(
    script.pushes[0]!.includes("timesheet=emp-6:2026-06-07"),
    `the jump preserves the drawer id on the snapped week, got ${JSON.stringify(script.pushes)}`,
  );
});
