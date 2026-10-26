import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ComponentType, ReactNode } from "react";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({ url: "http://localhost/ar/invoices", event: "jsdom" });
const languages: string[] = ["en-US"];
Object.defineProperty(globalThis.navigator, "languages", {
  get: () => languages,
  configurable: true,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const catalogs = {
  en: (await import("../messages/en")).default,
  de: (await import("../messages/de")).default,
  ja: (await import("../messages/ja")).default,
};
type Catalog = (typeof catalogs)["en"];
const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{
  locale: string;
  messages: Catalog;
  timeZone: string;
  children?: ReactNode;
}>;
const { BusinessDateProvider } = await import("./business-date-provider");
const { DateField } = await import("./date-field");

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

interface MountOptions {
  locale?: keyof typeof catalogs;
  browser?: string[];
  today?: string | null;
}

async function mount(
  t: TestContext,
  node: ReactNode,
  { locale = "en", browser = ["en-US"], today = "2026-10-17" }: MountOptions = {},
) {
  languages.splice(0, languages.length, ...browser);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale={locale} messages={catalogs[locale] as Catalog} timeZone="UTC">
        {today === null ? node : <BusinessDateProvider today={today}>{node}</BusinessDateProvider>}
      </IntlProvider>,
    );
    await tick();
  });
  const input = host.querySelector<HTMLInputElement>("input[data-date-field]")!;
  return { host, input };
}

/** A controlled field recording every value its owner receives. */
function Controlled({
  initial = "",
  received,
  ...rest
}: {
  initial?: string;
  received: string[];
  min?: string;
  max?: string;
  onKeyDown?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const { onKeyDown, ...props } = rest;
  return (
    <DateField
      aria-label="Invoice date"
      value={value}
      onChange={(next) => {
        received.push(next);
        setValue(next);
      }}
      onKeyDown={onKeyDown ? () => onKeyDown(value) : undefined}
      {...props}
    />
  );
}

function setText(input: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
    input,
    text,
  );
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    target.dispatchEvent(event);
    await tick();
  });
  return event;
}

/** Type characters one key at a time, as a keyboard would: a key the field consumes inserts nothing. */
async function type(input: HTMLInputElement, text: string) {
  for (const char of text) {
    const event = await press(input, char);
    if (event.defaultPrevented) continue;
    await act(async () => {
      setText(input, input.value + char);
      await tick(0);
    });
  }
}

async function replaceText(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    setText(input, text);
    await tick(0);
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.blur();
    await tick();
  });
}

function errorText(host: Element): string {
  return host.querySelector('[role="alert"]')?.textContent ?? "";
}

function calendar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]:not([data-overlay-exiting])');
}

test("typed dates read in the viewer locale and redisplay in its format", async (t) => {
  const cases: Array<{ options: MountOptions; typed: string; iso: string; shown: string }> = [
    {
      options: { locale: "en", browser: ["en-US"] },
      typed: "3/15/2026",
      iso: "2026-03-15",
      shown: "03/15/2026",
    },
    {
      options: { locale: "en", browser: ["en-US"] },
      typed: "March 15th, 2026",
      iso: "2026-03-15",
      shown: "03/15/2026",
    },
    {
      options: { locale: "en", browser: ["en-GB"] },
      typed: "15/3/26",
      iso: "2026-03-15",
      shown: "15/03/2026",
    },
    {
      options: { locale: "de", browser: ["de-DE"] },
      typed: "15.3.2026",
      iso: "2026-03-15",
      shown: "15.03.2026",
    },
    {
      options: { locale: "de", browser: ["de-DE"] },
      typed: "15. März",
      iso: "2026-03-15",
      shown: "15.03.2026",
    },
    {
      options: { locale: "ja", browser: ["ja-JP"] },
      typed: "2026年3月15日",
      iso: "2026-03-15",
      shown: "2026/03/15",
    },
    {
      options: { locale: "ja", browser: ["ja-JP"] },
      typed: "2026-03-15",
      iso: "2026-03-15",
      shown: "2026/03/15",
    },
  ];
  for (const { options, typed, iso, shown } of cases) {
    const received: string[] = [];
    const { input } = await mount(t, <Controlled received={received} />, options);
    await replaceText(input, typed);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(typed))
      assert.deepEqual(received, [], `${typed}: nothing settles while typing`);
    await blur(input);
    assert.deepEqual(received, [iso], `${options.locale} ${typed}`);
    assert.equal(input.value, shown, `${options.locale} shows ${shown}`);
    assert.equal(input.getAttribute("aria-invalid"), null);
  }
});

