import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __schedTestRouter: { push(url: string): void; refresh(): void } | undefined;
  var __schedTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the editor reads browser globals at render.
/**
 * Settle outside act (see clickDelete): a rejection escaping the handler
 * (the pre-fix bug) must never reject into act itself — an act rejection
 * leaves React's test queue unusable for later mounts in this file.
 */
const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/reports/custom/run/schedule-test", matchMediaMatches: false });

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: "export function useRouter(){return globalThis.__schedTestRouter}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(m){(globalThis.__schedTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__schedTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
    "@/lib/confirm": "export async function confirmDialog(){return true}",
  },
});

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

/** : a failed delete must name the failure even when the error body is not JSON. */
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
