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
    effectiveSubsidiaryId: "00000000-0000-4000-8000-000000000001",
    dimensions: { subsidiaries: [], departments: [], projects: [], locations: [], classes: [] },
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
            dims={{ subsidiaryId: null, departmentId: null, projectId: null, locationId: null, classId: null }}
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

/* ------------------------------------------------ OM-05 unsaved-create */

const CREATE_SUB = "00000000-0000-4000-8000-000000000001";

function creatableWorkspace() {
  const base = workspace();
  return {
    ...base,
    scenario: { ...base.scenario, id: "", name: "", revision: 0 },
    periods: [
      { id: randomUUID(), name: "Jan 2026", periodNumber: 1, startsOn: "2026-01-01", endsOn: "2026-01-31" },
      { id: randomUUID(), name: "Feb 2026", periodNumber: 2, startsOn: "2026-02-01", endsOn: "2026-02-28" },
    ],
    accounts: [{ id: randomUUID(), number: "4000", name: "Services revenue", type: "income" }],
    effectiveSubsidiaryId: CREATE_SUB,
  };
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function mountCreateDrawer(options?: {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  params?: Record<string, string | string[] | undefined>;
}) {
  const priorFetch = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url: String(input), body });
    if (options?.fetch) return options.fetch(input, init);
    return Response.json({}, { status: 500 });
  }) as typeof fetch;
  const pushes: string[] = [];
  globalThis.__budgetTestRouter = {
    push() {},
    refresh() {},
  };
  const router = globalThis.__budgetTestRouter as unknown as {
    push(href: string): void;
    refresh(): void;
  };
  router.push = (href: string) => {
    pushes.push(href);
  };
  (window as unknown as Record<string, unknown>).confirm = () => true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <BudgetDrawer
            initial={creatableWorkspace() as never}
            currentParams={options?.params ?? {}}
            dims={{ subsidiaryId: null, departmentId: null, projectId: null, locationId: null, classId: null }}
            closeHref="/budgets"
            books={[]}
            years={[2026]}
            sources={[]}
            newlyCreated
            createMode
            canManage
            canApprove={false}
            canExport={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return {
    host,
    root,
    calls,
    pushes,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      globalThis.fetch = priorFetch;
    },
  };
}

/** OM-05: the total follows a typed annual figure immediately — no blur needed. */
test("typing an annual amount updates the slice total live, with zero writes", async (t) => {
  const mounted = await mountCreateDrawer();
  t.after(() => mounted.cleanup());
  assert.deepEqual(
    mounted.calls,
    [],
    "opening the unsaved drawer must issue zero requests",
  );
  assert.doesNotMatch(document.body.textContent ?? "", /1,?200/, "total starts at zero");

  const annual = document.querySelector('[aria-label="Services revenue Annual total"]') as HTMLInputElement;
  assert.ok(annual, "annual total cell must render");
  await act(async () => {
    typeInto(annual, "1200");
  });
  await tick();

  assert.equal(annual.value, "1200", "annual input stays controlled on the typed figure");
  assert.match(document.body.textContent ?? "", /1,?200/, "slice total reflects the typed amount before blur");
  assert.match(document.body.textContent ?? "", /Unsaved changes/, "mid-edit total is marked pending");
  assert.deepEqual(
    mounted.calls,
    [],
    "typing must not persist — abandoning the drawer still leaves nothing",
  );
});

/** OM-05: Save without a name pins the remedy and still writes nothing. */
test("saving a nameless budget pins the remedy instead of persisting", async (t) => {
  const mounted = await mountCreateDrawer();
  t.after(() => mounted.cleanup());
  const save = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Save budget"),
  ) as HTMLButtonElement;
  assert.ok(save, "unsaved drawer must offer an explicit Save");
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  const alert = [...document.querySelectorAll('[role="alert"]')].find((el) =>
    /name/i.test(el.textContent ?? ""),
  );
  assert.ok(alert, "the nameless-save refusal must pin its remedy on the drawer");
  assert.match(alert?.textContent ?? "", /name/i);
  assert.deepEqual(mounted.calls, [], "a refused Save must not write anything");
});

/** OM-05: the explicit Save creates the scenario plus its lines, then opens it. */
test("Save persists the named budget with its lines and opens the saved record", async (t) => {
  const scenarioId = randomUUID();
  const mounted = await mountCreateDrawer({
    params: { budgetView: "monthly" },
    fetch: async (input) => {
      if (String(input).endsWith("/api/budgets/draft")) {
        return Response.json({ id: scenarioId, revision: 1 });
      }
      if (String(input).includes(`/api/budgets/${scenarioId}/lines`)) {
        return Response.json({ revision: 2 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  t.after(() => mounted.cleanup());

  const nameInput = document.querySelector("#scenario-name") as HTMLInputElement;
  assert.ok(nameInput, "unsaved drawer must ask for a name");
  await act(async () => {
    typeInto(nameInput, "FY26 services");
  });
  const month = document.querySelector('[aria-label="Services revenue Jan 2026"]') as HTMLInputElement;
  assert.ok(month, "monthly cell must render");
  await act(async () => {
    typeInto(month, "100.00");
  });
  await tick();

  const save = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Save budget"),
  ) as HTMLButtonElement;
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();

  const draft = mounted.calls.find((call) => call.url.endsWith("/api/budgets/draft"));
  assert.ok(draft, "Save must create the scenario through the draft endpoint");
  assert.equal(draft.method, "POST");
  assert.equal((draft.body as Record<string, unknown>).name, "FY26 services");
  const lines = mounted.calls.find((call) => call.url.includes("/lines"));
  assert.ok(lines, "Save must commit the entered lines");
  const cells = (lines.body as { cells: { amount: string }[] }).cells;
  assert.equal(cells.length, 1, "only the entered non-zero cell is committed");
  // Income accounts display credit-normal: the typed 100.00 stores negative.
  assert.equal(cells[0]!.amount, "-100.0000");
  assert.equal(mounted.pushes.length, 1, "Save navigates exactly once");
  assert.match(mounted.pushes[0]!, new RegExp(`budget=${scenarioId}`), "Save opens the saved record");
  assert.doesNotMatch(mounted.pushes[0]!, /budgetNew/, "the saved record is no longer a create view");
  assert.ok(
    (globalThis.__budgetTestToasts ?? []).some((toast) => /created/i.test(toast.message)),
    "Save confirms creation",
  );
});
