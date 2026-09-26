import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
await bootJsdomEnvironment({ url: "http://localhost:4800/agents?q=tax+code", matchMediaMatches: false });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__searchProbeRouter}export function usePathname(){return \'/agents\'}export function useSearchParams(){return new URLSearchParams(globalThis.__searchProbeQs)}' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    return next(specifier, context);
  },
});

Object.assign(globalThis, {
  __searchProbeQs: "q=tax+code",
  __searchProbeRouter: { push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { SearchInput } = await import("./search-input");

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

// Regression pin for (search half): a URL-loaded q must be visible
// in the box (with its clear control) rather than applied invisibly.
test("search box reflects the URL q on fresh load", async () => {
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
        children: React.createElement(SearchInput, { placeholder: "Search" }),
      }),
    );
    await tick();
    await tick();
  });
  /* eslint-enable react/no-children-prop */
  const input = document.querySelector("input") as HTMLInputElement | null;
  assert.ok(input, "the search input must render");
  assert.equal(input.value, "tax code");
  await act(async () => {
    root.unmount();
  });
});
