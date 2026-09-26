import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../../testing/jsdom-env.ts'

// jsdom first: the workbench reads browser globals at render.
const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so hydration runs against the code under test.
const worktreeRoot = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
await bootJsdomEnvironment({ url: "http://localhost:4800/assistant" });

stubModules({ navigation: { source: 'export function useRouter(){return{push(){},refresh(){},replace(){},prefetch(){}}}export function usePathname(){return \'/assistant\'}export function useSearchParams(){return new URLSearchParams()}' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeRoot };
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

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { AssistantApp } = await import("./assistant-app");

// /assistant logs minified React error #419 (hydration mismatch)
// on every load with no provider configured. Server HTML and the client's
// first render must agree for the not-configured empty state.
test("not-configured assistant hydrates without mismatch", async () => {
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