test("a stored date displays in the viewer format and its placeholder names the order", async (t) => {
  const { input } = await mount(t, <DateField aria-label="Due" defaultValue="2026-01-05" />, {
    locale: "de",
    browser: ["de-DE"],
  });
  assert.equal(input.value, "05.01.2026");
  assert.equal(input.placeholder, "TT.MM.JJJJ");
  const us = await mount(t, <DateField aria-label="Due" defaultValue="0026-01-05" />);
  assert.equal(
    us.input.value,
    "01/05/0026",
    "an early year keeps four digits so it reads back as the same day",
  );
  assert.equal(us.input.placeholder, "mm/dd/yyyy");
});

test("text that is not a real date stays visible, is marked invalid and reports no date", async (t) => {
  const received: string[] = [];
  const { host, input } = await mount(t, <Controlled initial="2026-03-01" received={received} />);
  await replaceText(input, "2/30/2026");
  await blur(input);
  assert.deepEqual(received, [""], "the owner no longer holds the replaced date");
  assert.equal(input.value, "2/30/2026", "the typed text is never swapped for another day");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.match(errorText(host), /not a real calendar date/);
  const describedBy = input.getAttribute("aria-describedby") ?? "";
  assert.ok(
    describedBy && host.querySelector(`[id="${describedBy}"]`),
    "the message describes the field",
  );
  assert.equal(input.validity.customError, true, "native form validation refuses the field");

  await replaceText(input, "next tuesday");
  await blur(input);
  assert.match(errorText(host), /not a date this field can read.*10\/17\/2026/);

  await replaceText(input, "3/2/2026");
  await blur(input);
  assert.deepEqual(received, ["", "2026-03-02"]);
  assert.equal(errorText(host), "");
  assert.equal(input.getAttribute("aria-invalid"), null);
  assert.equal(input.validity.customError, false);
});

test("Escape abandons typing and restores the settled date", async (t) => {
  const received: string[] = [];
  const { input } = await mount(t, <Controlled initial="2026-03-01" received={received} />);
  await replaceText(input, "4/4");
  const event = await press(input, "Escape");
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, "03/01/2026");
  await blur(input);
  assert.deepEqual(received, []);
});

test("date keys move from the business date and repeat by period", async (t) => {
  const received: string[] = [];
  const { input, host } = await mount(t, <Controlled received={received} />);
  input.focus();
  for (const key of ["t", "+", "+", "-", "M", "m", "H", "R", "Y", "W", "K"]) {
    assert.equal((await press(input, key)).defaultPrevented, true, key);
  }
  assert.deepEqual(received, [
    "2026-10-17",
    "2026-10-18",
    "2026-10-19",
    "2026-10-18",
    "2026-10-01",
    "2026-09-01",
    "2026-09-30",
    "2026-12-31",
    "2026-01-01",
    "2025-12-28",
    "2026-01-03",
  ]);
  assert.equal(input.value, "01/03/2026");
  await act(async () => tick(20));
  assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /Jan 3, 2026/);
  assert.equal(
    (await press(input, "t", { ctrlKey: true })).defaultPrevented,
    false,
    "chords are never date keys",
  );
});

test("weeks start on the locale first day of the week", async (t) => {
  const received: string[] = [];
  const { input } = await mount(t, <Controlled initial="2026-10-14" received={received} />, {
    locale: "de",
    browser: ["de-DE"],
  });
  await press(input, "w");
  await press(input, "k");
  assert.deepEqual(received, ["2026-10-12", "2026-10-18"]);
});

test("+ and - type separators until the typed date is complete", async (t) => {
  const received: string[] = [];
  const { input } = await mount(t, <Controlled received={received} />);
  input.focus();
  await type(input, "3-15-2026");
  assert.equal(input.value, "3-15-2026", "the dashes were typed, not used as day steps");
  assert.deepEqual(received, []);
  await press(input, "+");
  assert.deepEqual(received, ["2026-03-16"], "+ steps from the complete typed date");
  assert.equal(input.value, "03/16/2026");
});

test("a letter key that begins a month name is typing, not a date key", async (t) => {
  const received: string[] = [];
  const { input } = await mount(t, <Controlled initial="2026-02-10" received={received} />);
  input.focus();
  await type(input, "Mar 15");
  assert.equal(input.value, "Mar 15");
  await blur(input);
  assert.deepEqual(
    received,
    ["2026-02-01", "2026-02-10", "2026-03-15"],
    "the month-start key was undone once the name began",
  );
});

test("Enter settles the typed date before the owner handles the key", async (t) => {
  const received: string[] = [];
  const seenOnEnter: string[] = [];
  const { input } = await mount(
    t,
    <Controlled received={received} onKeyDown={(value) => seenOnEnter.push(value)} />,
  );
  await replaceText(input, "4/1/2026");
  const event = await press(input, "Enter");
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(received, ["2026-04-01"]);
  assert.deepEqual(
    seenOnEnter,
    ["2026-04-01"],
    "the owner reads the settled date, not the previous one",
  );

  await replaceText(input, "4/31/2026");
  const refused = await press(input, "Enter");
  assert.equal(refused.defaultPrevented, true, "a refused date never submits the form");
  assert.deepEqual(seenOnEnter, ["2026-04-01"]);
});

