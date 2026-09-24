import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __taxToasts: { kind: string; message: string }[] | undefined;
  var __taxRouter: { push(url: string): void; refresh(): void } | undefined;
}

// TaxFilingsView used to throw bare Error() on a !ok compute/save response,
// so the server's named refusal (e.g. the two-registrations choose-one) was
// dropped and the operator read a generic saveFailed. Both paths now surface
// the server's message through readApiErrorMessage. Render-proved: a 422
// with a named error must reach the toast verbatim.

// jsdom first: the view reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/tax",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__taxRouter}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__taxToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__taxToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { TaxFilingsView } = await import("./TaxFilingsView");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const FORM = {
  code: "CA_GST34",
  name: "GST/HST Return",
  country: "CA",
  submission_channel: "portal_manual",
  government_format: "portal_entry",
  submission_url: null,
  notice_key: null,
  has_official: false,
};

const CHOOSE_ONE =
  'tax return "CA_GST34" has 2 registrations active in this period — choose one: 123456789 (2026-07-01 to 2026-07-31), 987654321 (2026-07-01 to 2026-07-31)';

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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function mount(canSave = true) {
  globalThis.__taxToasts = [];
  globalThis.__taxRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-07-15">
          <TaxFilingsView forms={[FORM]} canSave={canSave} canManageSetup={false} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
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

function errorToasts(): string[] {
  return (globalThis.__taxToasts ?? []).filter((t) => t.kind === "error").map((t) => t.message);
}

test("a refused compute toasts the server refusal, not a generic failure", async () => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith("/api/tax/returns/")) return Response.json({ error: CHOOSE_ONE }, { status: 422 });
    return null;
  });
  const { unmount } = await mount();
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.deepEqual(errorToasts(), [CHOOSE_ONE]);
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("without the filing grant no save action renders after a successful compute", async () => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith("/api/tax/returns/")) {
      return Response.json({
        formCode: "CA_GST34",
        formName: "GST/HST Return",
        from: "2026-07-01",
        to: "2026-07-31",
        submissionChannel: "portal_manual",
        watermark: null,
        boxes: [],
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
      });
    }
    return null;
  });
  const { unmount } = await mount(false);
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.deepEqual(buttonsNamed("Save to history"), []);
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("a refused save toasts the server refusal, not a generic failure", async () => {
  const PREPARE_REFUSAL = "the return changed since it was previewed — recompute before saving";
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith("/api/tax/returns/")) {
      return Response.json({
        formCode: "CA_GST34",
        formName: "GST/HST Return",
        from: "2026-07-01",
        to: "2026-07-31",
        submissionChannel: "portal_manual",
        watermark: null,
        boxes: [],
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
      });
    }
    if (url === "/api/tax/filings" && init?.method === "POST") {
      return Response.json({ error: PREPARE_REFUSAL }, { status: 422 });
    }
    return null;
  });
  const { unmount } = await mount();
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.deepEqual(errorToasts(), []);
    await click(buttonsNamed("Save to history")[0]!);
    assert.deepEqual(errorToasts(), [PREPARE_REFUSAL]);
  } finally {
    await unmount();
    restoreFetch();
  }
});
