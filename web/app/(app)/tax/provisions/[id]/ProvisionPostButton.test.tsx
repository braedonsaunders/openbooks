import assert from "node:assert/strict";
import test from "node:test";

// A refused post used to render `res.statusText` — a bare "Conflict" with no
// remedy — whenever the body was empty or unparseable. The button must render
// the server's named refusal (which already carries its remedy), and fall
// back to a named message with the status otherwise.

const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/tax/provisions/run-1",
  matchMediaMatches: false,
});

const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}export function usePathname(){return '/tax/provisions/run-1'}export function useSearchParams(){return new URLSearchParams()}export function redirect(){throw new Error('redirect')}export function notFound(){throw new Error('not-found')}export function permanentRedirect(){throw new Error('redirect')}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { ProvisionPostButton } = await import("./ProvisionPostButton");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function clickPost(fetchImpl: () => Promise<Response>): Promise<string | null> {
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = fetchImpl;
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <ProvisionPostButton runId="run-1" />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    const button = host.querySelector("button");
    assert.ok(button, "the post button must render");
    await act(async () => {
      (button as HTMLButtonElement).click();
      await tick();
      await tick();
      await tick();
    });
    await tick();
    const text = host.textContent;
    await act(async () => {
      root.unmount();
    });
    host.remove();
    return text;
  } finally {
    (globalThis as Record<string, unknown>).fetch = realFetch;
  }
}

test("a refused post renders the named refusal with its remedy", async () => {
  const text = await clickPost(
    async () =>
      new Response(
        JSON.stringify({ error: "provision run run-1 is posted", remedy: "use the current run run-2" }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
  );
  assert.ok(
    text?.includes("provision run run-1 is posted — use the current run run-2"),
    `the refusal and remedy must render, got ${JSON.stringify(text)}`,
  );
});

test("an empty conflict body renders the named fallback, never a bare Conflict", async () => {
  const text = await clickPost(async () => new Response(null, { status: 409 }));
  assert.ok(
    text?.includes("The provision could not be posted. (status 409)"),
    `the fallback must name the failure with its status, got ${JSON.stringify(text)}`,
  );
  assert.ok(!text?.includes("Conflict"), "a raw status text must never render");
});
