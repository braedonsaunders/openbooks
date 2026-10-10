// Billable is a project expectation gated by the time type: a fresh line
// starts unchecked, choosing a project checks it when the type bills by
// default, and a non-billable type unchecks it again. Shop time is never
// pre-checked.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the grid reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/timesheets?timesheet=emp-8:2026-07-12",
  matchMediaMatches: false,
});

Object.assign(globalThis, {
  __gridBillableRouter: {
    push() {},
    replace() {},
    refresh() {},
  },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__gridBillableRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
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

const PICKERS = {
  employees: [{ value: "emp-8", label: "Billable Worker" }],
  projects: [
    { value: "proj-8", label: "DAY · Day job" },
    { value: "proj-shop", label: "SHOP · Shop" },
  ],
  internalProjectIds: ["proj-shop"],
  items: [],
  timeTypes: [
    { value: "tt-travel", label: "Travel", classification: "other", costMultiplier: "0.5", isBillableDefault: false, isDefault: false },
    { value: "tt-regular", label: "Regular", classification: "regular", costMultiplier: "1", isBillableDefault: true, isDefault: true },
  ],
  departments: [],
};

const PAYLOAD = {
  employeeId: "emp-8",
  week: "2026-07-12",
  days: DAYS,
  rows: [],
  status: "draft",
  hasApproved: false,
  lockReasons: [],
  lockedCount: 0,
  rejectionReason: null,
  weekId: "week-8",
  revision: "rev-1",
} as never;

function billableBox(): HTMLInputElement {
  const box = document.querySelector('input[aria-label="Line 1 billable"]') as HTMLInputElement | null;
  assert.ok(box, "the line offers its billable checkbox");
  return box;
}

async function chooseOption(triggerAria: string, optionText: string): Promise<void> {
  const trigger = document.querySelector(`button[aria-label="${triggerAria}"]`) as HTMLButtonElement | null;
  assert.ok(trigger, `the ${triggerAria} picker must render`);
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  const option = [...document.querySelectorAll('[role="option"]')].find((el) =>
    (el.textContent ?? "").includes(optionText),
  ) as HTMLElement | undefined;
  assert.ok(option, `the picker must offer ${optionText}`);
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  await tick(60);
}

test("billable follows the project and time-type policy, never pre-checked", async (t) => {
  // The picker dropdowns portal to document.body, outside any host div — and
  // React only hears events that bubble through its root container — so the
  // root IS the body here.
  const root = createRoot(document.body);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    root.render(
      <BusinessDateProvider today="2026-07-14">
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <WeeklyGrid
              employeeId="emp-8"
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

  assert.equal(billableBox().checked, false, "a fresh line starts unchecked: no project yet");

  await chooseOption("Line 1 project", "Day job");
  assert.equal(billableBox().checked, true, "choosing a project checks billable for a billable time type");

  await chooseOption("Line 1 time type", "Travel");
  assert.equal(billableBox().checked, false, "a non-billable time type unchecks the line");

  await chooseOption("Line 1 project", "Shop");
  await chooseOption("Line 1 time type", "Regular");
  assert.equal(billableBox().checked, false, "an internal shop project never bills, even with a billable type");
});
