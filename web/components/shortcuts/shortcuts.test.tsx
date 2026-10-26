import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ComponentType, ReactNode } from "react";
import { stubModules } from "../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../testing/jsdom-env.ts";

await bootJsdomEnvironment({
  url: "http://localhost/dashboard",
  matchMediaMatches: false,
  event: "jsdom",
});
// Key caps and the primary modifier follow the platform; pin a non-Apple one.
Object.defineProperty(globalThis.navigator, "platform", {
  value: "Linux x86_64",
  configurable: true,
});

stubModules({
  navigation: { routerSource: "export function useRouter(){return globalThis.__shortcutRouter}" },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(){},error(m){(globalThis.__shortcutToasts??=[]).push(m)}};export function Toaster(){return null}",
  },
});

const React = await import("react");
const router = {
  pushes: [] as string[],
  push(url: string) {
    this.pushes.push(url);
  },
  refresh() {},
  replace() {},
  back() {},
  forward() {},
};
Object.assign(globalThis, { React, __shortcutRouter: router });
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{
  locale: string;
  messages: typeof messages;
  timeZone: string;
  children?: ReactNode;
}>;
const { ShortcutProvider, useShortcuts } = await import("./shortcut-provider");
const { GlobalShortcuts } = await import("./global-shortcuts");
const { FormShortcuts } = await import("./form-shortcuts");
const { bindingKeys, bindingMatches, isEditableTarget } = await import("./shortcut-keys");
type ShortcutCommand = import("./shortcut-keys").ShortcutCommand;

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const shortcutCopy = messages.shell.shortcuts;

async function mount(t: TestContext, children: ReactNode) {
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
        <ShortcutProvider>{children}</ShortcutProvider>
      </IntlProvider>,
    );
    await tick();
  });
  return {
    host,
    rerender: async (next: ReactNode) => {
      await act(async () => {
        root.render(
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <ShortcutProvider>{next}</ShortcutProvider>
          </IntlProvider>,
        );
        await tick();
      });
    },
  };
}

