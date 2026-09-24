import assert from "node:assert/strict";
import test from "node:test";

// The drawer's two sublists read the error body before checking the status:
// ActivitySublist parsed first and then discarded the named refusal for a
// generic load-failed toast; TransactionSublist preserved `body.error` but
// a non-JSON body threw a parse error first. Both must surface the server's
// named refusal, and fall back to a status-carrying message otherwise.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties?party=p1",
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
        url: "data:text/javascript,export const toast={success(){},error(m){(globalThis.__partySublistErrors ??= []).push(String(m))},warning(){}};export function Toaster(){return null}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const { ActivitySublist, TransactionSublist } = await import("./PartyDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

declare global {
  var __partySublistErrors: string[] | undefined;
}

async function mount(element: React.ReactNode): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">{element}</MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
    await tick();
  });
  await tick();
  await tick();
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  };
}

test("a refused activities load toasts the named refusal", async (t) => {
  globalThis.__partySublistErrors = [];
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Response(JSON.stringify({ error: "Activities need the CRM grant — ask an admin" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  t.after(() => {
    (globalThis as Record<string, unknown>).fetch = realFetch;
  });
  const unmount = await mount(<ActivitySublist partyId="p1" canManage={false} />);
  t.after(unmount);
  assert.deepEqual(globalThis.__partySublistErrors, ["Activities need the CRM grant — ask an admin"]);
});

test("a non-JSON transactions error toasts the fallback with the status", async (t) => {
  globalThis.__partySublistErrors = [];
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () => new Response("<html>proxy error</html>", { status: 502 });
  t.after(() => {
    (globalThis as Record<string, unknown>).fetch = realFetch;
  });
  const unmount = await mount(<TransactionSublist partyId="p1" role="customer" />);
  t.after(unmount);
  assert.equal(globalThis.__partySublistErrors.length, 1);
  const message = globalThis.__partySublistErrors[0]!;
  assert.ok(message.includes("(status 502)"), `the fallback must carry the status, got ${JSON.stringify(message)}`);
  assert.ok(
    !message.includes("Unexpected token") && !message.includes("JSON"),
    `a parse error must never reach the operator, got ${JSON.stringify(message)}`,
  );
});
