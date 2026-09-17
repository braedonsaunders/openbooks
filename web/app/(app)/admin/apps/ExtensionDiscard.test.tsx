import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/apps?draft=00000000-0000-4000-8000-000000000001",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
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
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
// Heavy children irrelevant to the footer discard flow render as null.
const nullWidget = "data:text/javascript,export function AppPackageEditor(){return null}export function AppOverviewHero(){return null}export function LiveDirectory(){return null}";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (
      (specifier === "./AppPackageEditor" || specifier === "./AppOverviewHero") &&
      context.parentURL?.endsWith("ExtensionReview.tsx")
    ) {
      return { shortCircuit: true, url: nullWidget };
    }
    if (specifier === "@/components/module-home/ui") {
      return { shortCircuit: true, url: nullWidget };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/admin/apps'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    return next(specifier, context);
  },
});

declare global {
  var __draftPosts: unknown[] | undefined;
}

globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  globalThis.__draftPosts!.push(init?.body);
  return new Response(JSON.stringify({ reviewUrl: "/admin/apps" }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { ConfirmRoot } = await import("../../../../lib/confirm");
const { ExtensionReview } = await import("./ExtensionReview");

const draft = {
  id: "00000000-0000-4000-8000-000000000001",
  extension_key: "probe-app",
  bundle: {
    manifest: {
      key: "probe-app",
      name: "T10 Probe App",
      version: "0.0.1",
      description: "probe",
      permissions: ["records.read"],
      frontend: { entry: "frontend/index.html" },
      endpoints: [],
    },
    files: [{ path: "frontend/index.html", content: "<p>hi</p>", isBinary: false }],
  },
  content_hash: "abc",
  base_version_id: null,
  reason: "probe",
  status: "draft",
  created_at: "2026-09-16T00:00:00.000Z",
  changes: { added: ["frontend/index.html"], changed: [], removed: [], newPackage: true },
};

async function mount() {
  globalThis.__draftPosts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // The provider's overloads only accept children inside the props object.
  /* eslint-disable react/no-children-prop */
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(ConfirmRoot, {}),
          React.createElement(ExtensionReview, { draft }),
        ),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  /* eslint-enable react/no-children-prop */
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

function discardButton(): HTMLButtonElement {
  // UrlDrawer portals to document.body, so query the whole document.
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === "Discard draft");
  assert.ok(found, "Discard draft button must render");
  return found as HTMLButtonElement;
}

// F-t10-007: Discard draft deleted a fresh (unedited) draft with one click —
// the confirm only fired when the drawer had unsaved edits. Discarding the
// draft itself must always confirm first, and must not call the API before
// the user confirms.
test("F-t10-007: Discard draft confirms before deleting", async () => {
  const { unmount } = await mount();
  try {
    await act(async () => {
      discardButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      document.body.querySelector('[role="alertdialog"], [role="dialog"]'),
      "a confirm dialog must open on Discard draft",
    );
    assert.deepEqual(globalThis.__draftPosts, [], "no delete request before confirm");
  } finally {
    await unmount();
  }
});