function chord(code: string, init: KeyboardEventInit = {}) {
  return new window.KeyboardEvent("keydown", {
    code,
    key: code.replace(/^Key/, "").toLowerCase(),
    ctrlKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

async function press(target: EventTarget, event: KeyboardEvent) {
  await act(async () => {
    target.dispatchEvent(event);
    await tick();
  });
  return event;
}

function Commands({ commands }: { commands: ShortcutCommand[] }) {
  useShortcuts(commands);
  return null;
}

/** A form-scoped command bound to its own container, like a drawer. */
function ScopedForm({ onRun, label = "Form save" }: { onRun: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useShortcuts([
    {
      id: "formThing",
      label,
      binding: { modifier: "chord", code: "KeyS" },
      scope: "form",
      allowInEditable: true,
      container: () => ref.current,
      run: onRun,
    },
  ]);
  return (
    <div ref={ref} data-testid="form">
      <input aria-label="form field" />
      <button type="button">inside</button>
    </div>
  );
}

test("bindings match physical keys with platform modifiers and never an AltGr press", () => {
  const event = (init: Partial<KeyboardEvent>) => ({
    code: "KeyS",
    key: "s",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  });
  assert.equal(
    bindingMatches({ modifier: "primary", code: "KeyS" }, event({ metaKey: true }), true),
    true,
  );
  assert.equal(
    bindingMatches({ modifier: "primary", code: "KeyS" }, event({ ctrlKey: true }), true),
    false,
    "Ctrl is not ⌘ on macOS",
  );
  assert.equal(
    bindingMatches({ modifier: "primary", code: "KeyS" }, event({ ctrlKey: true }), false),
    true,
  );
  assert.equal(
    bindingMatches(
      { modifier: "chord", code: "KeyS" },
      event({ ctrlKey: true, altKey: true, key: "ß" }),
      true,
    ),
    true,
    "Option dead keys still match on the physical key",
  );
  assert.equal(
    bindingMatches(
      { modifier: "chord", code: "KeyS" },
      {
        ...event({ ctrlKey: true, altKey: true }),
        getModifierState: (key: string) => key === "AltGraph",
      },
      false,
    ),
    false,
  );
  assert.equal(
    bindingMatches({ character: "?" }, event({ key: "?", code: "Slash", shiftKey: true }), false),
    true,
  );
  assert.equal(
    bindingMatches({ character: "?" }, event({ key: "?", code: "Slash", ctrlKey: true }), false),
    false,
  );
  assert.deepEqual(bindingKeys({ modifier: "chord", code: "KeyI" }, true), ["⌃", "⌥", "I"]);
  assert.deepEqual(bindingKeys({ modifier: "chord", code: "KeyI" }, false), ["Ctrl", "Alt", "I"]);
  assert.deepEqual(bindingKeys({ modifier: "primary", code: "KeyS" }, true), ["⌘", "S"]);
});

test("a registered command runs on its chord and stops when its surface unmounts", async (t) => {
  let runs = 0;
  const command: ShortcutCommand = {
    id: "probe",
    label: "Probe",
    binding: { modifier: "chord", code: "KeyI" },
    scope: "global",
    run: () => {
      runs += 1;
    },
  };
  const view = await mount(t, <Commands commands={[command]} />);
  const event = await press(document.body, chord("KeyI"));
  assert.equal(runs, 1);
  assert.equal(event.defaultPrevented, true, "a handled chord does not reach the browser");
  await press(document.body, chord("KeyI", { shiftKey: true }));
  assert.equal(runs, 1, "an extra modifier is a different binding");
  await view.rerender(null);
  await press(document.body, chord("KeyI"));
  assert.equal(runs, 1, "an unmounted surface no longer answers");
});

test("a form command beats a global one inside its container, and yields outside it", async (t) => {
  const hits: string[] = [];
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  t.after(() => outside.remove());
  await mount(
    t,
    <>
      <Commands
        commands={[
          {
            id: "globalThing",
            label: "Global",
            binding: { modifier: "chord", code: "KeyS" },
            scope: "global",
            run: () => hits.push("global"),
          },
        ]}
      />
      <ScopedForm onRun={() => hits.push("form")} />
    </>,
  );
  const inside = document.querySelector('[data-testid="form"] button') as HTMLButtonElement;
  inside.focus();
  await press(inside, chord("KeyS"));
  outside.focus();
  await press(outside, chord("KeyS"));
  assert.deepEqual(hits, ["form", "global"]);
});

test("the innermost container wins between nested form commands", async (t) => {
  const hits: string[] = [];
  function Nested() {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    useShortcuts([
      {
        id: "inner",
        label: "Inner",
        binding: { modifier: "chord", code: "KeyG" },
        scope: "form",
        container: () => inner.current,
        run: () => hits.push("inner"),
      },
    ]);
    return (
      <div ref={outer}>
        <OuterCommand container={() => outer.current} onRun={() => hits.push("outer")} />
        <div ref={inner}>
          <button type="button" data-testid="inner">
            x
          </button>
        </div>
        <button type="button" data-testid="outer">
          y
        </button>
      </div>
    );
  }
  function OuterCommand({
    container,
    onRun,
  }: {
    container: () => Element | null;
    onRun: () => void;
  }) {
    // Registered after the inner command, so registration order alone would pick it.
    useShortcuts([
      {
        id: "outer",
        label: "Outer",
        binding: { modifier: "chord", code: "KeyG" },
        scope: "form",
        container,
        run: onRun,
      },
    ]);
    return null;
  }
  await mount(t, <Nested />);
  const innerButton = document.querySelector('[data-testid="inner"]') as HTMLButtonElement;
  innerButton.focus();
  await press(innerButton, chord("KeyG"));
  const outerButton = document.querySelector('[data-testid="outer"]') as HTMLButtonElement;
  outerButton.focus();
  await press(outerButton, chord("KeyG"));
  assert.deepEqual(hits, ["inner", "outer"]);
});

test("typing in a field is never hijacked except by explicit form bindings", async (t) => {
  const hits: string[] = [];
  await mount(
    t,
    <>
      <Commands
        commands={[
          {
            id: "globalNew",
            label: "Global",
            binding: { modifier: "chord", code: "KeyI" },
            scope: "global",
            run: () => hits.push("global"),
          },
        ]}
      />
      <ScopedForm onRun={() => hits.push("form")} />
    </>,
  );
  const field = document.querySelector('input[aria-label="form field"]') as HTMLInputElement;
  assert.equal(isEditableTarget(field), true);
  field.focus();
  const ignored = await press(field, chord("KeyI"));
  assert.equal(ignored.defaultPrevented, false, "the keystroke stays with the field");
  await press(field, chord("KeyS"));
  const altGr = chord("KeyS");
  Object.defineProperty(altGr, "getModifierState", { value: (key: string) => key === "AltGraph" });
  await press(field, altGr);
  const textChord = chord("KeyS", { key: "ś" });
  await press(field, textChord);
  await press(
    field,
    new window.KeyboardEvent("keydown", {
      key: "?",
      code: "Slash",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.deepEqual(
    hits,
    ["form"],
    "only the form binding fired; AltGr and layout text chords typed instead",
  );
  assert.equal(
    document.querySelector('[role="dialog"]'),
    null,
    "? typed into a field does not open the help sheet",
  );
});

test("commands do not act beneath an open menu or confirmation", async (t) => {
  let runs = 0;
  await mount(
    t,
    <Commands
      commands={[
        {
          id: "probe",
          label: "Probe",
          binding: { modifier: "chord", code: "KeyI" },
          scope: "global",
          run: () => {
            runs += 1;
          },
        },
      ]}
    />,
  );
  const overlay = document.createElement("div");
  overlay.setAttribute("data-ui-overlay", "");
  const option = document.createElement("button");
  overlay.appendChild(option);
  document.body.appendChild(overlay);
  t.after(() => overlay.remove());
  option.focus();
  await press(option, chord("KeyI"));
  assert.equal(runs, 0);
});

test("global create and go-to commands exist only with the permission, feature and navigation entry", async (t) => {
  const none = {
    accountsReceivable: false,
    accountsPayable: false,
    journal: false,
    customerPayments: false,
    vendorPayments: false,
    expenses: false,
    parties: false,
    items: false,
    projects: false,
    assets: false,
    orders: false,
  };
  router.pushes.length = 0;
  const view = await mount(t, <GlobalShortcuts permissions={none} groups={[]} />);
  await press(document.body, chord("KeyI"));
  await press(document.body, chord("KeyB"));
  await press(document.body, chord("KeyX"));
  await press(document.body, chord("KeyP"));
  assert.deepEqual(router.pushes, [], "nothing is offered without grants or navigation");

  const groups = [
    {
      id: "insights",
      label: "Insights",
      iconKey: "activity",
      items: [{ href: "/reports", label: "Reports", iconKey: "chart" }],
    },
  ];
  await view.rerender(
    <GlobalShortcuts
      permissions={{ ...none, accountsReceivable: true, accountsPayable: true, expenses: true }}
      groups={groups}
    />,
  );
  await press(document.body, chord("KeyI"));
  await press(document.body, chord("KeyB"));
  await press(document.body, chord("KeyX"));
  await press(document.body, chord("KeyP"));
  await press(document.body, chord("KeyK"));
  assert.deepEqual(
    router.pushes,
    [
      "/ar/invoices?doc=new&kind=customer_invoice&mode=edit",
      "/ap/bills?doc=new&kind=vendor_bill&mode=edit",
      "/expenses/reports?expense=new&mode=edit",
      "/reports",
    ],
    "each command opens the same editor as the create menu; banking is absent from this navigation",
  );
});

test("form save commands respect the busy state and work while typing", async (t) => {
  const hits: string[] = [];
  function Form({ enabled }: { enabled: boolean }) {
    return (
      <div role="dialog" aria-label="Invoice">
        <FormShortcuts
          enabled={enabled}
          actions={{
            save: () => hits.push("save"),
            saveAndNew: () => hits.push("new"),
            saveAndClose: () => hits.push("close"),
          }}
        />
        <input aria-label="memo" />
      </div>
    );
  }
  const view = await mount(t, <Form enabled />);
  const field = document.querySelector('input[aria-label="memo"]') as HTMLInputElement;
  field.focus();
  await press(
    field,
    new window.KeyboardEvent("keydown", {
      code: "KeyS",
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await press(field, chord("KeyS"));
  await press(field, chord("KeyD"));
  assert.deepEqual(hits, ["save", "new", "close"]);
  await view.rerender(<Form enabled={false} />);
  const busyField = document.querySelector('input[aria-label="memo"]') as HTMLInputElement;
  busyField.focus();
  const ignored = await press(busyField, chord("KeyS"));
  assert.deepEqual(hits, ["save", "new", "close"], "a running save is not started again");
  assert.equal(ignored.defaultPrevented, false);
});

test("? opens a help sheet listing only available commands by scope, plus date-field keys", async (t) => {
  await mount(
    t,
    <Commands
      commands={[
        {
          id: "available",
          label: "Available thing",
          binding: { modifier: "chord", code: "KeyI" },
          scope: "global",
          run: () => {},
        },
        {
          id: "unavailable",
          label: "Disabled thing",
          binding: { modifier: "chord", code: "KeyB" },
          scope: "global",
          enabled: () => false,
          run: () => {},
        },
        {
          id: "lazy",
          label: () => "Page thing",
          binding: { modifier: "chord", code: "KeyL" },
          scope: "page",
          run: () => {},
        },
      ]}
    />,
  );
  await press(
    document.body,
    new window.KeyboardEvent("keydown", {
      key: "?",
      code: "Slash",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await act(async () => {
    await tick();
  });
  const sheet = document.querySelector('[role="dialog"]');
  assert.ok(sheet, "the help sheet opens");
  const text = sheet.textContent ?? "";
  assert.match(text, new RegExp(shortcutCopy.title));
  assert.match(text, /Available thing/);
  assert.match(text, /Page thing/);
  assert.doesNotMatch(text, /Disabled thing/, "a disabled command is not advertised");
  assert.match(text, new RegExp(shortcutCopy.scopes.global));
  assert.match(text, new RegExp(shortcutCopy.scopes.page));
  assert.match(text, new RegExp(shortcutCopy.commands.help));
  assert.match(text, new RegExp(messages.shell.dateEntry.keys.monthEnd));
  const caps = [...sheet.querySelectorAll("kbd")].map((kbd) => kbd.textContent);
  assert.ok(
    caps.includes("Ctrl") && caps.includes("Alt") && caps.includes("I"),
    "key caps name the chord",
  );
  assert.ok(caps.includes("T") && caps.includes("+"), "date-field keys are listed");
  assert.match(text, new RegExp(messages.shell.dateEntry.calendarKey));
  assert.ok(caps.includes("↓"), "the calendar key is listed");
  assert.ok(text.includes(messages.shell.dateEntry.typingHint), "typed entry is explained");
  const pageHeading = [...sheet.querySelectorAll("h3")].map((heading) => heading.textContent);
  assert.ok(
    pageHeading.indexOf(shortcutCopy.scopes.page) < pageHeading.indexOf(shortcutCopy.scopes.global),
    "narrower scopes list first",
  );
});
