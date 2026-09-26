import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/agents?from=continuous-close", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MovedNotice } = await import("./MovedNotice");

const PROPS = {
  title: "Continuous close moved here",
  description: "The continuous-close home now lives in the Agent Workbench.",
  dismissLabel: "Dismiss",
};

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MovedNotice, PROPS));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

// the redirect landing must explain the move on the record.
test("moved notice renders title, description and dismiss", async () => {
  const { host, unmount } = await mount();
  try {
    const notice = host.querySelector('[role="status"]');
    assert.ok(notice, "notice must render with status role");
    assert.ok(notice.textContent?.includes(PROPS.title), "title must render");
    assert.ok(notice.textContent?.includes(PROPS.description), "description must render");
    const dismiss = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === PROPS.dismissLabel,
    );
    assert.ok(dismiss, "dismiss action must render");
  } finally {
    await unmount();
  }
});

test("dismissing the notice removes it", async () => {
  const { host, unmount } = await mount();
  try {
    const dismiss = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === PROPS.dismissLabel,
    );
    assert.ok(dismiss, "dismiss action must render");
    await act(async () => {
      dismiss.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(host.querySelector('[role="status"]'), null, "notice must be gone after dismiss");
  } finally {
    await unmount();
  }
});
