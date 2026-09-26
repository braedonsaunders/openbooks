import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

await bootJsdomEnvironment({ url: "http://localhost:4800/agents?item=00000000-0000-4000-8000-000000000001", matchMediaMatches: false });

stubModules({ navigation: { pathname: '/agents' }, intl: false, authz: false, features: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
// Import the shared drawer source directly (not the @openbooks/ui symlink,
// which resolves to the main checkout).
const { UrlDrawer } = await import("../../packages/ui/src/drawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("drawer banner stacks instead of squeezing at 390px", async () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  /* eslint-disable react/no-children-prop */
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(UrlDrawer, {
          open: true,
          closeHref: "/agents",
          size: "lg",
          title: "Credit-hold candidate",
          description: "Aged arrears justify requiring prepayment on new orders.",
          headerActions: React.createElement("button", { type: "button" }, "Ask about this"),
          children: React.createElement("div", null, "body"),
        }),
      }),
    );
    await tick();
    await tick();
  });
  /* eslint-enable react/no-children-prop */

  const header = document.querySelector("header");
  assert.ok(header, "the drawer banner must render");
  assert.ok(
    header.classList.contains("flex-wrap"),
    "the banner must wrap so actions drop below the text on narrow screens",
  );
  const textBlock = header.firstElementChild;
  assert.ok(textBlock instanceof HTMLElement, "the title/description block must render");
  assert.ok(
    textBlock.classList.contains("flex-1"),
    "the text block must flex so it claims full width when the actions wrap",
  );
  const actions = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Ask about this"),
  );
  assert.ok(actions, "the header action must still render");

  await act(async () => {
    root.unmount();
  });
});
