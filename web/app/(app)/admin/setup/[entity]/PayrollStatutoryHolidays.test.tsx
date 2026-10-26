import assert from "node:assert/strict";
import test from "node:test";
import type {
  StatutoryHolidayCalendar,
  StatutoryHolidayCalendarRefusal,
} from "@openbooks/engine/payroll/holidays";

// jsdom first: the section reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/admin/setup/business-calendars?view=payroll-holidays",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}`,
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const adminSetup = (
  await import("../../../../../messages/en/admin.json", { with: { type: "json" } })
).default.setup;
const { PayrollStatutoryHolidaysSection } = await import("./PayrollStatutoryHolidays");

const copy = adminSetup.payrollStatutoryHolidays;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const ALBERTA: StatutoryHolidayCalendar = {
  jurisdiction: "CA-AB",
  name: "Alberta",
  citation: "Employment Standards Code (Alberta), s. 1(1)(n) 'general holiday'",
  holidays: [
    {
      jurisdiction: "CA-AB",
      key: "thanksgiving",
      name: "Thanksgiving Day",
      statutoryDate: "2026-10-12",
      date: "2026-10-12",
      source: "pack",
      elected: false,
      paid: true,
    },
    // Remembrance Day falls on a Wednesday in 2026: the statutory date is the observed date.
    {
      jurisdiction: "CA-AB",
      key: "remembrance_day",
      name: "Remembrance Day",
      statutoryDate: "2026-11-11",
      date: "2026-11-11",
      source: "pack",
      elected: false,
      paid: true,
    },
    {
      jurisdiction: "CA-AB",
      key: "company_closure",
      name: "Office closure",
      statutoryDate: "2026-12-24",
      date: "2026-12-24",
      source: "company",
      elected: true,
      paid: false,
    },
  ],
};

const REFUSAL: StatutoryHolidayCalendarRefusal = {
  jurisdiction: "XX-QQ",
  message: 'no payroll pack declares the statutory holiday calendar for "XX-QQ"',
};

const HREFS = {
  previousYearHref: "/admin/setup/business-calendars?view=payroll-holidays&holidayYear=2025",
  nextYearHref: "/admin/setup/business-calendars?view=payroll-holidays&holidayYear=2027",
  payrollHolidaysHref: "/admin/setup/payroll?tab=holidays",
};

async function mount(props: {
  calendars: StatutoryHolidayCalendar[];
  refusals: StatutoryHolidayCalendarRefusal[];
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PayrollStatutoryHolidaysSection year={2026} {...HREFS} {...props} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("lists the observed days of each jurisdiction with its citation, and offers no edit controls", async () => {
  const { host, unmount } = await mount({ calendars: [ALBERTA], refusals: [] });
  try {
    const text = host.textContent ?? "";
    assert.ok(text.includes(copy.title), "the section names what it shows");
    assert.ok(text.includes("Alberta"), "the calendar is named by its jurisdiction");
    assert.ok(text.includes(ALBERTA.citation), "the calendar shows the statute it cites");
    assert.ok(
      text.includes("2026-10-12") && text.includes("Thanksgiving Day"),
      "an observed day is listed with its date and name",
    );
    assert.ok(
      text.includes("Office closure"),
      "a company closure the employer elected is listed as observed",
    );
    assert.equal(
      host.querySelectorAll("input, select, textarea, button").length,
      0,
      "the screen is read-only",
    );
    assert.ok(
      host.querySelector('a[href="/admin/setup/payroll?tab=holidays"]'),
      "the note links to the payroll Holidays tab, where elections are made",
    );
  } finally {
    await unmount();
  }
});

test("a calendar that cannot be read is named as a refusal rather than shown as an empty list", async () => {
  const { host, unmount } = await mount({ calendars: [], refusals: [REFUSAL] });
  try {
    const text = host.textContent ?? "";
    assert.ok(text.includes(REFUSAL.message), "the refusal states its cause");
    assert.ok(text.includes("XX-QQ"), "the refusal names the jurisdiction");
    assert.ok(
      !text.includes(copy.empty),
      "a refusal is not presented as having no payroll jurisdictions",
    );
  } finally {
    await unmount();
  }
});

test("an organization with no payroll jurisdictions is told so", async () => {
  const { host, unmount } = await mount({ calendars: [], refusals: [] });
  try {
    assert.ok((host.textContent ?? "").includes(copy.empty));
  } finally {
    await unmount();
  }
});

test("the year control moves one year in either direction and keeps the current year visible", async () => {
  const { host, unmount } = await mount({ calendars: [ALBERTA], refusals: [] });
  try {
    assert.equal(
      host.querySelector(`a[href="${HREFS.previousYearHref}"]`)?.textContent,
      copy.previousYear,
    );
    assert.equal(host.querySelector(`a[href="${HREFS.nextYearHref}"]`)?.textContent, copy.nextYear);
    assert.ok((host.textContent ?? "").includes("2026"));
  } finally {
    await unmount();
  }
});
