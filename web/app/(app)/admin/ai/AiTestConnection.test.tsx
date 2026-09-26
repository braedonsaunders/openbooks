import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/admin/ai", matchMediaMatches: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/admin/ai" } });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
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

type FetchCall = { url: string; init?: { body?: unknown; method?: string } };
const calls: FetchCall[] = [];
globalThis.fetch = (async (url: unknown, init?: { body?: unknown; method?: string }) => {
  calls.push({ url: String(url), init });
  if (String(url).endsWith("/api/admin/ai/test")) {
    return new Response(
      JSON.stringify({ ok: false, message: "Not configured yet — check the provider, API key, model and base URL." }),
      { headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ ok: true, models: [] }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { AiSettingsForm } = await import("./AiSettingsForm");
type AiFormInitial = Parameters<typeof AiSettingsForm>[0]["initial"];
type ProviderSpecLite = Parameters<typeof AiSettingsForm>[0]["specs"][number];

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

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("Test connection verifies the typed (unsaved) key", async () => {
  document.body.innerHTML = "";
  calls.length = 0;
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

  // Type a key WITHOUT saving, then test the connection.
  const keyInput = document.querySelector('input[placeholder="sk-ant-test-hint"]') as HTMLInputElement | null;
  assert.ok(keyInput, "the API key field must render");
  await act(async () => {
    typeInto(keyInput, "sk-test-typed-key");
    await tick();
  });
  const testButton = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Test connection",
  );
  assert.ok(testButton, "the Test connection button must render");
  await act(async () => {
    testButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });

  const testCall = calls.find((c) => String(c.url).endsWith("/api/admin/ai/test"));
  assert.ok(testCall, "Test connection must hit the test endpoint");
  const body = JSON.parse(String(testCall.init?.body ?? "{}")) as Record<string, unknown>;
  assert.equal(body.apiKey, "sk-test-typed-key", "the test request must carry the typed key, not the saved config");

  await act(async () => {
    root.unmount();
  });
});