test("min and max refuse typed dates and keys outside the range", async (t) => {
  const received: string[] = [];
  const { host, input } = await mount(
    t,
    <Controlled initial="2026-10-01" min="2026-10-01" max="2026-10-31" received={received} />,
  );
  await press(input, "-");
  assert.deepEqual(received, [], "a key step past min is refused");
  await act(async () => tick(20));
  assert.match(host.querySelector('[role="status"]')?.textContent ?? "", /outside the range/);
  await replaceText(input, "9/30/2026");
  await blur(input);
  assert.match(errorText(host), /Enter Oct 1, 2026 or later/);
  assert.deepEqual(received, [""]);
  await replaceText(input, "11/1/2026");
  await blur(input);
  assert.match(errorText(host), /Enter Oct 31, 2026 or earlier/);
});

test("the calendar opens on the field date and navigates by keyboard", async (t) => {
  const received: string[] = [];
  const { input } = await mount(
    t,
    <Controlled initial="2026-10-17" received={received} min="2026-01-01" />,
  );
  input.focus();
  await press(input, "ArrowDown", { altKey: true });
  await act(async () => tick(30));
  const dialog = calendar();
  assert.ok(dialog, "Alt+ArrowDown opens the calendar");
  assert.equal(dialog!.getAttribute("aria-label"), "Calendar");
  const active = () => document.activeElement as HTMLElement;
  assert.equal(active().dataset.date, "2026-10-17");
  assert.equal(active().getAttribute("aria-selected"), "true");
  assert.match(dialog!.textContent ?? "", /October 2026/);
  // Saturday Oct 17 with a Sunday week start (en-US).
  const columnHeaders = [...dialog!.querySelectorAll('[role="columnheader"]')].map((cell) =>
    cell.getAttribute("aria-label"),
  );
  assert.equal(columnHeaders[0], "Sunday");

  await press(active(), "ArrowRight");
  assert.equal(active().dataset.date, "2026-10-18");
  await press(active(), "ArrowDown");
  assert.equal(active().dataset.date, "2026-10-25");
  await press(active(), "Home");
  assert.equal(active().dataset.date, "2026-10-25");
  await press(active(), "End");
  assert.equal(active().dataset.date, "2026-10-31");
  await press(active(), "PageDown");
  assert.equal(active().dataset.date, "2026-11-30", "a month step clamps to the shorter month");
  assert.match(calendar()!.textContent ?? "", /November 2026/);
  await press(active(), "PageUp", { shiftKey: true });
  assert.equal(active().dataset.date, "2025-11-30");
  assert.equal(
    active().getAttribute("aria-disabled"),
    "true",
    "days before min are shown disabled",
  );
  await press(active(), "Enter");
  assert.deepEqual(received, [], "a disabled day cannot be chosen");
  await press(active(), "PageDown", { shiftKey: true });
  await press(active(), "ArrowLeft");
  assert.equal(active().dataset.date, "2026-11-29");
  await press(active(), "Enter");
  assert.deepEqual(received, ["2026-11-29"]);
  assert.equal(document.activeElement, input, "focus returns to the field");
  assert.equal(input.value, "11/29/2026");
  assert.equal(calendar(), null);
});

test("Escape closes the calendar without changing the date and Tab stays inside it", async (t) => {
  const received: string[] = [];
  const { host, input } = await mount(t, <Controlled initial="2026-10-17" received={received} />);
  const button = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
  assert.equal(button.getAttribute("aria-label"), "Choose a date from the calendar");
  await act(async () => {
    button.click();
    await tick(30);
  });
  assert.ok(calendar());
  assert.equal(button.getAttribute("aria-expanded"), "true");
  const day = document.activeElement as HTMLElement;
  await press(day, "Tab");
  assert.ok(calendar()!.contains(document.activeElement), "Tab cycles within the calendar");
  await press(document.activeElement!, "Escape");
  assert.equal(calendar(), null);
  assert.equal(document.activeElement, input);
  assert.deepEqual(received, []);
});

test("the calendar Today button chooses the business date", async (t) => {
  const received: string[] = [];
  const { host } = await mount(t, <Controlled received={received} />);
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click();
    await tick(30);
  });
  assert.equal(
    (document.activeElement as HTMLElement).dataset.date,
    "2026-10-17",
    "an empty field opens on the business date",
  );
  const todayButton = [...calendar()!.querySelectorAll("button")].find(
    (button) => button.textContent === "Today",
  )!;
  await act(async () => {
    todayButton.click();
    await tick();
  });
  assert.deepEqual(received, ["2026-10-17"]);
});

