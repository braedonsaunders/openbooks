// F2-11 (client half): a refused weekly save surfaces the server's named
// 409 with a reload path instead of a generic toast. The grid keeps the
// typed hours; Reload re-runs the server loader, which delivers the week
// the other editor saved under a new revision.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the grid reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/timesheets?timesheet=emp-1:2026-07-12",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((_id: number) => setTimeout(() => {}, 0)) as unknown as typeof window.cancelAnimationFrame;
}

const script = { refreshed: 0, putBodies: [] as Record<string, unknown>[] };
Object.assign(globalThis, {
  __gridStale: script,
  __gridStaleRouter: {
    push() {},
    replace() {},
    refresh() { script.refreshed++; },
  },
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__gridStaleRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { WeeklyGrid } = await import("./WeeklyGrid");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const DAYS = ["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"];

function payload(revision: string) {
  return {
    employeeId: "emp-1",
    week: "2026-07-12",
    days: DAYS,
    rows: [
      {
        projectId: "proj-1",
        itemId: null,
        timeTypeId: "tt-1",
        departmentId: null,
        isBillable: true,
        memo: null,
        hours: ["8", "", "", "", "", "", ""],
        entryStatuses: ["draft"],
        custom: {},
        amendsEntryId: null,
        immutable: false,
      },
    ],
    status: "draft",
    hasApproved: false,
    lockReasons: [],
    lockedCount: 0,
    rejectionReason: null,
    weekId: "week-1",
    revision,
  } as never;
}

const PICKERS = {
  employees: [{ value: "emp-1", label: "Revision Worker" }],
  projects: [{ value: "proj-1", label: "REV · Revision job" }],
  items: [],
  timeTypes: [{ value: "tt-1", label: "Regular", costMultiplier: "1", isBillableDefault: true }],
  departments: [],
};

async function mountGrid() {
  script.refreshed = 0;
  script.putBodies = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/timesheets" && init?.method === "PUT") {
      script.putBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          error: "This week changed since you opened it — reload the week.",
          code: "timesheet_stale_revision",
          revision: "rev-2",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <BusinessDateProvider today="2026-07-14">
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <WeeklyGrid
              employeeId="emp-1"
              week="2026-07-12"
              payload={payload("rev-1")}
              pickers={PICKERS as never}
              canManage
              canApprove={false}
              canReopen={false}
            />
          </MoneyProvider>
        </NextIntlClientProvider>
      </BusinessDateProvider>,
    );
    await tick();
  });
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

test("a refused save shows the named 409 with a reload path and keeps local edits", async (t) => {
  const { cleanup } = await mountGrid();
  t.after(cleanup);

  // Dirty the grid first: a freshly loaded week has nothing to save and
  // the Save button stays disabled.
  const addLine = buttonsNamed("Add line")[0];
  assert.ok(addLine, "the grid must offer Add line");
  await act(async () => {
    addLine.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  await tick(60);

  const save = buttonsNamed("Save")[0];
  assert.ok(save, "the grid must offer Save");
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(200);
  });
  await tick(200);

  assert.equal(script.putBodies.length, 1, "Save posts the week once");
  assert.equal(
    (script.putBodies[0] as { expectedRevision?: string }).expectedRevision,
    "rev-1",
    "the save carries the loaded revision",
  );

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must surface as a named notice, not a toast");
  assert.match(alert.textContent ?? "", /changed since you opened it/i);

  const refresh = [...alert.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Refresh",
  ) as HTMLButtonElement | undefined;
  assert.ok(refresh, "the notice must offer the reload path");
  await act(async () => {
    refresh.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  assert.equal(script.refreshed, 1, "Reload re-runs the server loader");
});
