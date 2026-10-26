// The Admin → Roles drawer carries the employee self-service baseline as
// an explicit toggle: new roles open with it on, turning it off warns that
// holders lose leave, profile and bank-detail self-service, and the saved
// payload names the choice so the API default never silently decides it.
import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/admin/roles",
  matchMediaMatches: false,
});

const script = {
  refreshed: 0,
  bodies: [] as Record<string, unknown>[],
  toasts: [] as { kind: string; message: string }[],
};
Object.assign(globalThis, {
  __roleBaselineScript: script,
  __roleBaselineRouter: {
    push() {},
    replace() {},
    refresh() {
      script.refreshed++;
    },
  },
});

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__roleBaselineRouter}export function usePathname(){return '/admin/roles'}export function useSearchParams(){return new URLSearchParams()}export function redirect(url){throw new Error('REDIRECT:'+url)}export function notFound(){throw new Error('NOT_FOUND')}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(m){(globalThis.__roleBaselineScript.toasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__roleBaselineScript.toasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
    "@/lib/confirm": "export async function confirmDialog(){return true}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { NewRoleButton, EditRoleButton } = await import("./RoleEditor");

globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  if (method === "GET") {
    return { ok: true, json: async () => ({ permissions: [] }) };
  }
  script.bodies.push(JSON.parse(String(init?.body ?? "{}")));
  if (method === "PATCH") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { permissions: string[] };
    return {
      ok: true,
      json: async () => ({
        ok: true,
        role: { id: "role-1", permissions: sent.permissions, updatedAt: "t2" },
      }),
    };
  }
  return { ok: true, json: async () => ({ ok: true, id: "role-1" }) };
}) as typeof fetch;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(node: React.ReactElement): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={"en"} messages={messages} timeZone={"UTC"}>
        {node}
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    for (const child of [...document.body.children]) child.remove();
  };
}

function clickText(text: string): void {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  assert.ok(el, `a "${text}" button renders`);
  (el as HTMLButtonElement).click();
}

/** The self-service toggle checkbox, found through its visible label. */
function baselineToggle(): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find((l) =>
    l.textContent?.includes("Employee self-service"),
  );
  assert.ok(label, "the Employee self-service toggle renders");
  const input = label.querySelector('input[type="checkbox"]');
  assert.ok(input, "the toggle is a checkbox");
  return input as HTMLInputElement;
}

function permissionBox(key: string): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes(key));
  assert.ok(label, `the ${key} permission box renders`);
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

function fillName(name: string): void {
  const input = document.querySelector<HTMLInputElement>("#role-name");
  assert.ok(input, "the name field renders");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, name);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("a new role opens with self-service on; switching it off warns and unticks the trio", async () => {
  const unmount = await mount(React.createElement(NewRoleButton, { subsidiaries: [] }));
  try {
    await act(async () => {
      clickText("New role");
      await tick();
    });
    assert.equal(baselineToggle().checked, true, "the baseline toggle defaults on for a new role");
    for (const key of ["hrm.self.read", "hrm.self.request", "hrm.leave.request"]) {
      assert.equal(permissionBox(key).checked, true, `${key} starts ticked`);
    }
    assert.ok(
      !document.body.textContent?.includes("cannot request leave"),
      "no warning while the baseline is on",
    );
    await act(async () => {
      baselineToggle().click();
      await tick();
    });
    assert.equal(baselineToggle().checked, false, "the toggle switches off");
    for (const key of ["hrm.self.read", "hrm.self.request", "hrm.leave.request"]) {
      assert.equal(permissionBox(key).checked, false, `${key} unticks with the toggle`);
    }
    assert.ok(
      document.body.textContent?.includes("cannot request leave"),
      "switching off warns that holders lose leave, profile and bank-detail self-service",
    );
  } finally {
    await unmount();
  }
});

test("editing a role without the baseline opens with the toggle off and its warning", async () => {
  const role = {
    id: "role-1",
    key: "crew",
    name: "Crew",
    description: null,
    isBuiltIn: false,
    permissions: ["gl.read"],
    subsidiaryRestriction: { mode: "all" as const },
    updatedAt: "t1",
  };
  const unmount = await mount(React.createElement(EditRoleButton, { role, subsidiaries: [] }));
  try {
    await act(async () => {
      clickText("Edit");
      await tick();
    });
    assert.equal(baselineToggle().checked, false, "a role without the trio opens toggled off");
    assert.ok(
      document.body.textContent?.includes("cannot request leave"),
      "the off warning shows on open",
    );
    await act(async () => {
      baselineToggle().click();
      await tick();
    });
    assert.equal(baselineToggle().checked, true, "the toggle switches on");
    for (const key of ["hrm.self.read", "hrm.self.request", "hrm.leave.request"]) {
      assert.equal(permissionBox(key).checked, true, `${key} ticks with the toggle`);
    }
    assert.ok(
      !document.body.textContent?.includes("cannot request leave"),
      "the warning clears once the baseline is on",
    );
  } finally {
    await unmount();
  }
});

test("the saved payload names the baseline choice for create and opt-out", async () => {
  script.bodies = [];
  const unmount = await mount(React.createElement(NewRoleButton, { subsidiaries: [] }));
  try {
    await act(async () => {
      clickText("New role");
      await tick();
    });
    await act(async () => {
      fillName("Hourly");
      await tick();
    });
    await act(async () => {
      clickText("Create role");
      await tick();
    });
    assert.equal(script.bodies.length, 1, "creating posts once");
    const created = script.bodies[0] as { permissions: string[]; selfServiceBaseline: boolean };
    assert.equal(created.selfServiceBaseline, true, "the default-on choice travels explicitly");
    for (const key of ["hrm.self.read", "hrm.self.request", "hrm.leave.request"]) {
      assert.ok(created.permissions.includes(key), `the created set carries ${key}`);
    }
  } finally {
    await unmount();
  }

  script.bodies = [];
  const unmountOptOut = await mount(React.createElement(NewRoleButton, { subsidiaries: [] }));
  try {
    await act(async () => {
      clickText("New role");
      await tick();
    });
    await act(async () => {
      baselineToggle().click();
      await tick();
    });
    await act(async () => {
      fillName("Kiosk");
      await tick();
    });
    await act(async () => {
      clickText("Create role");
      await tick();
    });
    assert.equal(script.bodies.length, 1, "the opt-out posts once");
    const created = script.bodies[0] as { permissions: string[]; selfServiceBaseline: boolean };
    assert.equal(created.selfServiceBaseline, false, "the opt-out travels explicitly");
    for (const key of ["hrm.self.read", "hrm.self.request", "hrm.leave.request"]) {
      assert.ok(!created.permissions.includes(key), `the opt-out set omits ${key}`);
    }
  } finally {
    await unmountOptOut();
  }
});
