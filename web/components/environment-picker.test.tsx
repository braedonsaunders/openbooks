import assert from "node:assert/strict";
import test from "node:test";

// F5-5: EnvironmentPicker hardcoded its English labels (Workspace,
// Production/Sample company, Manage environments) while the hosting
// account menu translates through shell.accountMenu. A non-en user opening
// the workspace switcher must read the same language as the menu around it.
//
// Only routing and the workspace-switch action are doubled. React, next-intl
// and the REAL German catalog run, so hardcoded English fails every
// assertion below.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/dashboard",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier.endsWith("/sandbox-session")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function enterOrg(){}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/de")).default;
const { EnvironmentPicker } = await import("./environment-picker");
import type { WorkspaceEnvironments } from "../lib/environments";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// Two tenants so every label slot renders: a production row, its sandbox,
// and a sample-company tenant carrying the hint.
const env: WorkspaceEnvironments = {
  currentOrgId: "prod-a",
  envKind: "production",
  currentName: "Acme",
  homeOrgId: "prod-a",
  canManage: true,
  isSuperAdmin: false,
  tenants: [
    {
      productionOrgId: "prod-a",
      productionOrgName: "Acme",
      envKind: "production",
      sandboxes: [{ orgId: "sbx-1", name: "QA", status: "ready", tier: "full" }],
    },
    {
      productionOrgId: "prev-b",
      productionOrgName: "Muster",
      envKind: "preview",
      sandboxes: [],
    },
  ],
};

test("F5-5: the workspace switcher reads German, never English", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" messages={messages} timeZone="UTC">
        <EnvironmentPicker env={env} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  try {
    const text = host.textContent ?? "";
    assert.match(text, /Arbeitsbereich/);
    assert.match(text, /Produktion/);
    assert.match(text, /Beispielunternehmen/);
    assert.match(text, /Umgebungen verwalten/);
    for (const leaked of ["Workspace", "Production", "Manage environments", "Sample company"]) {
      assert.ok(!text.includes(leaked), `English ${JSON.stringify(leaked)} must not leak into the German switcher`);
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
