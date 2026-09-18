import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __adapterToasts: { kind: string; message: string }[] | undefined;
}

// The adapter fills a blank refusal message with the call-site fallback
// before the package pins and notifies: one drawer-level alert cannot carry
// a per-action fallback, so without this the pin would render whatever copy
// the alert was given — the wrong text beside any action but one. The alert
// below is deliberately given a DIFFERENT fallback to prove the pin carries
// the call-site copy.

// jsdom first.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__adapterToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__adapterToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__adapterToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const { ActionError } = await import("@braedonsaunders/appkit-errors");
const { ActionAlert } = await import("@braedonsaunders/appkit-errors/react");
const { useAppAction } = await import("./use-app-action");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mountProbe(task: () => Promise<{ ok: boolean; error?: InstanceType<typeof ActionError> }>, fallback: string) {
  globalThis.__adapterToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Runner() {
    const { refusal, execute } = useAppAction();
    return (
      <>
        <button onClick={() => void execute(task as never, { fallbackMessage: fallback })}>Go</button>
        <ActionAlert error={refusal} fallbackMessage="Alert fallback" />
      </>
    );
  }
  await act(async () => {
    root.render(<Runner />);
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

async function clickGo() {
  const go = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Go");
  assert.ok(go, "the probe must offer Go");
  await act(async () => {
    (go as HTMLButtonElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("a messageless refusal pins the call-site fallback, not the alert fallback", async (t) => {
  const { unmount } = await mountProbe(
    async () => ({ ok: false, error: new ActionError({ kind: "refused" }) }),
    "Call-site fallback",
  );
  t.after(unmount);
  await clickGo();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must pin");
  assert.match(alert.textContent ?? "", /Call-site fallback/, "the pin must carry the call-site copy");
  assert.doesNotMatch(alert.textContent ?? "", /Alert fallback/, "the alert-level copy must not leak across actions");
  const toasts = globalThis.__adapterToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Call-site fallback/.test(toast.message)),
    "pin and toast must agree",
  );
});

test("a usable server reason still wins over the fallback", async (t) => {
  const { unmount } = await mountProbe(
    async () => ({ ok: false, error: new ActionError({ kind: "refused", serverMessage: "Server says no" }) }),
    "Call-site fallback",
  );
  t.after(unmount);
  await clickGo();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must pin");
  assert.match(alert.textContent ?? "", /Server says no/, "a usable server reason is never replaced");
});
