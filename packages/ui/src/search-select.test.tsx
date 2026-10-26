import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../web/testing/jsdom-env";
import { stubModules } from "../../../web/testing/stub-modules";

await bootJsdomEnvironment({ event: "native", matchMediaMatches: true });
stubModules({ navigation: false });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { SearchSelect } = await import("./search-select");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../web/messages/en")).default;

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const vendors = [
  "Adobe Inc",
  "Brookfield Properties",
  "Consolidated Edison",
  "Fastenal Company",
  "Google Ads",
  "Grainger",
  "Grant Thornton LLP",
  "Microsoft Corporation",
  "Staples Business Advantage",
].map((label, index) => ({
  value: `v${index}`,
  label,
  keywords: index === 2 ? ["CONED"] : undefined,
}));

const state: { value: string; created: string[] } = { value: "", created: [] };

async function mount(props: Partial<React.ComponentProps<typeof SearchSelect>> = {}) {
  state.value = "";
  state.created = [];
  function Harness() {
    const [value, setValue] = React.useState("");
    const [options, setOptions] = React.useState(vendors);
    state.value = value;
    return (
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <div role="dialog">
          <SearchSelect
            id="vendor"
            value={value}
            onChange={(next) => {
              state.value = next;
              setValue(next);
            }}
            options={options}
            onCreate={async (name) => {
              state.created.push(name);
              const option = { value: `new-${name}`, label: name, keywords: undefined };
              setOptions((current) => [...current, option]);
              return option;
            }}
            {...props}
          />
          <input id="next-field" />
        </div>
      </NextIntlClientProvider>
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Harness />);
    await tick();
  });
  const trigger = host.querySelector<HTMLButtonElement>("#vendor")!;
  return {
    host,
    trigger,
    async done() {
      await act(async () => root.unmount());
      host.remove();
      window.localStorage.clear();
    },
  };
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
    await tick();
  });
}
const search = () => document.activeElement as HTMLInputElement;
async function type(value: string) {
  await act(async () => {
    const input = search();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

test("typing on the closed control opens it searching, ranked by how strongly the text anchors", async (t) => {
  const { trigger, done } = await mount();
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "s" });
  assert.equal(search().value, "s");
  await type("sta");
  const first = document.querySelector('[role="option"]')?.textContent;
  assert.equal(first, "Staples Business Advantage");
  await key(search(), { key: "Enter" });
  assert.equal(state.value, "v8");
  assert.ok(document.activeElement === trigger, "focus returns to the control");
});

test("organization codes match although the label never contains them", async (t) => {
  const { trigger, done } = await mount();
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "Enter" });
  await type("coned");
  await key(search(), { key: "Enter" });
  assert.equal(state.value, "v2");
});

test("advanceOnSelect moves focus to the next field after a keyboard choice", async (t) => {
  const { trigger, done } = await mount({ advanceOnSelect: true });
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "g" });
  await type("grai");
  await key(search(), { key: "Enter" });
  assert.equal(state.value, "v5");
  assert.equal((document.activeElement as HTMLElement).id, "next-field");
});

test("Tab accepts the narrowed match and moves on; with nothing typed it keeps the value", async (t) => {
  const { trigger, done } = await mount();
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "m" });
  await type("micro");
  await key(search(), { key: "Tab" });
  assert.equal(state.value, "v7");
  assert.equal((document.activeElement as HTMLElement).id, "next-field");
});

test("Enter never creates a record from a typo: the create row must be chosen deliberately", async (t) => {
  const { trigger, done } = await mount();
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "Enter" });
  await type("Uline");
  assert.match(document.querySelector('[role="listbox"]')?.textContent ?? "", /Create “Uline”/);
  await key(search(), { key: "Enter" });
  assert.deepEqual(state.created, [], "Enter on an unarmed create row does nothing");
  await key(search(), { key: "ArrowDown" });
  await key(search(), { key: "Enter" });
  assert.deepEqual(state.created, ["Uline"]);
  assert.equal(state.value, "new-Uline");
});

test("⌘/Ctrl+Enter inside the list closes it without choosing, leaving the command to the form", async (t) => {
  const { trigger, done } = await mount();
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "Enter" });
  await type("adobe");
  await key(search(), { key: "Enter", metaKey: true });
  assert.equal(state.value, "");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("recently chosen records lead the list under their own heading", async (t) => {
  const { trigger, done } = await mount({ recentKey: "test-vendor" });
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "Enter" });
  await type("grant");
  await key(search(), { key: "Enter" });
  assert.equal(state.value, "v6");
  await key(trigger, { key: "Enter" });
  const listbox = document.querySelector('[role="listbox"]')?.textContent ?? "";
  assert.match(listbox, /^Recent/);
  assert.equal(document.querySelector('[role="option"]')?.textContent, "Grant Thornton LLP");
});

test("? on a focused control is left for the keyboard help, never typed into a search", async (t) => {
  const { trigger, done } = await mount();
  t.after(done);
  trigger.focus();
  const event = new window.KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true });
  await act(async () => {
    trigger.dispatchEvent(event);
    await tick();
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(event.defaultPrevented, false);
});

test("Tab never silently chooses a weak account-code substring", async (t) => {
  const { trigger, done } = await mount({
    options: [{ value: "16100", label: "16100 Accrued rent" }],
  });
  t.after(done);
  trigger.focus();
  await key(trigger, { key: "6" });
  await type("6100");
  await key(search(), { key: "Tab" });
  assert.equal(state.value, "");
});

test("primary Enter reaches the enclosing form command once from an open picker", async (t) => {
  const { host, trigger, done } = await mount();
  t.after(done);
  const { resolveShortcut } = await import("../../../web/components/shortcuts/shortcut-keys");
  let posted = 0;
  const command = {
    id: "post",
    label: "Post",
    binding: { modifier: "primary" as const, code: "Enter" },
    scope: "form" as const,
    allowInEditable: true,
    container: () => host,
    run() {
      posted += 1;
    },
    order: 1,
  };
  const listener = (event: KeyboardEvent) => resolveShortcut([command], event, true)?.run();
  document.addEventListener("keydown", listener);
  t.after(() => document.removeEventListener("keydown", listener));
  trigger.focus();
  await key(trigger, { key: "Enter" });
  await key(search(), { key: "Enter", code: "Enter", metaKey: true });
  assert.equal(posted, 1);
  assert.equal(state.value, "");
});
