import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// in topbar nav mode the header search is hidden below lg with
// no trigger, so global search is unreachable on mobile. A toggle button
// must exist below lg and open the search.
await bootJsdomEnvironment({ url: "http://localhost:4800/dashboard" });

stubModules({ navigation: { pathname: '/dashboard' }, intl: false, authz: false, features: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const shell = (await import("../messages/en/shell.json", { with: { type: "json" } })).default;
const { TopbarSearchToggle } = await import("./topbar-search-toggle");

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    async render() {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="en" messages={{ shell }} timeZone="UTC">
            <TopbarSearchToggle navGroups={[]} />
          </NextIntlClientProvider>,
        );
      });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

test("topbar search toggle is mobile-only and opens the search", async (t) => {
  const ui = mount();
  t.after(() => ui.unmount());
  await ui.render();

  const toggle = ui.host.querySelector('button[aria-label="Search"]') as HTMLButtonElement | null;
  assert.ok(toggle, "a search toggle button must render");
  assert.match(
    (toggle.parentElement as HTMLElement | null)?.className ?? "",
    /lg:hidden/,
    "toggle must hide on desktop (the inline search owns lg+)",
  );
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(ui.host.querySelector('input[aria-label="Search"]'), null, "search input stays hidden until opened");

  await act(async () => {
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const input = ui.host.querySelector('input[aria-label="Search"]') as HTMLInputElement | null;
  assert.ok(input, "opening the toggle must reveal the search input");
});
