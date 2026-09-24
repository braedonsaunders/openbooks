import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/dashboard",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { top: 8, left: 8, bottom: 40, right: 128, width: 120, height: 32, x: 8, y: 8, toJSON() { return {}; } };
};
if (typeof globals.ResizeObserver !== "function") {
  globals.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){}}}export function usePathname(){return '/dashboard'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement('a',rest,children)}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/sandbox-session") || specifier.endsWith("/lib/sandbox-session.ts")) {
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
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const shell = (await import("../messages/en/shell.json", { with: { type: "json" } })).default;
const shellFr = (await import("../messages/fr/shell.json", { with: { type: "json" } })).default;
const { AccountMenu } = await import("./account-menu");

const environments = {
  currentOrgId: "org-1",
  envKind: "production" as const,
  currentName: "Acme",
  homeOrgId: "org-1",
  canManage: true,
  isSuperAdmin: true,
  tenants: [{ productionOrgId: "org-1", productionOrgName: "Acme", envKind: "production" as const, sandboxes: [] }],
};

function mount(locale = "en", messages = shell) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    async render(isSuperAdmin = true) {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale={locale} messages={{ shell: messages }} timeZone="UTC">
            <AccountMenu
              name="Ada Admin"
              email="ada@example.test"
              roles={[{ key: "admin", name: "Admin" }]}
              localePreference={null}
              navModePreference={null}
              environments={{ ...environments, isSuperAdmin }}
            />
          </NextIntlClientProvider>,
        );
        await tick();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("platform workspace switcher lives in the account menu, not the header", async (t) => {
  // A super-admin's header must offer no platform entry of its own; the
  // Platform card inside the account menu is the single switcher. Proved
  // through the real AppShell, not shell source text.
  const { AppShell } = await import("./app-shell");
  const { NavigationProvider } = await import("./navigation-provider");
  const { MoneyProvider } = await import("./money-provider");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ shell }} timeZone="UTC">
        <MoneyProvider currency="USD">
        <NavigationProvider>
        <AppShell
          account={{
            name: "Ada Admin",
            email: "ada@example.test",
            roles: [{ key: "admin", name: "Admin" }],
            localePreference: null,
            navModePreference: null,
          }}
          environments={{ ...environments, isSuperAdmin: true }}
          groups={[]}
          createPermissions={{
            accountsReceivable: false,
            accountsPayable: false,
            journal: false,
            customerPayments: false,
            vendorPayments: false,
            expenses: false,
            parties: false,
            items: false,
            projects: false,
            assets: false,
            orders: false,
          }}
          canReadParties={false}
          canManageParties={false}
          canReadActivities={false}
          canManageWages={false}
          feedback={null}
        >
          {null}
        </AppShell>
        </NavigationProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const header = document.querySelector("header");
  assert.ok(header, "the shell renders a header");
  const headerEntry = [...header.querySelectorAll("button, a")].find((control) =>
    /platform/i.test(control.textContent ?? ""),
  );
  assert.equal(headerEntry, undefined, "the header offers no platform entry of its own");
  const trigger = header.querySelector('button[aria-label="Account menu"]') as HTMLButtonElement | null;
  assert.ok(trigger, "the header keeps the account menu trigger");
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  const platformCard = [...document.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("Platform"),
  );
  assert.ok(platformCard, "the account menu hosts the platform switcher");
});

test("super-admin account menu drills into org vs platform", async (t) => {
  const ui = mount();
  t.after(() => ui.unmount());
  await ui.render(true);

  const trigger = ui.host.querySelector('button[aria-label="Account menu"]') as HTMLButtonElement | null;
  assert.ok(trigger, "account menu trigger must render");
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });

  const platformCard = [...document.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes("Platform"),
  );
  assert.ok(platformCard, "super admins get a Platform card in the account menu");
  await act(async () => {
    platformCard.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });

  const tenant = document.querySelector('a[href="/"][role="menuitemradio"]');
  const platform = document.querySelector('a[href="/platform"][role="menuitemradio"]');
  assert.ok(tenant, "organization workspace option must be listed");
  assert.ok(platform, "platform console option must be listed");
  assert.equal(tenant.getAttribute("aria-checked"), "true");
  assert.equal(platform.getAttribute("aria-checked"), "false");
  assert.match(tenant.textContent ?? "", /Organization workspace/);
  assert.match(platform.textContent ?? "", /Deployment-wide operator tools/);
});

test("non-operators do not see the platform switcher", async (t) => {
  const ui = mount();
  t.after(() => ui.unmount());
  await ui.render(false);

  const trigger = ui.host.querySelector('button[aria-label="Account menu"]') as HTMLButtonElement | null;
  assert.ok(trigger);
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  assert.ok(document.querySelector('[role="dialog"]'), "account menu must open");
  assert.equal(
    [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").includes("Platform")),
    false,
  );
});

test("account menu submenu back button uses the active locale", async (t) => {
  const ui = mount("fr", shellFr);
  t.after(() => ui.unmount());
  await ui.render(false);

  const trigger = ui.host.querySelector('button[aria-label="Menu du compte"]') as HTMLButtonElement | null;
  assert.ok(trigger);
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  const language = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Langue"));
  assert.ok(language, "the translated language submenu is available");
  await act(async () => {
    language.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });

  assert.ok(document.querySelector('button[aria-label="Retour"]'), "back control has a French accessible name");
});
