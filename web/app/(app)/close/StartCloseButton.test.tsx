import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __startCloseRouter: { push(href: string): void } | undefined;
  var __startCloseToasts: string[] | undefined;
}

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:4800/close" });
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return { shortCircuit: true, url: "data:text/javascript,export function useRouter(){return globalThis.__startCloseRouter}" };
    }
    if (specifier === "sonner") {
      return { shortCircuit: true, url: "data:text/javascript,export const toast={error(m){(globalThis.__startCloseToasts??=[]).push(String(m))}}" };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { StartCloseButton } = await import("./StartCloseButton");

test("a non-JSON start refusal shows the action fallback and releases busy state", async (t) => {
  const pushes: string[] = [];
  globalThis.__startCloseRouter = { push: (href) => pushes.push(href) };
  globalThis.__startCloseToasts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream gateway unavailable", { status: 503, headers: { "content-type": "text/plain" } })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StartCloseButton periodId="period-a" books={[{ id: "book-a", name: "Main" }]} />
      </NextIntlClientProvider>,
    );
  });

  const button = host.querySelector("button");
  assert.ok(button);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.deepEqual(pushes, [], "a refused start does not navigate to a run");
  assert.match(globalThis.__startCloseToasts?.[0] ?? "", /The close action could not be completed \(status 503\)/);
  assert.equal(button.disabled, false, "the failed request releases the start button");
});
