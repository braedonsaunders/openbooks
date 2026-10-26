import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// "New expense report" is URL-only: it opens the unsaved-create drawer and
// must never write a numbered draft on click.
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/expenses",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});

const script = {
  toasts: [] as Array<{ kind: "success" | "error"; message: string }>,
  pushed: [] as string[],
};
Object.assign(globalThis, {
  __newExpenseButtonTestToasts: script.toasts,
  __newExpenseButtonTestRouter: {
    push(url: string) {
      script.pushed.push(url);
    },
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
});
const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__newExpenseButtonTestRouter}export function usePathname(){return "/expenses"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(message){globalThis.__newExpenseButtonTestToasts.push({kind:"success",message})},error(message){globalThis.__newExpenseButtonTestToasts.push({kind:"error",message})}};export function Toaster(){return null}',
      };
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
const { NewExpenseButton } = await import("./NewExpenseButton");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mountButton(t: TestContext, fetchImpl: typeof fetch): Promise<void> {
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });
  script.toasts.length = 0;
  script.pushed.length = 0;
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NewExpenseButton />
      </NextIntlClientProvider>,
    );
    await tick();
  });
}

function button(): HTMLButtonElement {
  const found = document.querySelector("button");
  assert.ok(found, "the New expense report button must render");
  return found as HTMLButtonElement;
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    await tick();
  });
}

test("New opens the unsaved-create drawer and writes nothing", async (t) => {
  const requests: string[] = [];
  await mountButton(t, (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({});
  }) as typeof fetch);
  await click(button());
  assert.deepEqual(requests, [], "opening New must not call the server");
  assert.deepEqual(script.pushed, ["/expenses/reports?expense=new&mode=edit"]);
  assert.equal(script.toasts.length, 0, "opening New toasts nothing");
});
