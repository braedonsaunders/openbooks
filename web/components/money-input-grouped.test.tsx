import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { bootJsdomEnvironment, setJsdomInput } from "../testing/jsdom-env";

await bootJsdomEnvironment({ url: "http://localhost/" });
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { default: en } = await import("../messages/en");
const { default: de } = await import("../messages/de");
const { MoneyInput } = await import("./money-input");

const MESSAGES = { en, de } as const;

/** A grouped amount field holding its value the way a form does, recording every value it is given. */
function Harness({
  initial,
  maxScale,
  received,
}: {
  initial: string;
  maxScale?: number;
  received: string[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <button type="button">Before</button>
      <MoneyInput
        grouped
        id="exit"
        field="Exit value"
        ariaLabel="Exit value"
        value={value}
        maxScale={maxScale}
        onChange={(next) => {
          received.push(next);
          setValue(next);
        }}
      />
      <output data-value>{value}</output>
    </div>
  );
}

async function mount(locale: keyof typeof MESSAGES, initial: string, maxScale?: number) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const received: string[] = [];
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
        <Harness initial={initial} maxScale={maxScale} received={received} />
      </NextIntlClientProvider>,
    ),
  );
  const input = host.querySelector("input")!;
  return {
    input,
    received,
    held: () => host.querySelector("[data-value]")!.textContent,
    alert: () => host.querySelector("[role=alert]")?.textContent ?? null,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const selected = (input: HTMLInputElement) => [input.selectionStart, input.selectionEnd];
const fullSelection = (input: HTMLInputElement) => [0, input.value.length];

async function tabInto(input: HTMLInputElement) {
  const before = input.closest("div")!.parentElement!.querySelector("button")!;
  before.focus();
  await act(async () => {
    before.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    input.focus();
  });
}

test("tabbing into a grouped amount selects its editable digits, so typing replaces the value", async () => {
  const field = await mount("en", "74424261.56");
  try {
    assert.equal(
      field.input.value,
      "74,424,261.56",
      "at rest the amount reads grouped in the viewer locale",
    );
    await tabInto(field.input);
    assert.equal(field.input.value, "74424261.56", "editing shows the digits without grouping");
    assert.deepEqual(
      selected(field.input),
      fullSelection(field.input),
      "the whole value is selected",
    );
    await act(async () => setJsdomInput(field.input, "5000000"));
    assert.equal(
      field.held(),
      "5000000",
      "the typed amount replaced the old one instead of appending to it",
    );
    await act(async () => {
      field.input.blur();
    });
    assert.equal(field.input.value, "5,000,000.00", "leaving the field reformats it grouped");
  } finally {
    await field.close();
  }
});

test("a click into a grouped amount selects it and keeps the selection through the click that focused it", async () => {
  const field = await mount("en", "25000000");
  try {
    let focusingUp: MouseEvent | null = null;
    await act(async () => {
      field.input.dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      field.input.focus();
    });
    await act(async () => {
      focusingUp = new window.MouseEvent("mouseup", { bubbles: true, cancelable: true });
      field.input.dispatchEvent(focusingUp);
    });
    assert.equal(field.input.value, "25000000");
    assert.deepEqual(selected(field.input), [0, 8]);
    assert.equal(
      focusingUp!.defaultPrevented,
      true,
      "the focusing click does not collapse the selection",
    );
    const placing = new window.MouseEvent("mouseup", { bubbles: true, cancelable: true });
    await act(async () => {
      field.input.dispatchEvent(placing);
    });
    assert.equal(placing.defaultPrevented, false, "a later click places the caret as usual");
  } finally {
    await field.close();
  }
});

test("an amount pasted in the viewer locale grouping reads as the amount it shows, in en and de", async () => {
  const english = await mount("en", "");
  try {
    await tabInto(english.input);
    await act(async () => setJsdomInput(english.input, "74,424,261.56"));
    assert.equal(english.held(), "74424261.56", "the caller receives the exact decimal");
    assert.equal(english.alert(), null, "a grouped amount in the viewer locale is not refused");
    await act(async () => {
      english.input.blur();
    });
    assert.equal(english.input.value, "74,424,261.56");
  } finally {
    await english.close();
  }
  const german = await mount("de", "74424261.56");
  try {
    assert.equal(
      german.input.value,
      "74.424.261,56",
      "at rest the amount reads in German notation",
    );
    await tabInto(german.input);
    assert.equal(german.input.value, "74424261,56", "editing keeps the German decimal comma");
    await act(async () => setJsdomInput(german.input, "1.250.000,5"));
    assert.equal(german.held(), "1250000.5");
    await act(async () => {
      german.input.blur();
    });
    assert.equal(german.input.value, "1.250.000,50");
    await tabInto(german.input);
    await act(async () => setJsdomInput(german.input, "980.5"));
    assert.equal(
      german.held(),
      "980.5",
      "the plain dotted form every boundary accepts still reads",
    );
  } finally {
    await german.close();
  }
});

test("text that reads as two amounts, or none, is refused in the viewer language without asking to drop the separators it displays", async () => {
  const german = await mount("de", "");
  try {
    await tabInto(german.input);
    await act(async () => setJsdomInput(german.input, "1.234"));
    assert.equal(
      german.held(),
      "1.234",
      "an ambiguous amount is held as typed, so the form cannot submit it",
    );
    const ambiguous = german.alert() ?? "";
    assert.ok(ambiguous.includes("„1.234“ kann 1.234 oder 1,234 bedeuten"), ambiguous);
    assert.ok(
      !/Trennzeichen|separator/i.test(ambiguous),
      "the remedy does not ask to omit grouping",
    );
  } finally {
    await german.close();
  }
  const english = await mount("en", "");
  try {
    await tabInto(english.input);
    await act(async () => setJsdomInput(english.input, "1,23,4"));
    const unreadable = english.alert() ?? "";
    assert.ok(unreadable.includes("Exit value is not an amount: “1,23,4”."), unreadable);
    assert.ok(
      unreadable.includes("such as 1,234,567.89"),
      "the example is written the way the field displays amounts",
    );
    assert.ok(!/thousands separator|without separators/i.test(unreadable), unreadable);
    await act(async () => setJsdomInput(english.input, "12.34567"));
    assert.ok((english.alert() ?? "").includes("at most 4 decimal places"));
    await act(async () => {
      english.input.blur();
    });
    assert.equal(
      english.input.value,
      "12.34567",
      "a refused value is left as typed for correction",
    );
  } finally {
    await english.close();
  }
});

test("a price field reads its full scale and an amount the caller replaces shows the new value", async () => {
  const field = await mount("en", "3.5", 10);
  try {
    assert.equal(field.input.value, "3.50");
    await tabInto(field.input);
    assert.equal(field.input.value, "3.5");
    await act(async () => setJsdomInput(field.input, "2.8446389082"));
    assert.equal(field.held(), "2.8446389082");
    await act(async () => {
      field.input.blur();
    });
    assert.equal(field.input.value, "2.8446389082");
  } finally {
    await field.close();
  }
});
