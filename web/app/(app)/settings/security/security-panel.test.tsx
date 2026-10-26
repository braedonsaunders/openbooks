import assert from "node:assert/strict";
import test from "node:test";
import {
  bootJsdomEnvironment,
  clickJsdomElement,
  setJsdomInput,
} from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

await bootJsdomEnvironment({
  url: "http://localhost:4800/settings/security",
  matchMediaMatches: false,
});
stubModules({
  navigation: true,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/viewer-format":
      "export function useViewerFormat(){return {dateTime(value){return value.toISOString()}}}",
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
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SecurityPanel />
      </NextIntlClientProvider>,
    );
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
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = await mountPanel(t);

  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? "",
    /MFA status is temporarily unavailable/,
  );
  assert.doesNotMatch(host.textContent ?? "", /Require a time-based code/);
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Retry",
  );
  assert.ok(retry);

  await act(async () => {
    clickJsdomElement(retry);
    await tick();
  });

  assert.match(
    host.textContent ?? "",
    /Require a time-based code after password or SSO authentication/,
  );
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.equal(mfaAttempts, 2);
});

test("security actions preserve the server's actionable refusal", async (t) => {
  const originalFetch = globalThis.fetch;
  const refusal =
    "MFA setup is already pending in another session; finish it there or wait for it to expire.";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/mfa" && init?.method === "POST")
      return response(409, { error: refusal });
    if (url === "/api/auth/mfa")
      return response(200, { enabled: false, recoveryCodesRemaining: 0 });
    if (url === "/api/auth/sessions") return response(200, { sessions: [] });
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = await mountPanel(t);

  const password = host.querySelector<HTMLInputElement>("#setup-password");
  assert.ok(password);
  await act(async () => {
    setJsdomInput(password, "current password");
    await tick();
  });
  const setup = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Set up authenticator",
  );
  assert.ok(setup);
  await act(async () => {
    clickJsdomElement(setup);
    await tick();
  });

  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? "",
    /already pending in another session/,
  );
  assert.doesNotMatch(host.textContent ?? "", /security request could not be completed/);
});

const passwordSession = {
  id: "11111111-1111-4111-8111-111111111111",
  authMethod: "password",
  createdAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-31T00:00:00.000Z",
  current: true,
};

async function fillPasswordForm(
  host: HTMLElement,
  values: { current: string; next: string; confirm: string },
) {
  await act(async () => {
    setJsdomInput(
      host.querySelector<HTMLInputElement>("#change-current-password")!,
      values.current,
    );
    setJsdomInput(host.querySelector<HTMLInputElement>("#change-new-password")!, values.next);
    setJsdomInput(
      host.querySelector<HTMLInputElement>("#change-confirm-password")!,
      values.confirm,
    );
    await tick();
  });
  const submit = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Update password",
  );
  assert.ok(submit);
  await act(async () => {
    clickJsdomElement(submit);
    await tick();
  });
}

test("change password is offered only to a password-authenticated session", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "/api/auth/mfa")
      return response(200, { enabled: false, recoveryCodesRemaining: 0 });
    if (url === "/api/auth/sessions")
      return response(200, { sessions: [{ ...passwordSession, authMethod: "oidc" }] });
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = await mountPanel(t);

  assert.match(host.textContent ?? "", /Active sessions/);
  assert.equal(host.querySelector("#change-current-password"), null);
});

test("change password refuses a mismatched confirmation locally and shows the server's refusal in the viewer's language", async (t) => {
  const originalFetch = globalThis.fetch;
  const submitted: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/password") {
      submitted.push(JSON.parse(String(init?.body)));
      return response(400, {
        error: "Your current password is incorrect.",
        code: "invalid_current_password",
      });
    }
    if (url === "/api/auth/mfa")
      return response(200, { enabled: false, recoveryCodesRemaining: 0 });
    if (url === "/api/auth/sessions") return response(200, { sessions: [passwordSession] });
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = await mountPanel(t);

  await fillPasswordForm(host, {
    current: "old password value",
    next: "new password value",
    confirm: "different value!",
  });
  assert.equal(submitted.length, 0);
  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? "",
    /new passwords do not match/,
  );

  await fillPasswordForm(host, {
    current: "wrong password value",
    next: "new password value",
    confirm: "new password value",
  });
  assert.deepEqual(submitted, [
    { currentPassword: "wrong password value", newPassword: "new password value" },
  ]);
  assert.match(
    host.querySelector('[role="alert"]')?.textContent ?? "",
    /current password is incorrect/,
  );
  assert.equal(
    host.querySelector<HTMLInputElement>("#change-new-password")?.value,
    "new password value",
  );
});

test("a too-short refusal names the server's minimum and a lockout names its retry delay", async (t) => {
  const originalFetch = globalThis.fetch;
  const refusals = [
    response(400, {
      error: "Choose a new password of at least 12 characters.",
      code: "weak_password",
      minLength: 12,
    }),
    response(429, { error: "Too many attempts. Try again later.", retryAfter: 90 }),
  ];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "/api/auth/password") return refusals.shift()!;
    if (url === "/api/auth/mfa")
      return response(200, { enabled: false, recoveryCodesRemaining: 0 });
    if (url === "/api/auth/sessions") return response(200, { sessions: [passwordSession] });
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = await mountPanel(t);

  await fillPasswordForm(host, { current: "current value", next: "short", confirm: "short" });
  assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /at least 12 characters/);
  await fillPasswordForm(host, {
    current: "current value",
    next: "long enough value",
    confirm: "long enough value",
  });
  assert.equal(
    host.querySelector('[role="alert"]')?.textContent,
    messages.login.tooManyAttempts.replace("{seconds}", "90"),
  );
});

test("a successful change clears the form, confirms it, and reloads the session list", async (t) => {
  const originalFetch = globalThis.fetch;
  let sessionLoads = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "/api/auth/password") return response(200, { ok: true, otherSessionsSignedOut: 2 });
    if (url === "/api/auth/mfa")
      return response(200, { enabled: false, recoveryCodesRemaining: 0 });
    if (url === "/api/auth/sessions") {
      sessionLoads += 1;
      return response(200, { sessions: [passwordSession] });
    }
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const host = await mountPanel(t);

  await fillPasswordForm(host, {
    current: "current value",
    next: "replacement value",
    confirm: "replacement value",
  });
  assert.match(
    host.querySelector('[role="status"]')?.textContent ?? "",
    /password has been changed/,
  );
  assert.equal(host.querySelector<HTMLInputElement>("#change-current-password")?.value, "");
  assert.equal(host.querySelector<HTMLInputElement>("#change-new-password")?.value, "");
  assert.equal(sessionLoads, 2);
});
