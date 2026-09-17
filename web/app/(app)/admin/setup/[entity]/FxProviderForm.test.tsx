import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

declare global {
  var __fxTestRouter: { push(url: string): void; refresh(): void } | undefined;
  var __fxTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the form reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/fx-provider",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__fxTestRouter}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__fxTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__fxTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { FxProviderForm } = await import("./FxProviderForm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const CAD_ONLY = [{ code: "CAD", name: "Canadian Dollar" }];

async function mountEmptyForm(t: TestContext) {
  globalThis.__fxTestRouter = { push() {}, refresh() {} };
  globalThis.__fxTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FxProviderForm initial={null} currencies={CAD_ONLY} recommendedCurrencies={["CAD"]} lastRun={null} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return host;
}

function testButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Test provider"));
  assert.ok(button, "test provider button must render");
  return button as HTMLButtonElement;
}

/** F-t06-020: testing with no currencies must explain itself without a 422 round-trip. */
test("test provider with no currencies warns before any network call", async (t) => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({ error: "choose at least one foreign currency" }, { status: 422 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = await mountEmptyForm(t);
  await act(async () => {
    testButton(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  assert.deepEqual(calls, [], "no save/test request may fire with no currencies configured");
  const errors = (globalThis.__fxTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the empty test must surface exactly one error");
  assert.match(errors[0]!.message, /at least one foreign currency/i);
});

test("a transport failure on test still releases the button with an error", async (t) => {
  const prior = globalThis.fetch;
  // Save succeeds; the test POST itself fails at the transport.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") throw new Error("down");
    return Response.json({ id: "cfg-1" });
  }) as typeof fetch;
  globalThis.__fxTestRouter = { push() {}, refresh() {} };
  globalThis.__fxTestToasts = [];
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  // One currency configured so the request path is reached.
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FxProviderForm
          initial={{
            provider: "bank_of_canada",
            displayName: "",
            baseCurrency: "CAD",
            currencies: ["USD"],
            schedule: "manual",
            syncHourUtc: 22,
            lookbackDays: 7,
            isEnabled: false,
            hasSecret: false,
            nextSyncAt: null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastObservationDate: null,
            lastError: null,
          }}
          currencies={[...CAD_ONLY, { code: "USD", name: "US Dollar" }]}
          recommendedCurrencies={["CAD"]}
          lastRun={null}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    testButton(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    await tick();
  });
  const errors = (globalThis.__fxTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.ok(errors.length >= 1, "a failed test must surface an error toast");
  assert.equal(
    testButton(host).disabled,
    false,
    "the test button must release after a transport failure",
  );
});
