import assert from "node:assert/strict";
import test from "node:test";

// F5-6: CustomFieldInput hardcoded 'No options defined' and the reference
// placeholder/fallback ('Select a record…' / 'Could not load records')
// though the file already binds the catalog. A non-en user on an optionless
// multi-select or a failed reference load must read catalog copy.
//
// Only the options route and toasts are doubled. React, next-intl, the
// shared SearchSelect and the REAL German catalog run, so hardcoded
// English fails every assertion below.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/de")).default;
const { CustomFieldInput } = await import("./custom-field-input");
import type { CustomFieldDefClient } from "./custom-field-inputs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const noop = () => {};

async function mountDe(def: CustomFieldDefClient, value: unknown) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messages} timeZone="UTC">
        <CustomFieldInput def={def} value={value} onChange={noop} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  return { host, root };
}

test("F5-6: an optionless multi-select explains itself in the session locale", async () => {
  const { host, root } = await mountDe(
    { key: "tags", label: "Schlagwörter", fieldType: "multi_select", config: { options: [] }, isRequired: false },
    [],
  );
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Keine Optionen definiert/);
    assert.ok(!text.includes("No options defined"), "English empty-options copy must not leak");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

test("F5-6: a failed reference load falls back to translated copy", async () => {
  // A non-JSON 500 carries no server refusal, so the placeholder must be the
  // cataloged fallback — never the English literal.
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  try {
    const { host, root } = await mountDe(
      {
        key: "cost_center",
        label: "Kostenstelle",
        fieldType: "reference",
        config: { referenceTable: "cost_centers" },
        isRequired: false,
      },
      "",
    );
    try {
      // SearchSelect shows the placeholder as the trigger button's label
      // until a record is picked (the field-help button comes first in DOM).
      const trigger = host.querySelector('button[aria-haspopup="listbox"]');
      assert.ok(trigger, "the reference control must render its trigger");
      const label = trigger.textContent ?? "";
      assert.match(label, /konnten nicht geladen werden/);
      assert.ok(!label.includes("Could not load records"), "English load fallback must not leak");
      assert.ok(!label.includes("Select a record"), "English placeholder must not leak");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  } finally {
    globalThis.fetch = prior;
  }
});
