import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// The void dialog's reason field gates its confirm button on the controlled
// value — but a programmatic fill (autofill, a script setting the field)
// lands in the element without React's onChange firing. The dialog must
// still enable Void and submit the visible text: enablement re-syncs from
// the live element on focus/blur, and submit reads the field itself. These
// tests drive the real PromptRoot the way the void flow opens it.
await bootJsdomEnvironment({
  html: "<!doctype html><html><body></body></html>",
  url: "http://localhost:4800/prompt",
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { PromptRoot, promptDialog } = await import("./prompt.tsx");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mountRoot(): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={"en"} messages={messages} timeZone={"UTC"}>
        {React.createElement(PromptRoot)}
      </NextIntlClientProvider>,
    );
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  };
}

// A previous prompt may still be playing its exit; the live dialog is the
// one that is not exiting.
const LIVE_DIALOG = '[role="dialog"]:not([data-overlay-exiting])';

function field(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`${LIVE_DIALOG} #prompt-input`);
  assert.ok(input, "the prompt exposes its reason field");
  return input;
}

function confirmButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`${LIVE_DIALOG} button[type="submit"]`);
  assert.ok(button, "the dialog exposes its confirm button");
  return button;
}

/** Fill the field the way a script does: straight into the element, no events. */
function programmaticFill(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, text);
}

test("typing a reason enables the confirm button", async () => {
  const unmount = await mountRoot();
  try {
    const pending = promptDialog({ title: "Void", confirmLabel: "Void" });
    await act(async () => {
      await tick();
    });
    assert.equal(confirmButton().disabled, true, "empty reason keeps Void disabled");
    await act(async () => {
      const input = field();
      input.focus();
      // A real keystroke travels through React's onChange: the element's
      // value changes and the input event carries it into state.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "duplicate charge");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    assert.equal(confirmButton().disabled, false, "typed text enables Void");
    await act(async () => {
      confirmButton().click();
      await tick();
    });
    assert.equal(await pending, "duplicate charge");
  } finally {
    await unmount();
  }
});

test("a programmatic fill enables Void on focus and submits its text", async () => {
  const unmount = await mountRoot();
  try {
    const pending = promptDialog({ title: "Void", confirmLabel: "Void" });
    await act(async () => {
      await tick();
    });
    const input = field();
    assert.equal(confirmButton().disabled, true, "empty reason keeps Void disabled");
    programmaticFill(input, "entered by autofill");
    assert.equal(input.value, "entered by autofill", "the fill is visible in the field");
    await act(async () => {
      // Blur first: the mount effect may have left the field focused, and
      // focusing an already-focused field dispatches nothing.
      input.blur();
      await tick();
      input.focus();
      await tick();
    });
    assert.equal(
      confirmButton().disabled,
      false,
      "the fill enables Void once the field is interacted with",
    );
    await act(async () => {
      confirmButton().click();
      await tick();
    });
    assert.equal(await pending, "entered by autofill");
  } finally {
    await unmount();
  }
});

test("a text prompt marks its field required and enables submit as you type", async () => {
  const unmount = await mountRoot();
  try {
    const { act } = await import("react");
    // The timesheet Declare-no-hours shape: a labelled single-line reason.
    const pending = promptDialog({ title: "Declare no hours", label: "Reason" });
    await act(async () => {
      await tick();
    });
    const input = document.querySelector("#prompt-input") as HTMLInputElement | null;
    assert.ok(input, "the reason field renders");
    assert.equal(input.required, true, "the reason field is marked required");
    assert.equal(
      input.getAttribute("aria-required"),
      "true",
      "the requirement is exposed to assistive tech",
    );
    const label = document.querySelector('label[for="prompt-input"]');
    assert.ok(label?.textContent?.includes("*"), "the label carries the required mark");
    const submit = [...document.querySelectorAll("button")].find(
      (b) => b.type === "submit",
    ) as HTMLButtonElement;
    assert.equal(submit.disabled, true, "submit starts disabled on an empty reason");
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "Statutory holiday — site closed");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      // No blur: enablement follows the controlled value as the user types.
      await tick();
    });
    assert.equal(
      submit.disabled,
      false,
      "typing a reason enables submit without leaving the field",
    );
    await act(async () => {
      submit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    assert.equal(await pending, "Statutory holiday — site closed");
  } finally {
    await unmount();
  }
});

test("an option prompt leaves its select unmarked", async () => {
  const unmount = await mountRoot();
  try {
    const { act } = await import("react");
    promptDialog({
      title: "Choose",
      label: "Choice",
      options: [
        { value: "", label: "Keep current" },
        { value: "a", label: "Option A" },
      ],
    });
    await act(async () => {
      await tick();
    });
    const select = document.querySelector("#prompt-input") as HTMLSelectElement | null;
    assert.ok(select, "the option select renders");
    assert.equal(
      select.required,
      false,
      "an explicit default choice is valid, so the select stays unmarked",
    );
    const label = document.querySelector('label[for="prompt-input"]');
    assert.ok(!label?.textContent?.includes("*"), "no required mark on an optional choice");
  } finally {
    await unmount();
  }
});

test("submitting a programmatically filled field resolves its text, never a silent cancel", async () => {
  const unmount = await mountRoot();
  try {
    const pending = promptDialog({ title: "Void", confirmLabel: "Void" });
    await act(async () => {
      await tick();
    });
    const input = field();
    programmaticFill(input, "keyboard-submitted fill");
    await act(async () => {
      const form = input.closest("form");
      assert.ok(form, "the prompt renders a form");
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
    assert.equal(await pending, "keyboard-submitted fill");
  } finally {
    await unmount();
  }
});

test("a date prompt reads the typed date against the business date and resolves ISO", async () => {
  const unmount = await mountRoot();
  try {
    const pending = promptDialog({
      title: "Correct start",
      label: "Start date",
      kind: "date",
      initialValue: "2026-02-01",
      businessToday: "2026-10-17",
    });
    await act(async () => {
      await tick();
    });
    const input = field();
    assert.equal(
      input.getAttribute("data-date-field"),
      "",
      "the prompt renders the shared date field",
    );
    assert.equal(input.value, "02/01/2026", "the initial date shows in the viewer format");
    assert.equal(input.required, true);
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "3/15");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      input.closest("form")!.requestSubmit();
      await tick();
    });
    assert.equal(
      await pending,
      "2026-03-15",
      "Enter settles the yearless date in the business year and submits it",
    );
  } finally {
    await unmount();
  }
});
