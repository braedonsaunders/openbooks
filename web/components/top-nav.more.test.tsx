import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({ url: "http://localhost:4800/", matchMediaMatches: false });

stubModules({
  navigation: {
    pathname: "/",
    source:
      'export function usePathname(){return "/"}export function useSearchParams(){return new URLSearchParams("")}export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){},back(){},forward(){}}}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      'export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement("a",rest,children)}',
    "@braedonsaunders/appkit-superadmin":
      "export function selectPlatformNav(path, groups){return groups}export function createPlatformNav(){return {groups:[]}}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { TopNav } = await import("./top-nav");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// A restricted role's overflow: Operations and People have no module home,
// so they render as header rows over their flyouts; the third group has no
// accessible children at all.
const groups = [
  {
    id: "sales",
    label: "Sales",
    iconKey: "grid",
    items: [{ href: "/invoices", label: "Invoices", iconKey: "grid" }],
  },
  {
    id: "operations",
    label: "Operations",
    iconKey: "grid",
    items: [{ href: "/projects", label: "Projects", iconKey: "grid" }],
  },
  {
    id: "hrm",
    label: "People",
    iconKey: "grid",
    items: [{ href: "/hrm/employees", label: "Employees", iconKey: "grid" }],
  },
  { id: "empty", label: "Empty", iconKey: "grid", items: [] },
];

async function press(target: Element) {
  const opts = { bubbles: true, cancelable: true, button: 0 };
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("pointerdown", opts as MouseEventInit));
    target.dispatchEvent(new window.MouseEvent("mousedown", opts));
    target.dispatchEvent(new window.MouseEvent("pointerup", opts as MouseEventInit));
    target.dispatchEvent(new window.MouseEvent("mouseup", opts));
    target.dispatchEvent(new window.MouseEvent("click", opts));
    await tick();
    await tick();
  });
}

function morePanel(): Element | null {
  return (
    [...document.querySelectorAll("[data-navigation-menu]")].find((menu) =>
      [...menu.querySelectorAll('[role="menuitem"]')].some((item) =>
        item.textContent?.includes("Operations"),
      ),
    ) ?? null
  );
}

test("overflow headers with children open them; headers without children never render", async (t) => {
  document.body.innerHTML = "";
  // Force every group into the overflow menu: the rail measures 400px while
  // each group measures 200px, so only the first group stays visible.
  const nativeRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    const rect = nativeRect.call(this);
    if ((this as Element).hasAttribute?.("data-top-nav-measure")) {
      return {
        ...rect,
        width: (this as Element).getAttribute("data-top-nav-measure") === "more" ? 100 : 200,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        height: 0,
        toJSON() {
          return {};
        },
      } as DOMRect;
    }
    return rect;
  };
  t.after(() => {
    window.Element.prototype.getBoundingClientRect = nativeRect;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={"en"} messages={messages} timeZone={"UTC"}>
        {React.createElement(TopNav, { groups })}
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  const nav = document.querySelector("nav");
  assert.ok(nav, "the top nav renders");
  Object.defineProperty(nav, "clientWidth", { value: 400, configurable: true });
  await act(async () => {
    window.dispatchEvent(new window.Event("resize"));
    await tick();
    await tick();
  });

  const moreTrigger = [...document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-haspopup") === "menu" &&
      (b.textContent ?? "").includes(messages.shell.topNav.more),
  );
  assert.ok(moreTrigger, "the More trigger renders when groups overflow");
  await press(moreTrigger);

  const panel = morePanel();
  assert.ok(panel, "the More menu opens");
  const headers = [...panel.querySelectorAll('[role="menuitem"]')].filter((item) =>
    ["Operations", "People"].some((label) => item.textContent?.includes(label)),
  );
  assert.equal(headers.length, 2, "Operations and People headers render with accessible children");
  assert.equal(
    [...panel.querySelectorAll('[role="menuitem"]')].some((item) =>
      item.textContent?.includes("Empty"),
    ),
    false,
    "a group header with no accessible children must not render",
  );

  const operations = headers.find((item) =>
    item.textContent?.includes("Operations"),
  ) as HTMLElement;
  await press(operations);
  const flyout = operations.closest("div.relative")?.querySelector('a[href="/projects"]');
  assert.ok(flyout, "clicking the Operations header opens its children");
  await press(operations);
  assert.ok(
    operations.closest("div.relative")?.querySelector('a[href="/projects"]'),
    "a repeat press keeps the open header open instead of toggling it shut",
  );
});
