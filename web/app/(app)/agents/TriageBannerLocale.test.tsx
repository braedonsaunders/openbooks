import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/agents", matchMediaMatches: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/agents" } });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
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

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/fr")).default;
const { AgentsTriageKeys } = await import("./AgentsTriageKeys");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// (b): the inbox "new since" banner rendered its date with the
// BROWSER locale ("…Sep 16, 2026, 8:52 PM" inside a French sentence) instead
// of the app locale ("16 sept. 2026, 20:55").
test("triage banner date follows the app locale", async () => {
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
