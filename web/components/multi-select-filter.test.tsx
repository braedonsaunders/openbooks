import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules";
import { bootJsdomEnvironment } from "../testing/jsdom-env";

declare global {
  var __multiFilterNavigation: string[];
}
await bootJsdomEnvironment({ url: "http://localhost/ap/bills" });
stubModules({
  navigation: {
    source:
      'export function useRouter(){return {push(url){globalThis.__multiFilterNavigation.push(url)}}}export function usePathname(){return "/ap/bills"}export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { MultiSelectFilter } = await import("./filter-bar");

async function mount(selectedValues = ["posted"]) {
  globalThis.__multiFilterNavigation = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MultiSelectFilter
          basePath="/ap/bills"
          currentParams={{ q: "rent", sort: "total", dir: "asc", page: "4" }}
          paramKey="status"
          label="Status"
          options={[
            { value: "draft", label: "Draft" },
            { value: "posted", label: "Posted" },
            { value: "voided", label: "Voided" },
          ]}
          selectedValues={selectedValues}
        />
      </NextIntlClientProvider>,
    ),
  );
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  };
  const button = (label: string) => {
    const found = [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    assert.ok(found, label);
    return found;
  };
  await click(host.querySelector("button")!);
  return {
    click,
    button,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("multiple checks commit together, preserve the list context, and reset pagination", async (t) => {
  const view = await mount();
  t.after(view.close);
  await view.click(view.button("Draft"));
  await view.click(view.button("Voided"));
  await view.click(view.button("Posted"));
  assert.deepEqual(
    globalThis.__multiFilterNavigation,
    [],
    "checking choices must not race navigations",
  );
  const checks = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
  checks[1]!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(
    document.activeElement,
    checks.at(-1),
    "keyboard navigation includes checkbox items",
  );
  await view.click(view.button("Apply"));
  const url = new URL(globalThis.__multiFilterNavigation[0]!, "http://localhost");
  assert.equal(url.searchParams.get("status"), "draft,voided");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("q"), "rent");
  assert.equal(url.searchParams.get("sort"), "total");
  assert.equal(url.searchParams.get("dir"), "asc");
});

test("All and None are explicit choices; cancel leaves the current query untouched", async (t) => {
  const view = await mount();
  t.after(view.close);
  await view.click(view.button("All"));
  await view.click(view.button("Cancel"));
  assert.deepEqual(globalThis.__multiFilterNavigation, []);
  const trigger = document.querySelector('button[aria-haspopup="menu"]')!;
  await view.click(trigger);
  assert.equal(
    view.button("Draft").getAttribute("aria-checked"),
    "false",
    "cancelled checks are discarded",
  );
  await view.click(view.button("All"));
  await view.click(view.button("Apply"));
  assert.equal(
    new URL(globalThis.__multiFilterNavigation[0]!, "http://localhost").searchParams.get("status"),
    "all",
  );
  await view.click(trigger);
  await view.click(view.button("Posted"));
  await view.click(view.button("Apply"));
  assert.equal(
    new URL(globalThis.__multiFilterNavigation[1]!, "http://localhost").searchParams.get("status"),
    "none",
  );
});
