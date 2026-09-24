import assert from "node:assert/strict";
import test from "node:test";

// The create button parsed the body before checking the status, so a named
// server refusal arrived as a generic toast and a non-JSON error body threw
// a SyntaxError that hid the status. Refusals must toast the server's reason;
// unparseable bodies must fall back to the caller's message with the status.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/crm/opportunities?view=list",
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
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}export function usePathname(){return '/crm/opportunities'}export function useSearchParams(){return new URLSearchParams()}export function redirect(){throw new Error('redirect')}export function notFound(){throw new Error('not-found')}export function permanentRedirect(){throw new Error('redirect')}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(m){(globalThis.__crmNewErrors ??= []).push(m)},warning(){}};export function Toaster(){return null}",
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
const { CrmNewButton } = await import("./CrmNewButton");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

declare global {
  var __crmNewErrors: string[] | undefined;
}

function errors(): string[] {
  return globalThis.__crmNewErrors ?? [];
}

async function clickCreate(fetchImpl: () => Promise<Response>) {
  globalThis.__crmNewErrors = [];
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = fetchImpl;
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <CrmNewButton apiPath="/api/crm/opportunities/draft" basePath="/crm/opportunities" param="opportunity" label="New" failed="Create failed" />,
      );
      await tick();
    });
    await tick();
    const button = host.querySelector("button");
    assert.ok(button, "the create button must render");
    await act(async () => {
      (button as HTMLButtonElement).click();
      await tick();
      await tick();
      await tick();
      await tick();
    });
    await tick();
    await tick();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  } finally {
    (globalThis as Record<string, unknown>).fetch = realFetch;
  }
}

test("a named create refusal toasts the server reason, not the generic fallback", async () => {
  await clickCreate(
    async () =>
      new Response(JSON.stringify({ error: "The period is closed — reopen it to create records" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.deepEqual(errors(), ["The period is closed — reopen it to create records"]);
});

test("a non-JSON error body toasts the fallback with the status, never a parse error", async () => {
  await clickCreate(async () => new Response("<html>proxy error</html>", { status: 502 }));
  assert.deepEqual(errors(), ["Create failed (status 502)"]);
});
