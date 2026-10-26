import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ComponentType, ReactNode } from "react";
import type { ScheduleData, ScheduleTask } from "@braedonsaunders/appkit-scheduling";
import { stubModules } from "../../../../testing/stub-modules";
stubModules({ navigation: true });
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
await bootJsdomEnvironment({ url: "http://localhost/projects", event: "jsdom" });
Object.defineProperty(globalThis.navigator, "languages", {
  get: () => ["en-US"],
  configurable: true,
});
// The schedule's selects group their options; the shared bootstrap does not expose these element classes.
Object.assign(globalThis, {
  HTMLOptGroupElement: window.HTMLOptGroupElement,
  HTMLOptionElement: window.HTMLOptionElement,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{
  locale: string;
  messages: typeof messages;
  timeZone: string;
  children?: ReactNode;
}>;
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { emptySchedule } = await import("@braedonsaunders/appkit-scheduling");
const { ScheduleTab } = await import("./ScheduleTab");

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const task: ScheduleTask = {
  id: "task-1",
  phaseId: null,
  calendarId: null,
  parentTaskId: null,
  outlineLevel: 0,
  name: "Rough-in",
  description: "",
  taskType: "task",
  status: "not_started",
  startDate: "2026-03-02",
  endDate: "2026-03-13",
  duration: 10,
  progress: 0,
  assignee: "",
  order: 0,
  constraintType: "asap",
  constraintDate: null,
  deadlineDate: null,
  actualStart: null,
  actualEnd: null,
  baselineStart: null,
  baselineEnd: null,
};
const schedule: ScheduleData = { ...emptySchedule, tasks: [task] };

/** The browser's network is the boundary: the plan and an empty board list. */
function stubFetch(t: TestContext) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/schedule-boards") ? { boards: [] } : { schedule };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
}

test("the project schedule edits its dates with the product date field, never a native date input", async (t) => {
  stubFetch(t);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-03-01">
          <ScheduleTab
            projectId="project-1"
            projectStart="2026-03-01"
            projectEnd="2026-06-30"
            canManage
            locale="en"
          />
        </BusinessDateProvider>
      </IntlProvider>,
    );
    await tick(30);
  });

  const menu = document.querySelector('[data-testid="schedule-actions-menu"]');
  assert.ok(menu, "the schedule toolbar rendered");
  await click(menu);
  const showFilters = [...document.querySelectorAll('[role="menuitem"], button')].find(
    (item) => item.textContent?.trim() === "Show filters",
  );
  assert.ok(showFilters, "the filter toggle is offered");
  await click(showFilters);

  const filters = document.querySelector('[data-testid="schedule-filters"]');
  assert.ok(filters, "the filter bar opened");
  const dates = [...filters.querySelectorAll<HTMLInputElement>("input[data-date-field]")];
  assert.deepEqual(
    dates.map((input) => input.getAttribute("aria-label")),
    ["Start", "Finish"],
  );
  assert.ok(
    dates.every((input) => input.type === "text"),
    "typed entry, not the browser picker",
  );
  assert.equal(document.querySelectorAll('input[type="date"]').length, 0);
});
