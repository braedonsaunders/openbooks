import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/agents",
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
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/agents'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

globalThis.fetch = (async () => {
  return new Response(JSON.stringify({ total: 3 }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/fr")).default;
const { AgentsTriageKeys } = await import("./AgentsTriageKeys");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// F-t11-010(b): the inbox "new since" banner rendered its date with the
// BROWSER locale ("…Sep 16, 2026, 8:52 PM" inside a French sentence) instead
// of the app locale ("16 sept. 2026, 20:55").
test("F-t11-010: triage banner date follows the app locale", async () => {
  document.body.innerHTML = "";
  window.localStorage.setItem("agents-last-seen-test-org", "2026-09-16T20:55:00.000Z");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  /* eslint-disable react/no-children-prop */
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "fr",
        messages,
        timeZone: "UTC",
        children: React.createElement(AgentsTriageKeys, {
          rows: [],
          canWrite: false,
          orgId: "test-org",
          locale: "fr",
        }),
      }),
    );
    await tick();
    await tick();
  });
  /* eslint-enable react/no-children-prop */

  const bodyText = document.body.textContent ?? "";
  assert.match(bodyText, /sept\./i, "the banner date must use the French month");
  assert.ok(!/Sep 16/.test(bodyText), "no English month may leak into the French banner");

  await act(async () => {
    root.unmount();
  });
});
