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
    run: {
      id: RUN_ID,
      period_id: randomUUID(),
      book_id: randomUUID(),
      blueprint_id: randomUUID(),
      status: "in_progress",
      current_stage: "execute",
      target_close_date: "2026-02-28",
      scope: {},
      readiness_score: 0,
      data_fingerprint: null,
      last_validated_at: null,
      period_name: "February 2026",
      starts_on: "2026-02-01",
      ends_on: "2026-02-28",
      fiscal_year: 2026,
      book_name: "Primary",
      book_code: "PRIMARY",
      blueprint_name: "Standard",
      blueprint_version: 1,
      package_name: null,
      package_reports: null,
      starter_name: null,
      approver_name: null,
      closer_name: null,
      publisher_name: null,
      binder_hash: null,
    },
    tasks: [
      {
        id: TASK_ID,
        key: "consolidation",
        title: "Consolidation",
        description: null,
        status: "ready",
        completion_mode: "automatic",
        task_type: "system",
        gate_type: "soft",
        predicted_days: null,
        workstream: "intercompany",
        owner_name: null,
        reviewer_name: null,
        reviewer_id: null,
        due_on: null,
        evidence_required: false,
        dependencies: [],
        evidence_count: "0",
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

function reviewProps() {
  const base = props();
  return {
    ...base,
    stage: "review",
    run: { ...base.run, current_stage: "review" },
    tasks: [
      {
        id: randomUUID(),
        key: "variance-review",
        title: "close.defaultSteps.variance-review.title",
        description: "close.defaultSteps.variance-review.description",
        status: "ready",
        completion_mode: "manual",
        task_type: "approval",
        gate_type: "hard",
        workstream: "review",
        evidence_required: true,
        reviewer_id: null,
        due_on: "2026-02-05",
        owner_name: null,
        reviewer_name: null,
        dependencies: [],
        evidence_count: "0",
        predicted_days: null,
      },
      {
        id: randomUUID(),
        key: "controller-approval",
        title: "close.defaultSteps.controller-approval.title",
        description: "close.defaultSteps.controller-approval.description",
        status: "blocked",
        completion_mode: "manual",
        task_type: "approval",
        gate_type: "hard",
        workstream: "review",
        evidence_required: false,
        reviewer_id: null,
        due_on: "2026-02-06",
        owner_name: null,
        reviewer_name: null,
        dependencies: [],
        evidence_count: "0",
        predicted_days: null,
      },
    ],
  };
}

async function mountReviewStage() {
  globalThis.__closeTestRouter = { push() {}, refresh() {} };
  globalThis.__closeTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CloseWizard {...reviewProps()} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

/** F-t01-002: a Ready review task must be actionable — Start, evidence, and
 * Complete reach the engine like any manual task, or the run strands short
 * of sign-off with no path forward. */
test("a ready approval review task offers start and evidence controls", async (t) => {
  const { host, root } = await mountReviewStage();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const labels = [...host.querySelectorAll("button")].map((el) => el.textContent?.trim());
  assert.ok(labels.includes("Start"), "a Ready review task must offer Start");
  assert.ok(labels.includes("Add evidence"), "an evidence-gated review task must offer Add evidence");
});

/** A re-run that only reverses a prior elimination must not toast "posted". */
test("a reversed-only consolidation toasts the reversal, not a posting", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    ok: true,
    ratesWritten: 0,
    ownership: { runId: "run-1", entryIds: [] },
    elimination: { entryId: null, lineCount: 0, status: "reversed", reversalEntryIds: ["rev-1"] },
  })) as typeof fetch;
  const { host, root } = await mountWizard();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickRunConsolidation(host);
  const successes = (globalThis.__closeTestToasts ?? []).filter((toast) => toast.kind === "success");
  assert.equal(successes.length, 1, "the run must toast exactly once");
  assert.match(successes[0]!.message, /reversed/i, "the toast must name the reversal, not a posting");
  assert.doesNotMatch(successes[0]!.message, /posted/i);
});

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
