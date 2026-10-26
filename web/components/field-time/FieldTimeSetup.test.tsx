import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../testing/jsdom-env.ts";

// The rules form submits declared choices and preserves missing policy values.

// jsdom first: the ui Select/SearchSelect read browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/time/setup", matchMediaMatches: false });

// Node 24+ ships native Event constructors that jsdom nodes will not
// propagate (a component-dispatched `new Event('change')` never reaches a
// container listener), so a Select pick would read as unwired here while it
// works in every browser. Pin the test realm's constructors for fidelity.
const domWindow = window as unknown as Record<string, unknown>;
for (const key of ["Event", "CustomEvent", "InputEvent", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, {
    value: domWindow[key],
    configurable: true,
    writable: true,
  });
}

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { FieldTimeSetup } = await import("./FieldTimeSetup");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const fieldMessages = messages.timesheets.field;
function msg(key: string): string {
  const value = fieldMessages[key as keyof typeof fieldMessages];
  assert.ok(typeof value === "string", `message catalog must carry timesheets.field.${key}`);
  return value;
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")] as HTMLButtonElement[];
}

async function pickRule(host: HTMLElement, labelText: string, choice: string) {
  const label = [...host.querySelectorAll("label")].find((node) => node.textContent === labelText);
  assert.ok(label, `the ${labelText} label renders`);
  const trigger = [...host.querySelectorAll("button")].find((node) =>
    node.getAttribute("aria-labelledby")?.split(" ").includes(label.id),
  );
  assert.ok(trigger, `the ${labelText} control is labelled`);
  await act(async () => {
    trigger.click();
    await tick();
    await tick();
  });
  const option = [...document.querySelectorAll('button[role="option"]')].find(
    (node) => node.textContent?.trim() === choice,
  ) as HTMLButtonElement | undefined;
  assert.ok(option, `the ${choice} option renders`);
  await act(async () => {
    option.click();
    await tick();
  });
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
            employees={[]}
            canManageKiosks={true}
            canEditPolicy={true}
            kiosks={[]}
            kioskLinkBase="/kiosk"
          />
        </NextIntlClientProvider>,
      );
      await tick();
    });

    assert.ok(
      host.querySelector('a[href="/admin/flows"]'),
      "approval routing links to the existing Flows page",
    );

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
      "the picked rule must render",
    );

    // Break, auto-close, tolerance: type into the inputs behind their
    // ghost placeholders.
    const setInput = async (placeholder: string, value: string) => {
      const input = document.querySelector(
        `input[placeholder="${placeholder}"]`,
      ) as HTMLInputElement | null;
      assert.ok(input, `the ${placeholder} input must render`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        await tick();
      });
    };
    await setInput("30", "30");
    await setInput("16", "16");
    await setInput("0.5", "0.5");

    await pickRule(host, msg("roundingMode"), msg("roundNearest"));
    await pickRule(host, msg("signatureRequired"), messages.common.labels.yes);

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
    await act(async () => root.unmount());
  } finally {
    globalThis.fetch = prior;
  }
});

