import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

// The save read `result.error` unguarded into `new Error`: an object error
// payload toasted "[object Object]", which names nothing the operator can
// act on. A non-string refusal must fall back to the named save failure.

await bootJsdomEnvironment({ url: "http://localhost:4800/parties?party=party-1", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}" +
      "export function usePathname(){return '/parties'}" +
      "export function useSearchParams(){return new URLSearchParams()}" +
      "export function redirect(){throw new Error('redirect')}" +
      "export function notFound(){throw new Error('not-found')}" +
      "export function permanentRedirect(){throw new Error('redirect')}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(){},error(m){(globalThis.__vendorComplianceErrors ??= []).push(String(m))},warning(){}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { VendorCompliancePanel } = await import("./VendorCompliancePanel");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

declare global {
  var __vendorComplianceErrors: string[] | undefined;
}

test("an object error payload toasts the named failure, never [object Object]", async (t) => {
  globalThis.__vendorComplianceErrors = [];
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Response(JSON.stringify({ error: { code: "LOCKED", fields: ["complianceClassId"] } }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  t.after(() => {
    (globalThis as Record<string, unknown>).fetch = realFetch;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <VendorCompliancePanel partyId="party-1" initialClassId={null} classes={[]} canManage />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const save = [...host.querySelectorAll("button")].find((el) => el.textContent === "Save");
  assert.ok(save, "the save button must render");
  await act(async () => {
    (save as HTMLButtonElement).click();
    await tick();
    await tick();
    await tick();
  });
  await tick();
  assert.deepEqual(globalThis.__vendorComplianceErrors, ["Saving the compliance class failed. (status 422)"]);
});
