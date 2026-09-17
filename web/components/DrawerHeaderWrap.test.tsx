import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/agents?item=00000000-0000-4000-8000-000000000001",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/agents'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
// Import the shared drawer source directly (not the @openbooks/ui symlink,
// which resolves to the main checkout).
const { UrlDrawer } = await import("../../packages/ui/src/drawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("F-t11-009: drawer banner stacks instead of squeezing at 390px", async () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  /* eslint-disable react/no-children-prop */
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(UrlDrawer, {
          open: true,
          closeHref: "/agents",
          size: "lg",
          title: "Credit-hold candidate",
          description: "Aged arrears justify requiring prepayment on new orders.",
          headerActions: React.createElement("button", { type: "button" }, "Ask about this"),
          children: React.createElement("div", null, "body"),
        }),
      }),
    );
    await tick();
    await tick();
  });
  /* eslint-enable react/no-children-prop */

  const header = document.querySelector("header");
  assert.ok(header, "the drawer banner must render");
  assert.ok(
    header.classList.contains("flex-wrap"),
    "the banner must wrap so actions drop below the text on narrow screens",
  );
  const textBlock = header.firstElementChild;
  assert.ok(textBlock instanceof HTMLElement, "the title/description block must render");
  assert.ok(
    textBlock.classList.contains("flex-1"),
    "the text block must flex so it claims full width when the actions wrap",
  );
  const actions = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ask about this"),
  );
  assert.ok(actions, "the header action must still render");

  await act(async () => {
    root.unmount();
  });
});
