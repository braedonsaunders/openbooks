import assert from "node:assert/strict";
import test from "node:test";

// F5-7: ModuleView's spec-validation failure title was hardcoded English in
// a server component that binds no next-intl namespace. Any-locale users
// hitting a tenant layout that fails validation must read the panel chrome
// in their own locale (the validator diagnostics below stay English by
// construction).
//
// The panel is a client component fed by the server ModuleView, so it
// renders here under the REAL German catalog: the hardcoded title fails
// every assertion below.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/projects",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/de")).default;
const { SpecValidationError } = await import("./spec-validation-error");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("F5-7: the invalid-view panel title reads the session locale", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messages} timeZone="UTC">
        <SpecValidationError errors={["blocks[0] is unknown", "second failure"]} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Diese Ansicht konnte nicht gerendert werden/);
    assert.ok(!text.includes("This view could not be rendered"), "English panel title must not leak");
    // The validator diagnostics themselves are data, not chrome: they pass
    // through untouched in every locale.
    assert.ok(text.includes("blocks[0] is unknown"), "validator errors must still render");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
