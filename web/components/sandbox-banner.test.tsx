import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// A user must read the persistent sandbox warning and exit action in their
// own locale.
// The banner is a server component, so next-intl/server is doubled with a
// stub that reads the REAL catalog: the mock translator substitutes the
// locale file's own values, and hardcoded English fails every assertion.
// The sandbox-session server action is stubbed to keep the graph light.
declare global {
  var __sbMessages: Record<string, Record<string, string>> | undefined;
}

const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/dashboard" });

stubModules({ navigation: false, intl: 'export async function getTranslations(namespace){const tree=(globalThis.__sbMessages??{})[namespace]??{};return (key,params)=>{let out=String(tree?.[key]??key);for(const [n,v] of Object.entries(params??{}))out=out.replaceAll(\'{\'+n+\'}\',String(v));return out}}', authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/sandbox-session")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function exitSandbox(){}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const deMessages = (await import("../messages/de")).default as {
  shell: { sandboxBanner: Record<string, string> };
};
globalThis.__sbMessages = { "shell.sandboxBanner": deMessages.shell.sandboxBanner };
const { SandboxBanner } = await import("./sandbox-banner");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function renderBanner(props: { name?: string; kind?: "sandbox" | "preview" }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(await SandboxBanner(props));
    await tick();
  });
  return { host, root };
}

test("the sandbox banner warns and exits in the session locale", async () => {
  const { host, root } = await renderBanner({ name: "QA-1", kind: "sandbox" });
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Sandbox-Umgebung/);
    assert.ok(text.includes("QA-1"), "the environment name itself must still render");
    assert.match(text, /E-Mails, Zahlungen und Integrationen sind deaktiviert/);
    assert.match(text, /Zur Produktion wechseln/);
    for (const leaked of ["Sandbox environment", "are disabled", "Exit to production"]) {
      assert.ok(!text.includes(leaked), `English ${JSON.stringify(leaked)} must not leak into the German banner`);
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

test("sample companies never render a sandbox warning or production exit", async () => {
  for (const name of [undefined, "SIM · Northstar Cloud"]) {
    assert.equal(await SandboxBanner({ kind: "preview", name }), null);
  }
});
