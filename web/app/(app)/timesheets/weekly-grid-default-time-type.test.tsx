// New timesheet lines start on the org's standard time type. The picker order
// follows cost multipliers, so the first entry is whatever prices lowest —
// the grid must never inherit that position as its default.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the grid reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/timesheets?timesheet=emp-9:2026-07-12",
  matchMediaMatches: false,
});

Object.assign(globalThis, {
  __gridDefaultTypeRouter: {
    push() {},
    replace() {},
    refresh() {},
  },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridDefaultTypeRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
    "../../../lib/confirm":
      "export async function confirmDialog(){return false}",
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

// Travel prices lowest, so multiplier order lists it first; Regular is the
// org's flagged standard type and must win as the line default.
const PICKERS = {
  employees: [{ value: "emp-9", label: "Default Worker" }],
  projects: [{ value: "proj-9", label: "DAY · Day job" }],
  items: [],
  timeTypes: [
    { value: "tt-travel", label: "Travel", classification: "other", costMultiplier: "0.5", isBillableDefault: true, isDefault: false },
    { value: "tt-regular", label: "Regular", classification: "regular", costMultiplier: "1", isBillableDefault: true, isDefault: true },
  ],
  departments: [],
};

const PAYLOAD = {
  employeeId: "emp-9",
  week: "2026-07-12",
  days: DAYS,
  rows: [],
  status: "draft",
  hasApproved: false,
  lockReasons: [],
  lockedCount: 0,
  rejectionReason: null,
  weekId: "week-9",
  revision: "rev-1",
} as never;

function timeTypeTrigger(line: number): HTMLButtonElement | null {
  return document.querySelector(`button[aria-label="Line ${line} time type"]`);
}

test("new lines default to the flagged standard type, never the first picker entry", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <BusinessDateProvider today="2026-07-14">
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <WeeklyGrid
              employeeId="emp-9"
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

  const first = timeTypeTrigger(1);
  assert.ok(first, "the seeded empty line offers a time type");
  assert.match(first.textContent ?? "", /Regular/, "the seeded line starts on the standard type");
  assert.doesNotMatch(first.textContent ?? "", /Travel/, "multiplier order never leaks into the default");

  const addLine = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Add line",
  ) as HTMLButtonElement | undefined;
  assert.ok(addLine, "the grid must offer Add line");
  await act(async () => {
    addLine.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  await tick(60);

  const second = timeTypeTrigger(2);
  assert.ok(second, "the added line offers a time type");
  assert.match(second.textContent ?? "", /Regular/, "added lines start on the standard type too");
});
