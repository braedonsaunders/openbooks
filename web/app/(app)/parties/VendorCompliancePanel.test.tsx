import assert from "node:assert/strict";
import test from "node:test";

// The save read `result.error` unguarded into `new Error()`: an object error
// payload toasted "[object Object]", which names nothing the operator can
// act on. A non-string refusal must fall back to the named save failure.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties?party=party-1",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}export function usePathname(){return '/parties'}export function useSearchParams(){return new URLSearchParams()}export function redirect(){throw new Error('redirect')}export function notFound(){throw new Error('not-found')}export function permanentRedirect(){throw new Error('redirect')}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(m){(globalThis.__vendorComplianceErrors ??= []).push(String(m))},warning(){}};export function Toaster(){return null}",
      };
    }
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default {};",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
