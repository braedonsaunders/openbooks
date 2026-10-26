import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({
  html: "<!doctype html><html><body></body></html>",
  url: "http://localhost/parties?party=11111111-1111-4111-8111-111111111111",
  matchMediaMatches: false,
});
stubModules({
  navigation: {
    source:
      "export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){},back(){},forward(){}}}",
  },
  intl: false,
  authz: false,
  features: false,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { TransactionDrawer } = await import("./transaction-drawer");
const { Button } = await import("../../packages/ui/src/button");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const actionsLabel = (messages.common.labels as Record<string, string>).actions as string;

async function pointerOnly(target: Element) {
  const opts = { bubbles: true, cancelable: true, button: 0 };
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("pointerdown", opts as MouseEventInit));
    target.dispatchEvent(new window.MouseEvent("pointerup", opts as MouseEventInit));
    await tick();
    await tick();
  });
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
}

async function renderDrawer(t: TestContext, actions: React.ReactNode) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={"en"} messages={messages} timeZone={"UTC"}>
        <TransactionDrawer
          closeHref={"/parties"}
          recordId={"11111111-1111-4111-8111-111111111111"}
          title={"Vendor"}
          showEvidenceTabs={false}
          actions={actions}
        >
          {React.createElement("div", null, "body")}
        </TransactionDrawer>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
}

function actionsTrigger(): HTMLElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === actionsLabel,
  ) as HTMLElement | undefined;
}

// A vendor record's Actions slot carries statement/payment entries behind
// per-grant conditionals; the shared trigger must open the menu for both
// pointer and keyboard activation, never silently eat the press.
test("record actions open on pointer release alone", async (t: TestContext) => {
  await renderDrawer(
    t,
    React.createElement(
      React.Fragment,
      null,
      null,
      React.createElement(Button, { variant: "outline" }, "View statement"),
    ),
  );
  const trigger = actionsTrigger();
  assert.ok(trigger, "the Actions button renders when an entry is visible");
  await pointerOnly(trigger);
  assert.equal(
    trigger.getAttribute("aria-expanded"),
    "true",
    "pointer release without a click must open the menu",
  );
  const panel = document.querySelector("[data-ui-overlay]");
  assert.ok(panel?.textContent?.includes("View statement"), "the menu carries the entry");
});

test("record actions still open on click", async (t: TestContext) => {
  await renderDrawer(
    t,
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Button, { variant: "outline" }, "View statement"),
    ),
  );
  const trigger = actionsTrigger();
  assert.ok(trigger, "the Actions button renders when an entry is visible");
  await click(trigger);
  assert.equal(
    trigger.getAttribute("aria-expanded"),
    "true",
    "keyboard-equivalent click must open the menu",
  );
  assert.ok(document.querySelector("[data-ui-overlay]"), "the menu panel renders");
});

function menu(): HTMLElement | undefined {
  return document.querySelector('[role="menu"]') as HTMLElement | undefined;
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
}

async function openTwoItemMenu(t: TestContext, selected: { value: string | null }) {
  const item = (label: string) =>
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          selected.value = label;
        },
      },
      label,
    );
  await renderDrawer(
    t,
    React.createElement(React.Fragment, null, item("Post bill"), item("View statement")),
  );
  const trigger = actionsTrigger();
  assert.ok(trigger, "the Actions button renders when entries are visible");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu", "the trigger announces a menu");
  await click(trigger);
  assert.ok(menu(), "the Actions panel exposes a menu");
}

async function key(target: Element, keyName: string) {
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }),
    );
    await tick();
  });
}

// The shared Actions menu carries the same menu contract as the ViewsMenu
// and filter-chip menus: a named role="menu" whose entries are menuitems
// with arrow-key travel, native Enter activation and Escape to close.
test("record actions menu exposes menu roles", async (t: TestContext) => {
  await openTwoItemMenu(t, { value: null });
  const panel = menu();
  assert.equal(
    panel?.getAttribute("aria-label"),
    actionsLabel,
    "the menu is named for assistive technology",
  );
  const items = menuItems();
  assert.equal(items.length, 2, "every entry exposes a menuitem");
  for (const entry of items) {
    assert.ok(
      entry.tagName === "BUTTON" || entry.tagName === "A",
      "a menuitem stays natively keyboard-activatable",
    );
  }
});

test("record actions menu supports arrow-key travel", async (t: TestContext) => {
  await openTwoItemMenu(t, { value: null });
  const [first, second] = menuItems();
  assert.ok(first && second, "two menuitems render");
  await act(async () => {
    first.focus();
  });
  await key(first, "ArrowDown");
  assert.equal(document.activeElement, second, "ArrowDown moves to the next entry");
  await key(second, "ArrowDown");
  assert.equal(document.activeElement, first, "ArrowDown wraps past the last entry");
  await key(first, "ArrowUp");
  assert.equal(document.activeElement, second, "ArrowUp wraps past the first entry");
  await key(second, "Home");
  assert.equal(document.activeElement, first, "Home jumps to the first entry");
  await key(first, "End");
  assert.equal(document.activeElement, second, "End jumps to the last entry");
});

test("record actions menu entry activates on click", async (t: TestContext) => {
  const selected: { value: string | null } = { value: null };
  await openTwoItemMenu(t, selected);
  const [, second] = menuItems();
  assert.ok(second, "a second entry renders");
  await click(second);
  assert.equal(
    selected.value,
    "View statement",
    "the focused entry activates like a native control",
  );
});

test("record actions menu closes on Escape", async (t: TestContext) => {
  await openTwoItemMenu(t, { value: null });
  const trigger = actionsTrigger();
  assert.ok(trigger, "the Actions button renders");
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    await tick();
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "false", "Escape closes the menu");
  assert.equal(document.querySelector("[data-ui-overlay]"), null, "the closed menu unmounts");
});
