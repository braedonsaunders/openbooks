import assert from "node:assert/strict";
import test from "node:test";

// P7: the /time/setup rules form must carry every visible choice into the
// PUT /api/time/settings payload — a control whose selection never reaches
// state saves a null, which the route used to refuse as an unnamed 400.
// This drives the real component through the full visible rule set
// (rounding 15, break 30, auto-close 16, tolerance 0.5, signature on) and
// asserts the captured request body carries every rule.

// jsdom first: the ui Select/SearchSelect read browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/time/setup",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "self",
]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
// Node 24+ ships native Event constructors that jsdom nodes will not
// propagate (a component-dispatched `new Event('change')` never reaches a
// container listener), so a Select pick would read as unwired here while it
// works in every browser. Pin the test realm's constructors for fidelity.
for (const key of ["Event", "CustomEvent", "InputEvent", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, {
    value: domWindow[key],
    configurable: true,
    writable: true,
  });
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== "function") {
  const stub = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as Record<string, unknown>).ResizeObserver = stub;
  (window as unknown as Record<string, unknown>).ResizeObserver = stub;
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default as {
  timesheets: { field: Record<string, string> };
};
const { FieldTimeSetup } = await import("./FieldTimeSetup");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const fieldMessages = messages.timesheets.field;
function msg(key: string): string {
  const value = fieldMessages[key];
  assert.ok(typeof value === "string", `message catalog must carry timesheets.field.${key}`);
  return value;
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")] as HTMLButtonElement[];
}

test("filling every visible rule sends the complete rule set", async () => {
  const seen: { url: unknown; body: unknown }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    seen.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    return { ok: true, json: async () => ({ ok: true }) };
  }) as typeof fetch;
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <FieldTimeSetup
            initialSettings={{
              roundingIncrement: null,
              roundingMode: null,
              unpaidBreakMinutes: null,
              autoCloseHours: null,
              signatureRequired: false,
              equipmentToleranceHours: null,
              photoRequired: false,
            }}
            kiosks={[]}
            chains={[]}
            kioskLinkBase="/kiosk"
          />
        </NextIntlClientProvider>,
      );
      await tick();
    });

    // Rounding increment: open the dropdown and pick 15. The menu portals
    // to document.body in both desktop and mobile modes.
    const trigger = buttons().find((b) => b.textContent?.includes(msg("notDeclared")));
    assert.ok(trigger, "the rounding trigger must render undeclared");
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    const option = [...document.querySelectorAll('button[role="option"]')].find((el) =>
      el.textContent?.includes(msg("rounding15")),
    ) as HTMLButtonElement;
    assert.ok(option, "the 15-minute option must render");
    await act(async () => {
      option.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    assert.ok(
      buttons().some((b) => b.textContent?.includes(msg("rounding15"))),
      "the picked rounding must reach the trigger display",
    );

    // Break, auto-close, tolerance: type into the inputs behind their
    // ghost placeholders.
    const setInput = async (placeholder: string, value: string) => {
      const input = document.querySelector(
        `input[placeholder="${placeholder}"]`,
      ) as HTMLInputElement | null;
      assert.ok(input, `the ${placeholder} input must render`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        await tick();
      });
    };
    await setInput("30", "30");
    await setInput("16", "16");
    await setInput("0.5", "0.5");

    // Signature on.
    const signature = [...document.querySelectorAll('input[type="checkbox"]')].find((el) =>
      el.closest("label")?.textContent?.includes(msg("signatureRequired")),
    ) as HTMLInputElement;
    assert.ok(signature, "the signature checkbox must render");
    await act(async () => {
      signature.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });

    const save = buttons().find((b) => b.textContent?.trim() === msg("saveRules"));
    assert.ok(save, "the save button must render");
    await act(async () => {
      save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });

    assert.equal(seen.length, 1, `exactly one save request, got ${JSON.stringify(seen)}`);
    assert.deepEqual(seen[0]!.body, {
      roundingIncrement: 15,
      roundingMode: "nearest",
      unpaidBreakMinutes: 30,
      autoCloseHours: 16,
      signatureRequired: true,
      equipmentToleranceHours: "0.5",
      photoRequired: false,
    });
  } finally {
    globalThis.fetch = prior;
  }
});
