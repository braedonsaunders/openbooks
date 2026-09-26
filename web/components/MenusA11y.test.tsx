import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
await bootJsdomEnvironment({ url: "http://localhost:4800/customers", matchMediaMatches: false });

stubModules({ navigation: { pathname: '/customers' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        // Anchor-preserving stub: keeps href/role/handlers so menu semantics
        // stay observable (the bare-children stub would swallow the roles).
        url: "data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement('a',rest,children)}",
      };
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

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { FilterChips } = await import("./filter-bar");
const { ViewsMenu } = await import("./views-menu");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function provider(children: React.ReactElement) {
  /* eslint-disable react/no-children-prop */
  return React.createElement(NextIntlClientProvider, {
    locale: "en",
    messages,
    timeZone: "UTC",
    children,
  });
  /* eslint-enable react/no-children-prop */
}

function openTrigger(predicate: (b: HTMLButtonElement) => boolean): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(predicate);
  assert.ok(found, "expected the menu trigger button to render");
  (found as HTMLButtonElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return found as HTMLButtonElement;
}

test("list-filter menu exposes menu/menuitem roles", async () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      provider(
        React.createElement(FilterChips, {
          basePath: "/customers",
          currentParams: {},
          paramKey: "status",
          label: "Status",
          options: [
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
          ],
        }),
      ),
    );
    await tick();
  });
  await act(async () => {
    openTrigger((b) => (b.textContent ?? "").includes("Status"));
    await tick();
    await tick();
  });

  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu, "the list-filter dropdown must carry role=menu");
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 3, "All + 2 options must be menuitems");
  const current = document.querySelector('[aria-current="true"]');
  assert.ok(current, "the active filter must expose aria-current");
  const trigger = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Status"),
  );
  assert.equal(trigger?.getAttribute("aria-haspopup"), "menu");

  // ArrowDown from the first item moves focus to the next menuitem.
  const first = items[0];
  assert.ok(first instanceof HTMLElement, "expected menuitem elements");
  await act(async () => {
    first.focus();
    first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  assert.equal(document.activeElement, items[1], "ArrowDown must move focus to the next menuitem");

  await act(async () => {
    root.unmount();
  });
});

test("view-picker menu exposes menu/menuitem roles", async () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      provider(
        React.createElement(ViewsMenu, {
          available: [
            { id: "v1", name: "V One", recordType: "customer", scope: "user", ownerId: null, isDefault: false, isActive: true },
            { id: "v2", name: "V Two", recordType: "customer", scope: "org", ownerId: null, isDefault: true, isActive: true },
          ],
          currentId: "v1",
          currentName: "V One",
          recordType: "customer",
          basePath: "/customers",
          currentParams: {},
          canManage: false,
        }),
      ),
    );
    await tick();
  });
  await act(async () => {
    openTrigger((b) => b.getAttribute("aria-haspopup") === "menu");
    await tick();
    await tick();
  });

  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu, "the view-picker dropdown must carry role=menu");
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  // 2 saved views + set-default + use-system-default + new + manage.
  assert.equal(items.length, 6, "every view row and action must be a menuitem");

  await act(async () => {
    root.unmount();
  });
});
