import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the button reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/budgets", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__newBudgetTestRouter}export function usePathname(){return '/budgets'}export function useSearchParams(){return new URLSearchParams()}" });

declare global {
  var __newBudgetTestRouter: { pushes: string[]; push(href: string): void; refresh(): void } | undefined;
}

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { NewBudgetButton } = await import("./NewBudgetButton");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * opening New must persist nothing. The old button POSTed
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
