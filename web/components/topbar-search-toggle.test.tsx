import assert from "node:assert/strict";
import test from "node:test";

// F-t11-014: in topbar nav mode the header search is hidden below lg with
// no trigger, so global search is unreachable on mobile. A toggle button
// must exist below lg and open the search.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/dashboard",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return '/dashboard'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
            <TopbarSearchToggle />
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

test("F-t11-014: topbar search toggle is mobile-only and opens the search", async (t) => {
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
