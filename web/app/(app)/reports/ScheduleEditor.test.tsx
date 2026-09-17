import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __schedTestRouter: { push(url: string): void; refresh(): void } | undefined;
  var __schedTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the editor reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/reports/custom/run/schedule-test",
});
/**
 * Settle outside act (see clickDelete): a rejection escaping the handler
 * (the pre-fix bug) must never reject into act itself — an act rejection
 * leaves React's test queue unusable for later mounts in this file.
 */
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__schedTestRouter}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__schedTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__schedTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
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
const { ScheduleEditor } = await import("./ScheduleEditor");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const SCHEDULE_ID = randomUUID();

function row() {
  return {
    id: SCHEDULE_ID,
    definition_id: randomUUID(),
    cadence: "weekly",
    day_of_week: 1,
    day_of_month: null,
    hour: 7,
    minute: 0,
    timezone: "America/Toronto",
    recipient_emails: ["qa@scratch.test"],
    next_run_at: "2026-09-21T07:00:00",
    active: true,
  };
}

async function mountEditor() {
  globalThis.__schedTestRouter = { push() {}, refresh() {} };
  globalThis.__schedTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ScheduleEditor
          definitionId={randomUUID()}
          schedules={[row()]}
          canSchedule
          onChanged={() => {}}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

async function clickDelete(host: HTMLElement) {
  const button = host.querySelector('button[aria-label="Delete schedule"]') as HTMLButtonElement;
  assert.ok(button, "delete schedule button must render");
  // Dispatch inside act; settle outside it. A rejection escaping the handler
  // (the pre-fix bug) must reject into the recorder, never into act itself —
  // an act rejection leaves React's test queue unusable for later mounts.
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

test("empty schedule list renders the hint", async (t) => {
  globalThis.__schedTestRouter = { push() {}, refresh() {} };
  globalThis.__schedTestToasts = [];
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
        <ScheduleEditor definitionId={randomUUID()} schedules={[]} canSchedule onChanged={() => {}} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  assert.ok((host.textContent ?? "").length > 0, "the empty state must render text");
});

/** F-t07-006: a failed delete must name the failure even when the error body is not JSON. */
test("a non-JSON delete failure still surfaces the delete-failed toast", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>proxy boom</html>", { status: 500 })) as typeof fetch;
  const { host, root } = await mountEditor();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickDelete(host);
  await tick();
  const errors = (globalThis.__schedTestToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "a failed delete must surface exactly one error toast");
  assert.match(errors[0]!.message, /delete failed/i);
});

test("a confirmed delete calls the schedule endpoint and toasts", async (t) => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({ ok: true });
  }) as typeof fetch;
  const { host, root } = await mountEditor();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickDelete(host);
  assert.ok(
    calls.some((call) => call.startsWith("DELETE ") && call.includes(SCHEDULE_ID)),
    "confirming must send the schedule DELETE",
  );
  const successes = (globalThis.__schedTestToasts ?? []).filter((toast) => toast.kind === "success");
  assert.equal(successes.length, 1, "a confirmed delete must toast success");
  assert.match(successes[0]!.message, /deleted/i);
});
