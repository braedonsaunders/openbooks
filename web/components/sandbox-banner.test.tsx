import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// A user must read the persistent sandbox warning and exit action in their
// own locale.
// The banner is a server component, so next-intl/server is doubled with a
// stub that reads the REAL catalog: the mock translator substitutes the
// locale file's own values, and hardcoded English fails every assertion.
// The client exit button is stubbed to keep the graph light; it receives the
// translated label and the production organization to return to.
declare global {
  var __sbMessages: Record<string, Record<string, string>> | undefined;
}

const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/dashboard" });

stubModules({
  navigation: false,
  intl: "export async function getTranslations(namespace){const tree=(globalThis.__sbMessages??{})[namespace]??{};return (key,params)=>{let out=String(tree?.[key]??key);for(const [n,v] of Object.entries(params??{}))out=out.replaceAll('{'+n+'}',String(v));return out}}",
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/sandbox-exit-button")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function SandboxExitButton(p){return globalThis.React.createElement('button',{type:'button','data-production-org':p.productionOrgId},p.label)}",
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

const PRODUCTION_ORG = "00000000-0000-4000-8000-0000000000aa";

async function renderBanner(props: {
  name?: string;
  productionOrgId: string;
  kind?: "sandbox" | "preview";
}) {
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
  const { host, root } = await renderBanner({
    name: "QA-1",
    productionOrgId: PRODUCTION_ORG,
    kind: "sandbox",
  });
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Sandbox-Umgebung/);
    assert.ok(text.includes("QA-1"), "the environment name itself must still render");
    assert.match(text, /E-Mails, Zahlungen und Integrationen sind deaktiviert/);
    assert.match(text, /Zur Produktion wechseln/);
    assert.equal(
      host.querySelector("button")?.getAttribute("data-production-org"),
      PRODUCTION_ORG,
      "exit returns to the production organization the sandbox was cloned from",
    );
    for (const leaked of ["Sandbox environment", "are disabled", "Exit to production"]) {
      assert.ok(
        !text.includes(leaked),
        `English ${JSON.stringify(leaked)} must not leak into the German banner`,
      );
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

test("sample companies never render a sandbox warning or production exit", async () => {
  for (const name of [undefined, "SIM · Northstar Cloud"]) {
    assert.equal(
      await SandboxBanner({ kind: "preview", name, productionOrgId: PRODUCTION_ORG }),
      null,
    );
  }
});
