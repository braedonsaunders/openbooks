import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/budgets?budget=abc",
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

declare global {
  var __budgetTestRouter: { push(): void; refresh(): void } | undefined;
  var __budgetTestToasts: { kind: string; message: string }[] | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__budgetTestRouter}export function usePathname(){return '/budgets'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__budgetTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__budgetTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const messages = (await import("../../../messages/en")).default;
const { BudgetDrawer } = await import("./BudgetDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const SCENARIO_ID = randomUUID();

function workspace() {
  return {
    scenario: {
      id: SCENARIO_ID,
      name: "Empty submit probe",
      description: null,
      fiscalYear: 2026,
      kind: "budget",
      status: "draft",
      revision: 1,
      bookId: randomUUID(),
      bookName: "Primary",
      bookCode: "PRI",
      submittedAt: null,
      approvedAt: null,
      updatedAt: new Date().toISOString(),
    },
    periods: [],
    accounts: [],
    lines: [],
    totalAccounts: 0,
    page: 1,
    perPage: 50,
    sliceTotal: "0.0000",
    dimensions: { departments: [], projects: [], locations: [], classes: [] },
  };
}

async function mountDrawer(overrides?: { status?: string; canApprove?: boolean }) {
  globalThis.__budgetTestRouter = { push() {}, refresh() {} };
  globalThis.__budgetTestToasts = [];
  (window as unknown as Record<string, unknown>).confirm = () => true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const initial = workspace() as never as { scenario: { status: string } };
  if (overrides?.status) initial.scenario.status = overrides.status;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <BudgetDrawer
            initial={initial as never}
            currentParams={{}}
            dims={{ departmentId: null, projectId: null, locationId: null, classId: null }}
            closeHref="/budgets"
            books={[]}
            years={[2026]}
            sources={[]}
            newlyCreated={false}
            canManage
            canApprove={overrides?.canApprove ?? false}
            canExport={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

/** F-t13-006: a refused submit must pin its typed reason on the record, not
 * vanish behind a transient toast. */
test("a line-less submit pins the typed refusal on the drawer", async (t) => {
  const priorFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    return Response.json({ error: "budget_requires_lines" }, { status: 422 });
  }) as typeof fetch;
  const { host, root } = await mountDrawer();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  // UrlDrawer portals to document.body, so query the document, not the host.
  const submit = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Submit for approval"),
  ) as HTMLButtonElement;
  assert.ok(submit, "draft drawer must offer Submit for approval");
  await act(async () => {
    submit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.includes(`/api/budgets/${SCENARIO_ID}/actions`)),
    "submit must reach the actions API",
  );
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the typed refusal must persist inline on the drawer");
  assert.match(
    alert.textContent ?? "",
    /at least one non-zero budget line/i,
    "the pinned refusal must explain the missing-lines reason",
  );
});

/** F-coord-003: a refused self-approval must pin its typed reason on the
 * record, not vanish behind a transient toast. */
test("a refused self-approval pins the typed refusal on the drawer", async (t) => {
  const priorFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    if (String(input).includes("/actions")) {
      return Response.json({ error: "self_approval_forbidden" }, { status: 409 });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const { host, root } = await mountDrawer({ status: "pending_approval", canApprove: true });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = priorFetch;
  });
  const approve = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Approve"),
  ) as HTMLButtonElement;
  assert.ok(approve, "pending drawer must offer Approve to an approver");
  await act(async () => {
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.includes(`/api/budgets/${SCENARIO_ID}/actions`)),
    "approve must reach the actions API",
  );
  // The read-only drawer also renders a static "locked" info banner with
  // role=alert, so select the pin by its content, not by first match.
  const alert = [...document.querySelectorAll('[role="alert"]')].find((el) =>
    /cannot approve a budget you submitted/i.test(el.textContent ?? ""),
  );
  assert.ok(alert, "the typed refusal must persist inline on the drawer");
});
