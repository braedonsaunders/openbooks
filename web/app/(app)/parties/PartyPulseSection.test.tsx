import assert from "node:assert/strict";
import test from "node:test";

// The pulse loader discarded the GET's refusal and rendered a generic
// load-failed line: an operator refused for a reason (restricted scope, a
// missing grant) saw no reason. The named refusal must render like the
// sibling sections do.

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
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
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
const { PartyPulseSection } = await import("./PartyPulseSection");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a refused pulse load renders the named refusal", async (t) => {
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Response(JSON.stringify({ error: "Pulse needs the customer role — start tracking first" }), {
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
        <PartyPulseSection partyId="party-1" />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.ok(
    host.textContent?.includes("Pulse needs the customer role — start tracking first"),
    `the named refusal must render, got ${JSON.stringify(host.textContent)}`,
  );
  assert.ok(
    !host.textContent?.includes("Unable to load this account's pulse."),
    "the generic fallback must not replace a named refusal",
  );
});
