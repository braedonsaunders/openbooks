import assert from "node:assert/strict";
import test from "node:test";

// F4-5: the switchboard's "Requires X." and "Works best with Y." reason
// lines were inline English template literals around catalog titles, so a
// non-English locale read English reasons between translated rows. Both now
// resolve through setup.features.requiresNote / recommendsNote.

// jsdom first: the workspace reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/features",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/admin/setup/features'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(){return null}",
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/fr")).default;
const { FeaturesWorkspace } = await import("./FeaturesWorkspace");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function renderWorkspace() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <FeaturesWorkspace
          features={[
            { key: "bankFeeds", category: "accounting", enabled: true, requiresAll: ["banking"] },
            { key: "banking", category: "accounting", enabled: false },
            { key: "fixedAssets", category: "accounting", enabled: true, recommends: ["multiCurrency"] },
            { key: "multiCurrency", category: "accounting", enabled: false },
          ]}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("requires and recommends reasons render translated with catalog titles", async (t) => {
  const { unmount } = await renderWorkspace();
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /Requiert Banque\./, "the missing requirement must read French with the catalog title");
  assert.match(
    text,
    /Fonctionne mieux avec Multidevise\./,
    "the missing recommendation must read French with the catalog title",
  );
  assert.ok(!/Requires /.test(text), "no English Requires template may leak into the French page");
  assert.ok(!/Works best with /.test(text), "no English Works best with template may leak into the French page");
});