test("in a native form the ISO date submits under the field name and resets", async (t) => {
  const { host, input } = await mount(
    t,
    <form>
      <DateField aria-label="Hire date" name="hireDate" defaultValue="2026-02-01" required />
    </form>,
  );
  const form = host.querySelector("form")!;
  assert.equal(new window.FormData(form).get("hireDate"), "2026-02-01");
  await replaceText(input, "2/14/2026");
  await blur(input);
  assert.equal(new window.FormData(form).get("hireDate"), "2026-02-14");
  assert.equal(form.checkValidity(), true);

  await replaceText(input, "2/31/2026");
  await blur(input);
  assert.equal(
    new window.FormData(form).get("hireDate"),
    "",
    "a refused entry never submits a stale date",
  );
  assert.equal(form.checkValidity(), false);

  await replaceText(input, "");
  await blur(input);
  assert.equal(form.checkValidity(), false, "required refuses an empty field");

  await act(async () => {
    form.reset();
    await tick();
  });
  assert.equal(input.value, "02/01/2026");
  assert.equal(new window.FormData(form).get("hireDate"), "2026-02-01");
});

test("a controlled field follows its owner value", async (t) => {
  const owner: { set?: (value: string) => void } = {};
  function Owner() {
    const [value, set] = useState("2026-05-05");
    React.useEffect(() => {
      owner.set = set;
    }, [set]);
    return <DateField aria-label="Start" value={value} onChange={set} />;
  }
  const { input } = await mount(t, <Owner />);
  assert.equal(input.value, "05/05/2026");
  await act(async () => {
    owner.set!("2026-06-30");
    await tick();
  });
  assert.equal(input.value, "06/30/2026");
  await act(async () => {
    owner.set!("");
    await tick();
  });
  assert.equal(input.value, "");
});

test("a complete ISO date reports as soon as it is typed or pasted and reformats when settled", async (t) => {
  const received: string[] = [];
  const { input } = await mount(t, <Controlled received={received} max="2026-12-31" />);
  await replaceText(input, "2026-07-0");
  assert.deepEqual(received, []);
  await replaceText(input, "2026-07-04");
  assert.deepEqual(received, ["2026-07-04"], "an unambiguous ISO date needs no blur");
  assert.equal(input.value, "2026-07-04", "the typed text stays while the viewer is typing");
  await replaceText(input, "2027-01-01");
  assert.deepEqual(
    received,
    ["2026-07-04"],
    "a date past max waits for the entry to settle and refuse",
  );
  await replaceText(input, "2026-07-04");
  await blur(input);
  assert.deepEqual(received, ["2026-07-04"], "settling the same date reports nothing new");
  assert.equal(input.value, "07/04/2026");
  await replaceText(input, "");
  assert.deepEqual(received, ["2026-07-04", ""], "clearing the text clears the date at once");
});

test("a native change event settles scripted entry without leaving the field", async (t) => {
  const received: string[] = [];
  const { input } = await mount(t, <Controlled received={received} />);
  await act(async () => {
    input.focus();
    setText(input, "2026-07-04");
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  assert.deepEqual(received, ["2026-07-04"]);
  await blur(input);
  assert.deepEqual(received, ["2026-07-04"], "blur after change does not settle twice");
});

test("without a business date, relative entry refuses instead of reading the browser clock", async (t) => {
  const received: string[] = [];
  const { host, input } = await mount(t, <Controlled received={received} />, { today: null });
  await replaceText(input, "3/15");
  await blur(input);
  assert.match(errorText(host), /Enter the full year/);
  assert.deepEqual(received, []);
  await press(input, "Escape");
  await press(input, "t");
  assert.deepEqual(received, []);
  await replaceText(input, "3/15/2026");
  await blur(input);
  assert.deepEqual(received, ["2026-03-15"]);
});

test("disabled and read-only fields accept no keys and open no calendar", async (t) => {
  const { host, input } = await mount(
    t,
    <>
      <DateField
        aria-label="Posted"
        value="2026-03-01"
        readOnly
        onChange={() => assert.fail("read-only changed")}
      />
      <DateField
        aria-label="Locked"
        value="2026-03-01"
        disabled
        onChange={() => assert.fail("disabled changed")}
      />
    </>,
  );
  assert.equal(input.readOnly, true);
  await press(input, "t");
  assert.equal(input.value, "03/01/2026");
  assert.equal(
    host.querySelectorAll('button[aria-haspopup="dialog"]').length,
    1,
    "read-only shows no calendar button",
  );
  assert.equal(
    host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.disabled,
    true,
  );
});
