import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";

declare global {
  var __promptCalls: unknown[] | undefined;
  var __promptVerdict: string | null | undefined;
}

// One confirmation posts one draft and never submits; retries reuse one key,
// refusals carry message plus remedy, and every gap drills to its evidence.

const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/resourcing", matchMediaMatches: false });

stubModules({ navigation: false, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){const {children,...rest}=p; return globalThis.React.createElement('a',rest,children)}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(opts){(globalThis.__promptCalls??=[]).push(opts);return globalThis.__promptVerdict ?? null}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { BusySeasonSection, type BusySeasonLabels } = await import("./BusySeasonSection.tsx");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const labels: BusySeasonLabels = {
  empty: "No department exceeds capacity in the seasonal spans.",
  weekOf: "week of",
  gap: "Gap",
  demand: "Demand",
  capacity: "Capacity",
  plan: "Plan",
  evidence: "Evidence",
  staff: "Staff",
  assignments: "Assignments",
  opportunities: "Opportunities",
  absences: "Absences",
  holidays: "Holidays",
  requestAction: "New draft request",
  noProjects: "No active project in scope: create or activate one to request staff.",
  confirmTitle: "Request staff for {department}, {week}",
  projectLabel: "Project",
  confirm: "Create draft",
  created: "Draft request created:",
  requestFailed: "The draft request could not be created.",
  reason: "Busy-season gap in {department} for {week}: {gap} h over capacity.",
};

const gap = {
  departmentId: "dept-tax",
  departmentName: "Tax",
  weekStart: "2026-01-04",
  demandHours: "18.0000",
  planHardHours: "70.0000",
  planSoftHours: "0.0000",
  planHours: "70.0000",
  capacityHours: "80.0000",
  gapHours: "8.0000",
  suggestedJobTitle: "Senior Tax Associate",
  evidence: {
    demandLineIds: ["line-manual", "line-pipeline"],
    opportunityIds: ["opp-open"],
    assignmentIds: ["assign-named", "assign-generic"],
    capacityPersonIds: ["alice", "bob"],
    absenceRowIds: ["absence-1"],
    holidayDates: ["2026-01-01"],
  },
};

const projects = [{ id: "project-alpha", name: "Alpha engagement" }];

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
}

function hrefs(): string[] {
  return [...document.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("busy-season gap action confirms once, retries idempotently, and drills to evidence", async (t) => {
  const mounts: { host: HTMLElement; root: ReturnType<typeof createRoot> }[] = [];
  async function closeAll() {
    for (const mounted of mounts.splice(0)) {
      await act(async () => {
        mounted.root.unmount();
      });
      mounted.host.remove();
    }
  }
  t.after(closeAll);
  async function mount(projectsForRow: { id: string; name: string }[]) {
    await closeAll();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounts.push({ host, root });
    await act(async () => {
      root.render(
        <BusySeasonSection gaps={[gap]} projects={projectsForRow} labels={labels} canCreateDraft />,
      );
      await tick();
    });
    return host;
  }
  const keyOf = (call: { init?: RequestInit }) =>
    new Headers(call.init?.headers).get("Idempotency-Key");

  globalThis.__promptCalls = [];
  globalThis.__promptVerdict = null;
  const cancelled = scriptFetch(() => null);
  await mount(projects);
  const cancelButton = buttonNamed(labels.requestAction);
  assert.ok(cancelButton, "the gap row offers the draft action");
  await click(cancelButton);
  assert.equal(globalThis.__promptCalls?.length, 1);
  assert.equal(cancelled.calls.length, 0);
  cancelled.restore();

  globalThis.__promptCalls = [];
  globalThis.__promptVerdict = "project-alpha";
  const created = scriptFetch((url, init) => {
    assert.equal(url, "/api/resourcing/requests");
    assert.equal(init?.method, "POST");
    assert.ok(keyOf({ url, init }), "the draft create carries an idempotency key");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      projectId: "project-alpha",
      jobTitle: "Senior Tax Associate",
      firstWeek: "2026-01-04",
      lastWeek: "2026-01-04",
      hoursPerWeek: "8.0000",
      reason: "Busy-season gap in Tax for 2026-01-04: 8 h over capacity.",
    });
    return Response.json({ id: "request-1" });
  });
  const createdHost = await mount(projects);
  await click(buttonNamed(labels.requestAction)!);
  assert.equal(created.calls.length, 1);
  assert.ok(created.calls.every((call) => call.url === "/api/resourcing/requests"), "no submit or booking endpoint is ever called");
  assert.ok(createdHost.textContent?.includes("request-1"), "the created draft id is shown");
  const shown = hrefs();
  for (const id of ["line-manual", "line-pipeline"]) {
    assert.ok(shown.some((href) => href.includes(`/resourcing/demand?demand=${id}`)), `demand line ${id} drills to its drawer`);
  }
  assert.ok(shown.some((href) => href.includes(`/crm/opportunities?opportunity=opp-open`)), "the weighting opportunity drills to the CRM");
  for (const id of ["assign-named", "assign-generic"]) {
    assert.ok(shown.some((href) => href.includes(`/resourcing/assignments?assignment=${id}`)), `assignment ${id} drills to its drawer`);
  }
  for (const id of ["alice", "bob"]) {
    assert.ok(shown.some((href) => href.includes(`/entities/employees?party=${id}`)), `staff ${id} drills to their drawer`);
  }
  assert.ok(shown.includes("/hrm/leave"), "absence evidence links the leave queue");
  assert.ok(shown.includes("/admin/setup/payroll?tab=holidays"), "holiday evidence links the holiday setup");
  created.restore();

  globalThis.__promptVerdict = "project-alpha";
  let attempts = 0;
  const retrying = scriptFetch(() => {
    attempts += 1;
    return attempts < 3
      ? Response.json({ message: "project is outside your subsidiaries", remedy: "choose a project in your subsidiaries" }, { status: 422 })
      : Response.json({ id: "request-2" });
  });
  await mount(projects);
  const retryButton = buttonNamed(labels.requestAction)!;
  await click(retryButton);
  await click(retryButton);
  await click(retryButton);
  assert.equal(retrying.calls.length, 3);
  const keys = retrying.calls.map(keyOf);
  assert.ok(keys[0], "the first attempt carries a key");
  assert.equal(keys[0], keys[1], "the retry reuses the row key");
  assert.equal(keys[1], keys[2], "the success reuses the row key");
  const refusedText = document.body.textContent ?? "";
  assert.ok(refusedText.includes("request-2"), "the retried draft is shown once created");
  retrying.restore();

  globalThis.__promptVerdict = "project-alpha";
  const refused = scriptFetch(() => Response.json(
    { message: "project is outside your subsidiaries", remedy: "choose a project in your subsidiaries" },
    { status: 422 },
  ));
  await mount(projects);
  await click(buttonNamed(labels.requestAction)!);
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("project is outside your subsidiaries"), "the refusal message is delivered");
  assert.ok(text.includes("choose a project in your subsidiaries"), "the real remedy is delivered");
  refused.restore();

  await mount([]);
  assert.equal(buttonNamed(labels.requestAction), undefined, "no dead control without a project");
  assert.ok(document.body.textContent?.includes(labels.noProjects), "the project remedy is shown");
});
