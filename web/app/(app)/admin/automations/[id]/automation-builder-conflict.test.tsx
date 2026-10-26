// F4T-12: a save over a moved recipe writes nothing and parks the named
// refusal as a notice with a Reload path. Local edits stay until the editor
// reloads; the next save carries the loaded version.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the builder reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/admin/automations/00000000-0000-4000-8000-000000000000",
  matchMediaMatches: false,
  resizeObserver: true,
});

const posted: { url: string; body: Record<string, unknown> }[] = [];
let patchStatus = 200;
let patchBody: unknown = { automation: { version: 4 } };
const priorFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (init?.method === "PATCH") {
    posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(patchBody), {
      status: patchStatus,
      headers: { "content-type": "application/json" },
    });
  }
  return Response.json({});
}) as typeof fetch;

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__builderConflictRouter}export function usePathname(){return "/admin/automations/x"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){},info(){}}",
      };
    }
    return next(specifier, context);
  },
});

Object.assign(globalThis, {
  __builderConflictRouter: { push() {}, replace() {}, refresh() {} },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { AutomationBuilder } = await import("./AutomationBuilder");

const AUTOMATION = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "Overdue notifier",
  description: null,
  status: "enabled",
  version: 3,
  trigger: { kind: "manual" },
  rules: {},
  conditions: {},
  actions: [{ kind: "send_notification", to: "initiator", body: "Review the automation." }],
  errorMessage: null,
};

async function mount(): Promise<HTMLElement> {
  posted.length = 0;
  patchStatus = 200;
  patchBody = { automation: { version: 4 } };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AutomationBuilder
          automation={AUTOMATION}
          runs={[]}
          scopeOptions={{
            subsidiaries: [],
            departments: [],
            locations: [],
            positions: [],
            users: [],
            roles: [],
            processTemplates: [],
          }}
          canSimulate={false}
          canManage={true}
          saveFailed="Save failed"
          backHref="/admin/automations"
          backLabel="Back"
        />
      </NextIntlClientProvider>,
    );
  });
  return host;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

async function clickSave(host: HTMLElement) {
  const save = [...host.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Save",
  );
  assert.ok(save, "single save button renders");
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  // Let the mocked PATCH promise settle.
  await act(async () => {
    await Promise.resolve();
  });
}

test("one save carries the loaded version and complete edited recipe", async () => {
  const host = await mount();
  try {
    const name = host.querySelector("#ab-name") as HTMLInputElement;
    await act(async () => setInputValue(name, "Automation ready"));
    await clickSave(host);
    assert.equal(posted.length, 1, "one PATCH posts the save");
    assert.equal(posted[0]!.body.expectedVersion, 3, "the save carries the loaded version");
    assert.equal(posted[0]!.body.name, "Automation ready", "the save posts the edited name");
    assert.deepEqual(
      posted[0]!.body.trigger,
      { kind: "manual" },
      "the save posts the complete trigger",
    );
    assert.deepEqual(
      posted[0]!.body.actions,
      AUTOMATION.actions,
      "the save posts the complete action list",
    );
    assert.ok((host.textContent ?? "").includes("v4"), "the header advances to the saved version");
  } finally {
    host.remove();
  }
});

test("the update-field editor preserves the selected value type", async () => {
  const host = await mount();
  try {
    const actionKind = [...host.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "update_field"),
    );
    assert.ok(actionKind, "action kind selector renders");
    await act(async () => setSelectValue(actionKind as HTMLSelectElement, "update_field"));
    await act(async () => {
      setInputValue(host.querySelector("#ab-action-entity-0") as HTMLInputElement, "employment");
      setInputValue(host.querySelector("#ab-action-field-0") as HTMLInputElement, "status");
    });
    await act(async () => {
      const valueType = [...host.querySelectorAll("select")].find((select) =>
        [...select.options].some((option) => option.value === "number"),
      );
      assert.ok(valueType, "value type selector renders");
      setSelectValue(valueType as HTMLSelectElement, "number");
    });
    await act(async () => {
      setInputValue(host.querySelector("#ab-action-value-0") as HTMLInputElement, "42");
      host
        .querySelector("#ab-action-value-0")!
        .dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
    await clickSave(host);
    assert.deepEqual(posted[0]!.body.actions, [
      { kind: "update_field", entity: "employment", field: "status", value: 42 },
    ]);
  } finally {
    host.remove();
  }
});

test("a 409 parks the named refusal, keeps the typed edits, and offers Reload", async () => {
  const host = await mount();
  try {
    patchStatus = 409;
    patchBody = {
      error: "the automation changed since it was loaded (now at version 5)",
      code: "automation_stale_version",
      version: 5,
    };
    const name = host.querySelector("#ab-name") as HTMLInputElement;
    await act(async () => {
      setInputValue(name, "Renamed by the second editor");
    });
    await clickSave(host);
    const text = host.textContent ?? "";
    assert.ok(text.includes("now at version 5"), "the refusal names the stored version");
    assert.ok(text.includes("Refresh"), "the refusal offers a Reload path");
    assert.equal(
      (host.querySelector("#ab-name") as HTMLInputElement).value,
      "Renamed by the second editor",
      "the typed edits survive the refusal",
    );
  } finally {
    host.remove();
    globalThis.fetch = priorFetch;
  }
});
