import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// F5-5: EnvironmentPicker hardcoded its English labels (Workspace,
// Production/Sample company, Manage environments) while the hosting
// account menu translates through shell.accountMenu. A non-en user opening
// the workspace switcher must read the same language as the menu around it.
// Only routing, toasts and the workspace-switch request are doubled. React, next-intl
// and the REAL German catalog run, so hardcoded English fails every
// assertion below.
declare global {
  var __pickerSwitches: string[];
  var __pickerToasts: string[];
  var __pickerRefusal: string | null;
}
globalThis.__pickerSwitches = [];
globalThis.__pickerToasts = [];
globalThis.__pickerRefusal = null;

const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/dashboard", matchMediaMatches: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier.endsWith("/workspace-switch")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
          export class WorkspaceSwitchError extends Error { constructor(refusal) { super(refusal); this.refusal = refusal } }
          export function workspaceSwitchMessageKey(error) {
            return error instanceof WorkspaceSwitchError && error.refusal === "workspace_unavailable" ? "switchUnavailable" : "switchFailed"
          }
          export async function switchWorkspace(orgId) {
            globalThis.__pickerSwitches.push(orgId)
            if (globalThis.__pickerRefusal) throw new WorkspaceSwitchError(globalThis.__pickerRefusal)
          }`),
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={error(m){globalThis.__pickerToasts.push(String(m))}}",
      };
    }
    return next(specifier, context);
  },
});

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
      assert.ok(
        !text.includes(leaked),
        `English ${JSON.stringify(leaked)} must not leak into the German switcher`,
      );
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

async function renderPicker() {
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
  const row = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((button) =>
      button.textContent?.includes(label),
    )!;
  const click = async (label: string) => {
    await act(async () => {
      row(label).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
  };
  return { click, unmount: () => act(async () => root.unmount()) };
}

test("choosing a workspace switches through the workspace endpoint", async () => {
  globalThis.__pickerSwitches = [];
  globalThis.__pickerToasts = [];
  globalThis.__pickerRefusal = null;
  const picker = await renderPicker();
  try {
    await picker.click("QA");
    assert.deepEqual(globalThis.__pickerSwitches, ["sbx-1"]);
    assert.deepEqual(globalThis.__pickerToasts, []);
  } finally {
    await picker.unmount();
  }
});

test("a refused switch tells the operator why, in their language", async () => {
  globalThis.__pickerSwitches = [];
  globalThis.__pickerToasts = [];
  globalThis.__pickerRefusal = "workspace_unavailable";
  const picker = await renderPicker();
  try {
    await picker.click("QA");
    assert.deepEqual(globalThis.__pickerSwitches, ["sbx-1"]);
    assert.deepEqual(globalThis.__pickerToasts, [messages.shell.accountMenu.switchUnavailable]);
    globalThis.__pickerRefusal = "failed";
    await picker.click("QA");
    assert.deepEqual(globalThis.__pickerToasts.at(-1), messages.shell.accountMenu.switchFailed);
  } finally {
    globalThis.__pickerRefusal = null;
    await picker.unmount();
  }
});