test("worker PIN selection posts the selected employee and kiosk rows can be retired", async () => {
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
            canManageKiosks={true}
            canEditPolicy={true}
            kiosks={[
              {
                id: "kiosk-1",
                name: "West gate",
                locationId: null,
                projectId: null,
                pinRequired: true,
                photoRequired: false,
                isActive: true,
                lastSeenAt: "2026-10-18T12:00:00.000Z",
              },
            ]}
            employees={[{ value: "employee-1", label: "Jordan Lee" }]}
            kioskLinkBase="/kiosk"
          />
        </NextIntlClientProvider>,
      );
      await tick();
    });

    assert.ok(host.textContent?.includes("West gate"));
    const workerPicker = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(msg("chooseWorker")),
    ) as HTMLButtonElement | undefined;
    assert.ok(workerPicker, "the worker field uses a named picker instead of a raw party-id input");
    await act(async () => {
      workerPicker.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    const workerOption = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes("Jordan Lee"),
    ) as HTMLElement | undefined;
    assert.ok(
      workerOption,
      `the active scoped employee is offered by display name: ${JSON.stringify({ expanded: workerPicker.getAttribute("aria-expanded"), text: document.body.textContent, options: [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent) })}`,
    );
    await act(async () => {
      workerOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });

    const pinInput = host.querySelector(
      `input[placeholder="${msg("pinPlaceholder")}"]`,
    ) as HTMLInputElement | null;
    assert.ok(pinInput, "the PIN field is available after selecting an employee");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(pinInput, "1234");
      pinInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    const setPin = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === msg("setPin"),
    ) as HTMLButtonElement | undefined;
    assert.ok(setPin && !setPin.disabled, "a selected employee and PIN enable submission");
    await act(async () => {
      setPin.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    assert.deepEqual(seen[0]?.body, {
      action: "set-pin",
      employeePartyId: "employee-1",
      pin: "1234",
    });

    const retire = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retire",
    ) as HTMLButtonElement | undefined;
    assert.ok(retire, "active kiosks expose the revoke action");
    await act(async () => {
      retire.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    assert.deepEqual(seen[1]?.body, { action: "revoke", kioskId: "kiosk-1" });
    await act(async () => root.unmount());
  } finally {
    globalThis.fetch = prior;
  }
});

test("a blank policy stays undeclared through save and shows the native remedy", async () => {
  const { validateFieldTimeSettings } = await import("@openbooks/engine/hrm/field-time/settings");
  const seen: Record<string, unknown>[] = [];
  const prior = globalThis.fetch;
  const priorScroll = window.HTMLElement.prototype.scrollIntoView;
  const revealed: HTMLElement[] = [];
  window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    revealed.push(this);
  };
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(body);
    try {
      validateFieldTimeSettings(body);
      return new Response("{}", { status: 200 });
    } catch (error) {
      assert.ok(error instanceof Error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <FieldTimeSetup
            initialSettings={{
              roundingIncrement: 15,
              roundingMode: null,
              unpaidBreakMinutes: 0,
              autoCloseHours: 16,
              signatureRequired: null,
              equipmentToleranceHours: null,
              photoRequired: null,
            }}
            kiosks={[]}
            employees={[]}
            kioskLinkBase="/kiosk"
            canManageKiosks={false}
            canEditPolicy={true}
          />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    const save = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === msg("saveRules"),
    );
    assert.ok(save);
    await act(async () => {
      save.click();
      await tick();
      await tick();
    });
    assert.equal(seen.length, 1);
    for (const key of [
      "roundingMode",
      "equipmentToleranceHours",
      "signatureRequired",
      "photoRequired",
    ])
      assert.equal(seen[0]?.[key], null);
    assert.match(
      host.querySelector('[role="alert"]')?.textContent ?? "",
      /Rounding mode is not declared.*Timesheets setup/,
    );
    assert.equal(host.textContent?.includes(msg("rulesSaved")), false);
    assert.equal(
      revealed.at(-1),
      host.querySelector('[role="alert"]'),
      "the native refusal is brought into the visible scroll area",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = prior;
    window.HTMLElement.prototype.scrollIntoView = priorScroll;
  }
});

test("a reader receives disabled rules and no kiosk management controls", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <FieldTimeSetup
            initialSettings={{
              roundingIncrement: 15,
              roundingMode: "nearest",
              unpaidBreakMinutes: 0,
              autoCloseHours: 16,
              signatureRequired: false,
              equipmentToleranceHours: "0",
              photoRequired: false,
            }}
            kiosks={[]}
            employees={[]}
            kioskLinkBase="/kiosk"
            canManageKiosks={false}
            canEditPolicy={false}
          />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    assert.equal(host.textContent?.includes(msg("saveRules")), false);
    assert.equal(host.textContent?.includes(msg("registerKiosk")), false);
    assert.equal(host.textContent?.includes(msg("setPin")), false);
    for (const input of host.querySelectorAll("input")) assert.ok(input.disabled);
    for (const button of host.querySelectorAll('button[aria-haspopup="listbox"]'))
      assert.equal(button.getAttribute("disabled"), "");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
