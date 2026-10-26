import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({
  html: "<!doctype html><html><body></body></html>",
  url: "http://localhost/ap/bills",
  matchMediaMatches: false,
});
stubModules({
  navigation: {
    source:
      "export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){},back(){},forward(){}}}",
  },
  intl: false,
  authz: false,
  features: false,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { UrlDrawer, DrawerNavigateContext } = await import("../../packages/ui/src/drawer");
const { ListDrawerLink } = await import("./list-drawer-link");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const ID_A = "019f0000-0000-4000-8000-00000000000a";
const ID_B = "019f0000-0000-4000-8000-00000000000b";

// The operator's draft state: clean passes the guard, dirty denies it.
const draft = { dirty: false };

function ListWithDrawer() {
  const id = new URLSearchParams(window.location.search).get("doc");
  return (
    <DrawerNavigateContext.Provider
      value={(href: string) => window.history.pushState(null, "", href)}
    >
      {React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "ul",
          null,
          React.createElement(
            "li",
            null,
            React.createElement(ListDrawerLink, { href: `/ap/bills?doc=${ID_A}` }, "Bill A"),
          ),
          React.createElement(
            "li",
            null,
            React.createElement(ListDrawerLink, { href: `/ap/bills?doc=${ID_B}` }, "Bill B"),
          ),
        ),
        <UrlDrawer
          {...{
            open: id !== null,
            openKey: id ?? undefined,
            closeHref: "/ap/bills",
            title: `Bill ${id ?? ""}`,
            beforeClose: () => !draft.dirty,
          }}
        >
          {id ? React.createElement("div", { "data-record": id }, `Record ${id}`) : null}
        </UrlDrawer>,
      )}
    </DrawerNavigateContext.Provider>
  );
}

async function renderList(t: TestContext) {
  window.history.replaceState(null, "", "/ap/bills");
  draft.dirty = false;
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = async () =>
    act(async () => {
      root.render(
        <NextIntlClientProvider locale={"en"} messages={messages} timeZone={"UTC"}>
          {React.createElement(ListWithDrawer, null)}
        </NextIntlClientProvider>,
      );
      await tick();
    });
  await render();
  return { host, render };
}

async function click(target: Element, x = 10, y = 10) {
  const opts = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("mousedown", opts));
    target.dispatchEvent(new window.MouseEvent("click", opts));
    await tick();
    await tick();
    await tick();
  });
}

function backdrop(): Element {
  const found = document.querySelector('[data-drawer-depth="0"] > [aria-hidden="true"]');
  assert.ok(found, "the drawer backdrop renders");
  return found;
}

function rowHref(id: string): Element {
  const found = [...document.querySelectorAll("a")].find((a) =>
    a.getAttribute("href")?.includes(id),
  );
  assert.ok(found, `row for ${id} renders`);
  return found;
}

test("clicking another row while a drawer is open switches the drawer to that record", async (t: TestContext) => {
  const { render } = await renderList(t);
  await click(rowHref(ID_A));
  await render();
  assert.ok(document.querySelector('[role="dialog"]'), "the first record opens");
  assert.ok(document.querySelector(`[data-record="${ID_A}"]`), "drawer shows record A");

  // The next press lands on the backdrop over row B: the drawer must not
  // eat it — it forwards to the row, which switches the drawer.
  const nativePoint = document.elementFromPoint;
  document.elementFromPoint = (() => rowHref(ID_B)) as typeof document.elementFromPoint;
  t.after(() => {
    document.elementFromPoint = nativePoint;
  });
  await click(backdrop());
  await render();
  assert.equal(
    new URLSearchParams(window.location.search).get("doc"),
    ID_B,
    "the row press behind the drawer retargets the list URL",
  );
  assert.equal(
    document.querySelectorAll('[role="dialog"]').length,
    1,
    "one drawer shell stays mounted",
  );
  assert.ok(document.querySelector(`[data-record="${ID_B}"]`), "the drawer switches to record B");
});

test("a dirty draft denies the row switch and keeps the current record", async (t: TestContext) => {
  const { render } = await renderList(t);
  await click(rowHref(ID_A));
  await render();
  assert.ok(document.querySelector(`[data-record="${ID_A}"]`), "drawer shows record A");
  draft.dirty = true;
  const nativePoint = document.elementFromPoint;
  document.elementFromPoint = (() => rowHref(ID_B)) as typeof document.elementFromPoint;
  t.after(() => {
    document.elementFromPoint = nativePoint;
  });
  await click(backdrop());
  await render();
  assert.equal(
    new URLSearchParams(window.location.search).get("doc"),
    ID_A,
    "a denied dirty-draft confirm keeps the current record",
  );
  assert.ok(document.querySelector(`[data-record="${ID_A}"]`), "the drawer still shows record A");
});

test("an empty backdrop press still dismisses the drawer", async (t: TestContext) => {
  const { render } = await renderList(t);
  await click(rowHref(ID_A));
  await render();
  assert.ok(document.querySelector('[role="dialog"]'), "drawer shows record A");
  const nativePoint = document.elementFromPoint;
  document.elementFromPoint = (() => document.body) as unknown as typeof document.elementFromPoint;
  t.after(() => {
    document.elementFromPoint = nativePoint;
  });
  await click(backdrop());
  for (let i = 0; i < 40 && document.querySelector('[role="dialog"]'); i++) {
    await act(async () => {
      await tick();
    });
  }
  await render();
  assert.equal(
    document.querySelector('[role="dialog"]'),
    null,
    "the empty backdrop press closes the drawer",
  );
  assert.equal(
    window.location.pathname + window.location.search,
    "/ap/bills",
    "close lands on the list URL",
  );
});
