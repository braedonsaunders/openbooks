import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the workbench reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assistant",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so hydration runs against the code under test.
const worktreeRoot = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeRoot };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){},prefetch(){}}}export function usePathname(){return '/assistant'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { AssistantApp } = await import("./assistant-app");

// F-t12-011: /assistant logs minified React error #419 (hydration mismatch)
// on every load with no provider configured. Server HTML and the client's
// first render must agree for the not-configured empty state.
test("F-t12-011: not-configured assistant hydrates without mismatch", async () => {
  // The provider's overloads only accept children inside the props object.
  /* eslint-disable react/no-children-prop */
  const tree = React.createElement(NextIntlClientProvider, {
    locale: "en",
    messages,
    timeZone: "UTC",
    children: React.createElement(AssistantApp, {
      conversations: [],
      activeId: null,
      initialMessages: [],
      canWrite: true,
      aiEnabled: false,
    }),
  });
  /* eslint-enable react/no-children-prop */
  const html = renderToString(tree);
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);

  const errors: string[] = [];
  const priorError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await act(async () => {
      hydrateRoot(host, tree);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } finally {
    console.error = priorError;
    host.remove();
  }
  const hydration = errors.filter((e) => /hydrat|did not match|didn't match/i.test(e));
  assert.deepEqual(hydration, [], `hydration must be clean, got: ${hydration.join("\n---\n")}`);
});
