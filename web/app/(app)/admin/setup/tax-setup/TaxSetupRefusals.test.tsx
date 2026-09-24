import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __taxSetupToasts: { kind: string; message: string }[] | undefined;
  var __taxSetupRouter: { push(url: string): void; refresh(): void } | undefined;
}

// TaxSetupGuide used to throw bare Error() on a !ok provision response, so
// POST /api/tax/provision's named 422 (e.g. an unknown selection) was
// dropped and the operator read a generic saveFailed. The guide now surfaces
// the server's message through readApiErrorMessage. Render-proved: the named
// refusal must reach the toast verbatim.

// jsdom first: the guide reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/tax-setup",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__taxSetupRouter}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__taxSetupToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__taxSetupToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../../../../../messages/en")).default;
const { TaxSetupGuide } = await import("./TaxSetupGuide");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const COUNTRIES = [
  {
    country: "CA",
    name: "Canada",
    countryPack: "CA_GST34",
    countryStatus: "ready",
    subs: [],
  },
] as const;

const PROVISION_REFUSAL = "unknown tax setup selection";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mount() {
  globalThis.__taxSetupToasts = [];
  globalThis.__taxSetupRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TaxSetupGuide
          countries={[...COUNTRIES] as unknown as Parameters<typeof TaxSetupGuide>[0]["countries"]}
          installedCodes={[]}
          step2={null}
          step3={null}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLButtonElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("a refused provision toasts the server refusal, not a generic failure", async () => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/tax/provision" && init?.method === "POST") {
      return Response.json({ error: PROVISION_REFUSAL }, { status: 422 });
    }
    return null;
  });
  const { unmount } = await mount();
  try {
    const countryToggle = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Canada"),
    );
    assert.ok(countryToggle, "expected a Canada toggle button");
    await click(countryToggle);
    const provision = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Set up 1 jurisdiction"),
    );
    assert.ok(provision, "expected an enabled provision button after selecting");
    await click(provision);
    const errors = (globalThis.__taxSetupToasts ?? []).filter((t) => t.kind === "error");
    assert.deepEqual(errors.map((t) => t.message), [PROVISION_REFUSAL]);
  } finally {
    await unmount();
    restoreFetch();
  }
});
