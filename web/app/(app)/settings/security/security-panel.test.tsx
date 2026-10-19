import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment, clickJsdomElement, setJsdomInput } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost:4800/settings/security", matchMediaMatches: false });
stubModules({
  navigation: true,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/viewer-format": "export function useViewerFormat(){return {dateTime(value){return value.toISOString()}}}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { SecurityPanel } = await import("./security-panel");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function mountPanel(t: { after(callback: () => void | Promise<void>): void }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SecurityPanel />
    </NextIntlClientProvider>);
    await tick();
  });
  return host;
}

test("failed MFA status loads show a retry and do not claim MFA is disabled", async (t) => {
  const originalFetch = globalThis.fetch;
  let mfaAttempts = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "/api/auth/mfa") {
      mfaAttempts += 1;
      return mfaAttempts === 1
        ? response(503, { error: "MFA status is temporarily unavailable." })
        : response(200, { enabled: false, recoveryCodesRemaining: 0 });
    }
    if (url === "/api/auth/sessions") return response(200, { sessions: [] });
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const host = await mountPanel(t);

  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /MFA status is temporarily unavailable/);
  assert.doesNotMatch(host.textContent ?? "", /Require a time-based code/);
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
  assert.ok(retry);

  await act(async () => {
    clickJsdomElement(retry);
    await tick();
  });

  assert.match(host.textContent ?? "", /Require a time-based code after password or SSO authentication/);
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.equal(mfaAttempts, 2);
});

test("security actions preserve the server's actionable refusal", async (t) => {
  const originalFetch = globalThis.fetch;
  const refusal = "MFA setup is already pending in another session; finish it there or wait for it to expire.";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/mfa" && init?.method === "POST") return response(409, { error: refusal });
    if (url === "/api/auth/mfa") return response(200, { enabled: false, recoveryCodesRemaining: 0 });
    if (url === "/api/auth/sessions") return response(200, { sessions: [] });
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const host = await mountPanel(t);

  const password = host.querySelector<HTMLInputElement>("#setup-password");
  assert.ok(password);
  await act(async () => {
    setJsdomInput(password, "current password");
    await tick();
  });
  const setup = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Set up authenticator");
  assert.ok(setup);
  await act(async () => {
    clickJsdomElement(setup);
    await tick();
  });

  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /already pending in another session/);
  assert.doesNotMatch(host.textContent ?? "", /security request could not be completed/);
});
