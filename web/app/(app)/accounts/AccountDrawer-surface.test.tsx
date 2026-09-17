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

/** F-t06-004: a duplicate account number must surface the typed server message. */
test("a duplicate account number surfaces the already-in-use message", async (t) => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({ error: "number_in_use", field: "number" }, { status: 422 });
  }) as typeof fetch;
  globalThis.__acctTestRouter = { push(url: string) {}, replace(url: string) {}, refresh() {} };
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
          currencies={[]}
          subsidiaries={[]}
          fieldDefs={[]}
          segments={[]}
          canManage
          closeHref="/accounts"
          createMode
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  // Fill name then number (DOM order), then create. The drawer portals to
  // document.body, so query the document, not the mount host.
  const inputs = [...document.querySelectorAll("input")].filter(
    (el) => (el as HTMLInputElement).type !== "checkbox",
  ) as HTMLInputElement[];
  assert.ok(inputs.length >= 2, "name and number inputs must render");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set as
    | ((this: HTMLInputElement, value: string) => void)
    | undefined;
  await act(async () => {
    setter?.call(inputs[0]!, "T06 Duplicate Number");
    inputs[0]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    setter?.call(inputs[1]!, "6990");
    inputs[1]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  const create = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Create account"),
  ) as HTMLButtonElement;
  assert.ok(create, "create button must render");
  await act(async () => {
    create.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
  assert.ok(calls.some((call) => call.startsWith("POST ")), "the duplicate must reach the API");
  // A transient toast alone reads as "nothing happened" once it dismisses:
  // the failure must also persist as a form-level alert (F-t06-018 precedent).
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the duplicate must persist as a form-level alert");
  assert.match(alert.textContent ?? "", /already in use/i);
  const errors = (globalThis.__acctTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the duplicate must also surface exactly one error toast");
  // The alert clears on the next edit.
  await act(async () => {
    setter?.call(inputs[1]!, "6991");
    inputs[1]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  assert.equal(document.querySelector('[role="alert"]'), null, "the alert must clear on edit");
});
