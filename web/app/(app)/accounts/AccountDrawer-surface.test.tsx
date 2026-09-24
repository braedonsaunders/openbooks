import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __acctTestRouter: { push(url: string): void; replace(url: string): void; refresh(): void } | undefined;
  var __acctTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/accounts",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__acctTestRouter}export function usePathname(){return '/accounts'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__acctTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__acctTestToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__acctTestToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const { AccountDrawer } = await import("./AccountDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function payload() {
  return {
    account: { number: "", name: "", type: "expense" },
    parentName: null,
    subsidiaryName: null,
    hasTransactions: false,
    childCount: 0,
    activeChildCount: 0,
  };
}

async function mountDrawer(
  t: import("node:test").TestContext,
  options: {
    response?: () => Response;
    createMode?: boolean;
    baseCurrency?: string;
    url?: string;
  } = {},
) {
  const calls: { method: string; body: string | undefined }[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), body: init?.body?.toString() });
    return options.response?.() ?? Response.json({ account: { id: "acct-created" } }, { status: 201 });
  }) as typeof fetch;
  window.history.replaceState(null, "", options.url ?? "/accounts");
  globalThis.__acctTestRouter = { push() {}, replace() {}, refresh() {} };
  globalThis.__acctTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AccountDrawer
          payload={payload()}
          parents={[]}
          currencies={[{ value: "USD", label: "US Dollar" }]}
          subsidiaries={[]}
          fieldDefs={[]}
          segments={[]}
          canManage
          closeHref="/accounts"
          createMode={options.createMode ?? true}
          baseCurrency={options.baseCurrency ?? "USD"}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, calls };
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set as
    | ((this: HTMLInputElement, value: string) => void)
    | undefined;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function reconcilableCheckbox(): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find((el) =>
    el.textContent?.includes("Reconcilable"),
  );
  const checkbox = label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  assert.ok(checkbox, "the reconcilable account option must render");
  return checkbox;
}

function createButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Create account"),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "create account action must render");
  return button;
}

/** F-t06-004: a duplicate account number must surface the typed server message. */
test("a duplicate account number surfaces the already-in-use message", async (t) => {
  const { calls } = await mountDrawer(t, {
    response: () => Response.json({ error: "number_in_use", field: "number" }, { status: 422 }),
  });
  // Fill name then number (DOM order), then create. The drawer portals to
  // document.body, so query the document, not the mount host.
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => (el as HTMLInputElement).type !== "checkbox",
  ) as HTMLInputElement[];
  assert.ok(inputs.length >= 2, "name and number inputs must render");
  await act(async () => {
    setInput(inputs[0]!, "T06 Duplicate Number");
    setInput(inputs[1]!, "6990");
    await tick();
  });
  await act(async () => {
    createButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
  assert.equal(calls[0]?.method, "POST", "the duplicate must reach the API");
  // A transient toast alone reads as "nothing happened" once it dismisses:
  // the failure must also persist as a form-level alert (F-t06-018 precedent).
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the duplicate must persist as a form-level alert");
  assert.match(alert.textContent ?? "", /already in use/i);
  const errors = (globalThis.__acctTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the duplicate must also surface exactly one error toast");
  // The alert clears on the next edit.
  await act(async () => {
    setInput(inputs[1]!, "6991");
    await tick();
  });
  assert.equal(document.querySelector('[role="alert"]'), null, "the alert must clear on edit");
});

test("single-currency reconcilable accounts select and submit the base currency", async (t) => {
  const { calls } = await mountDrawer(t);
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => (el as HTMLInputElement).type !== "checkbox",
  ) as HTMLInputElement[];
  assert.ok(inputs.length >= 2, "name and number inputs must render");
  await act(async () => {
    setInput(inputs[0]!, "Operating bank");
    reconcilableCheckbox().click();
    await tick();
  });

  const currency = document.querySelector('[aria-label="Currency restriction"]');
  assert.ok(currency, "reconcilable accounts can set a settlement currency with Multi-currency off");
  assert.equal(currency.textContent?.trim(), "US Dollar", "the org base currency is selected by default");
  await act(async () => {
    createButton().click();
    await tick();
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? "{}"), {
    name: "Operating bank",
    number: null,
    type: "expense",
    description: null,
    parentId: null,
    isSummary: false,
    isActive: true,
    subsidiaryId: null,
    subsidiaryIncludeChildren: true,
    reconcilable: true,
    monetary: null,
    requiredDimensions: [],
    custom: {},
    currencyRestriction: "USD",
  });
});

test("the reconcilable currency refusal remains visible in the form", async (t) => {
  const { calls } = await mountDrawer(t, {
    response: () => Response.json({ error: "reconcilable_currency_required" }, { status: 422 }),
  });
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => (el as HTMLInputElement).type !== "checkbox",
  ) as HTMLInputElement[];
  await act(async () => {
    setInput(inputs[0]!, "Operating bank");
    reconcilableCheckbox().click();
    await tick();
    createButton().click();
    await tick();
  });

  assert.equal(calls.length, 1, "the server refusal must be received");
  assert.equal(
    document.querySelector('[role="alert"]')?.textContent?.trim(),
    "Reconcilable accounts need a settlement currency — choose one before saving.",
  );
});

test("a reconcilable account refuses locally when no settlement currency is available", async (t) => {
  const { calls } = await mountDrawer(t, { baseCurrency: "" });
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => (el as HTMLInputElement).type !== "checkbox",
  ) as HTMLInputElement[];
  await act(async () => {
    setInput(inputs[0]!, "Operating bank");
    reconcilableCheckbox().click();
    await tick();
    createButton().click();
    await tick();
  });

  assert.equal(calls.length, 0, "the form must not send a request without a settlement currency");
  assert.equal(
    globalThis.__acctTestToasts?.at(-1)?.message,
    "Reconcilable accounts need a settlement currency — choose one before saving.",
  );
});

test("closing an account drawer removes its selector from the URL immediately", async (t) => {
  await mountDrawer(t, { createMode: false, url: "/accounts?account=acct-1&page=2" });
  const close = document.querySelector('button[aria-label="Close"]') as HTMLButtonElement | null;
  assert.ok(close, "the account drawer has a close action");
  await act(async () => {
    close.click();
  });
  assert.equal(`${window.location.pathname}${window.location.search}`, "/accounts");
});
