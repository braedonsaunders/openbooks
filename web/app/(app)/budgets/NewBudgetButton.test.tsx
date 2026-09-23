import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the button reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/budgets",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

declare global {
  var __newBudgetTestRouter: { pushes: string[]; push(href: string): void; refresh(): void } | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__newBudgetTestRouter}export function usePathname(){return '/budgets'}export function useSearchParams(){return new URLSearchParams()}",
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
const messages = (await import("../../../messages/en")).default;
const { NewBudgetButton } = await import("./NewBudgetButton");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * OM-05: opening New must persist nothing. The old button POSTed
 * /api/budgets/draft before the drawer opened, so abandoning it left a junk
 * "New budget" row. The button is now URL-only (?budgetNew=1); the drawer's
 * explicit Save is the first write.
 */
test("New opens the unsaved drawer without persisting anything", async (t) => {
  const priorFetch = globalThis.fetch;
  const fetches: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({}, { status: 500 });
  }) as typeof fetch;
  globalThis.__newBudgetTestRouter = {
    pushes: [],
    push(href: string) {
      this.pushes.push(href);
    },
    refresh() {},
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NewBudgetButton currentParams={{}} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });

  const button = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("New budget"),
  ) as HTMLButtonElement;
  assert.ok(button, "budgets list must offer New budget");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();

  assert.deepEqual(fetches, [], "opening New must issue zero requests — no draft row may exist yet");
  assert.equal(globalThis.__newBudgetTestRouter?.pushes.length, 1);
  assert.match(
    globalThis.__newBudgetTestRouter?.pushes[0] ?? "",
    /budgetNew=1/,
    "New opens the URL-controlled unsaved drawer",
  );
});
