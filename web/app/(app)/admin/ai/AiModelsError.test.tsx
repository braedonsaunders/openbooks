import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/ai",
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
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/admin/ai'}export function useSearchParams(){return new URLSearchParams()}",
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
    return next(specifier, context);
  },
});

// Server answers load-models with the new structured contract: a code, never
// the raw upstream body.
globalThis.fetch = (async (url: unknown) => {
  if (String(url).endsWith("/api/admin/ai/models")) {
    return new Response(JSON.stringify({ ok: false, models: [], code: "unauthorized", status: 401 }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, models: [] }), {
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
const { AiSettingsForm } = await import("./AiSettingsForm");
type AiFormInitial = Parameters<typeof AiSettingsForm>[0]["initial"];
type ProviderSpecLite = Parameters<typeof AiSettingsForm>[0]["specs"][number];
const { classifyModelsError } = await import("../../../../lib/assistant/models-error");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const specs: ProviderSpecLite[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    baseUrl: null,
    requiresBaseUrl: false,
    fast: "claude-haiku-4-5",
    smart: "claude-sonnet-4-5",
    keyHint: "sk-ant-test-hint",
  },
];
const initial: AiFormInitial = {
  enabled: true,
  provider: "anthropic",
  modelFast: "",
  modelSmart: "",
  baseUrl: "",
  hasKey: false,
  documentCapture: {
    enabled: false,
    provider: "azure_document_intelligence",
    endpoint: "",
    model: "",
    confidenceThreshold: "",
    autoCreatePoMatchedDrafts: false,
    hasKey: false,
  },
};

test("F-t11-004: provider auth failures classify without the raw body", () => {
  const raw = new Error(
    '401 Unauthorized — {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}',
  );
  assert.deepEqual(classifyModelsError(raw), { code: "unauthorized", status: 401 });
  assert.deepEqual(classifyModelsError(new Error("fetch failed")), { code: "failed", status: null });
});

test("F-t11-004: load-models renders a human error, never the upstream blob", async () => {
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
        children: React.createElement(AiSettingsForm, { specs, initial }),
      }),
    );
    await tick();
  });
  /* eslint-enable react/no-children-prop */

  const loadButton = [...document.querySelectorAll("button")].find((b) =>
    ["Load models", "Reload models"].includes((b.textContent ?? "").trim()),
  );
  assert.ok(loadButton, "the Load models button must render");
  await act(async () => {
    loadButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });

  const bodyText = document.body.textContent ?? "";
  assert.ok(!bodyText.includes("authentication_error"), "no raw upstream JSON may render");
  assert.ok(!bodyText.includes("request_id"), "no raw upstream JSON may render");
  assert.match(bodyText, /rejected.*401/i, "the human auth-rejected message must render with the status");

  await act(async () => {
    root.unmount();
  });
});
