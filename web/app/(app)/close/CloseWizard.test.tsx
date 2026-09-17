import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __closeTestRouter: { push(): void; refresh(): void } | undefined;
  var __closeTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the wizard reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/close?run=abc&stage=execute",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__closeTestRouter}export function usePathname(){return '/close'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__closeTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__closeTestToasts??=[]).push({kind:'error',message:String(m)})},info(m){(globalThis.__closeTestToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
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
const { CloseWizard } = await import("./CloseWizard");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const RUN_ID = randomUUID();
const TASK_ID = randomUUID();

function props() {
  return {
    run: { id: RUN_ID, period_id: randomUUID(), book_id: randomUUID(), status: "in_progress", current_stage: "execute" },
    tasks: [
      {
        id: TASK_ID,
        key: "consolidation",
        status: "ready",
        completion_mode: "automatic",
        task_type: "system",
        gate_type: "soft",
        predicted_days: null,
        workstream: "intercompany",
      },
    ],
    exceptions: [],
    evidence: [],
    signoffs: [],
    events: [],
    locks: [],
    stage: "execute",
    canRun: true,
    canApprove: false,
    canReopen: false,
    canManageFlows: false,
    subsidiaryEnabled: true,
    multiCurrency: false,
    advancedClose: true,
  };
}

async function mountWizard() {
  globalThis.__closeTestRouter = { push() {}, refresh() {} };
  globalThis.__closeTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CloseWizard {...props()} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

async function clickRunConsolidation(host: HTMLElement) {
  const run = [...host.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Run consolidation"),
  ) as HTMLButtonElement;
  assert.ok(run, "run consolidation button must render");
  // Dispatch inside act; settle outside it so a rejection escaping the
  // handler cannot reject into act and poison later mounts.
  await act(async () => {
    run.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

/** F-t06-026: a refused consolidation must persist its reason inline on the task. */
test("a 422 consolidation refusal persists inline on the task", async (t) => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({ error: "No ownership records exist for this period" }, { status: 422 });
  }) as typeof fetch;
  const { host, root } = await mountWizard();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickRunConsolidation(host);
  await tick();
  assert.ok(calls.some((call) => call.includes("/api/consolidation")), "the run must reach the API");
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must persist inline on the task");
  assert.match(alert.textContent ?? "", /ownership records/i);
  const errors = (globalThis.__closeTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the refusal must also surface exactly one error toast");
});
