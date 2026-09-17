import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __agentsTestRouter: { push(url: string): void; refresh(): void } | undefined;
  var __agentsTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the island reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/setup/agents",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__agentsTestRouter}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__agentsTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__agentsTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { AgentsPackActions } = await import("./AgentsPackActions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** F-t11-007: a rejected run must explain why instead of failing silently. */
test("a 409 claimed_elsewhere run explains that a scan is already running", async (t) => {
  const refreshes: string[] = [];
  globalThis.__agentsTestRouter = {
    push() {},
    refresh() {
      refreshes.push("refresh");
    },
  };
  globalThis.__agentsTestToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ status: "claimed_elsewhere", agentKey: "collections" }, { status: 409 })) as typeof fetch;
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
        <AgentsPackActions
          agentKey="collections"
          policy={{}}
          packTitle="Collections"
          enabled
          featureEnabled
          configureHref="/admin/setup/agents/collections"
          configureLabel="Configure"
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const runNow = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Run now"));
  assert.ok(runNow, "run-now button must render");
  await act(async () => {
    runNow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  const errors = (globalThis.__agentsTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the rejected run must surface exactly one error toast");
  assert.match(errors[0]!.message, /already running/i, "the 409 must explain that a scan is already running");
  assert.ok(refreshes.length >= 1, "the row must refresh to converge on the in-flight run");
});

test("a completed run still toasts its finding count", async (t) => {
  globalThis.__agentsTestRouter = { push() {}, refresh() {} };
  globalThis.__agentsTestToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ status: "completed", detected: 3, autoResolved: 0 })) as typeof fetch;
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
        <AgentsPackActions
          agentKey="collections"
          policy={{}}
          packTitle="Collections"
          enabled
          featureEnabled
          configureHref="/admin/setup/agents/collections"
          configureLabel="Configure"
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const runNow = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes("Run now"));
  assert.ok(runNow, "run-now button must render");
  await act(async () => {
    runNow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  const successes = (globalThis.__agentsTestToasts ?? []).filter((toast) => toast.kind === "success");
  assert.equal(successes.length, 1, "the completed run must toast once");
  assert.match(successes[0]!.message, /3/, "the success toast must carry the finding count");
});
