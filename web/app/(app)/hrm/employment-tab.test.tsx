import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the Employment tab on the employee drawer. These
// tests RENDER the tab with a stubbed fetch and assert on what the drawer
// shows: a refused as-of resolution renders its code and remedy, a
// benefits 403 hides the section while the record renders, and change
// requests list their status, revision binding, and approval link.
// Page-shell composition (drawer tab wiring, entity-loader gates) and the
// record API's 403/422 mapping stay covered by the parties/entity views
// and the employments route tests, not pinned here.

// jsdom first: the tab reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/entities/employees",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return { refresh(){}, push(){} }}",
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
        url: "data:text/javascript,export const toast = { success(){}, error(){} }",
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
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
// Dynamic: the tab resolves next/navigation through the stub above, so it
// must load after the hook registers.
const { EmploymentTab } = await import("./EmploymentTab");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function provider(children: React.ReactNode): React.ReactNode {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <BusinessDateProvider today="2026-09-22">{children}</BusinessDateProvider>
    </NextIntlClientProvider>
  );
}

function installFetch(handler: (url: string) => Response): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return handler(url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function recordOf(record: Record<string, unknown>): (url: string) => Response {
  return (url: string) => {
    if (url.startsWith("/api/hrm/employments/emp-1?")) return Response.json({ record });
    if (url.startsWith("/api/hrm/qualifications?")) return Response.json({ error: "denied" }, { status: 403 });
    if (url.startsWith("/api/hrm/enrollments?")) return Response.json({ enrollments: [] });
    if (url.startsWith("/api/hrm/dependents?")) return Response.json({ dependents: [] });
    if (url.startsWith("/api/hrm/feedback?")) return Response.json({ feedback: [] });
    if (url.startsWith("/api/hrm/competency-profile?")) return Response.json({ profile: [] });
    return Response.json({});
  };
}

async function mountTab(): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(provider(<EmploymentTab employmentId="emp-1" canManageHrm={false} />));
    await tick();
  });
  await tick();
  await tick();
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  };
}

function textOf(): string {
  return document.body.textContent ?? "";
}

test("a refused as-of resolution renders the code and remedy, never the record", async (t) => {
  const restoreFetch = installFetch(
    recordOf({
      asOf: null,
      asOfRefusal: {
        code: "NO_VERSION",
        message: "no version covers 2026-09-22 — file a change request with an earlier effective date",
      },
      episodes: [],
      changeRequests: [],
    }),
  );
  t.after(restoreFetch);
  const unmount = await mountTab();
  t.after(unmount);

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal renders as an alert");
  const text = alert?.textContent ?? "";
  assert.ok(text.includes("Resolve refused"), "the refusal panel carries the catalog heading");
  assert.ok(text.includes("NO_VERSION"), "the refusal panel names the refusal code");
  assert.ok(
    text.includes("no version covers 2026-09-22"),
    "the refusal panel carries the server remedy verbatim",
  );
  assert.ok(textOf().includes("No change requests yet."), "the request list still states its own empty state");
});

test("a benefits 403 hides the section while the record renders", async (t) => {
  const restoreFetch = installFetch((url: string) => {
    if (url.startsWith("/api/hrm/employments/emp-1?")) {
      return Response.json({
        record: {
          asOf: { version: { status: "active", effectiveFrom: "2026-01-01", effectiveTo: null }, assignments: [] },
          asOfRefusal: null,
          episodes: [],
          changeRequests: [],
        },
      });
    }
    if (url.startsWith("/api/hrm/enrollments?")) return Response.json({ error: "denied" }, { status: 403 });
    return recordOf({})(url);
  });
  t.after(restoreFetch);
  const unmount = await mountTab();
  t.after(unmount);

  const text = textOf();
  assert.ok(!text.includes("Benefits"), "a 403 without the benefits grant hides the section instead of failing the tab");
  assert.equal(document.querySelector('[role="alert"]'), null, "no refusal renders beside the readable record");
  assert.ok(text.includes("No change requests yet."), "the record sections render around the hidden benefits");
});

test("change requests list status, revision binding, and the approval link", async (t) => {
  const restoreFetch = installFetch(
    recordOf({
      asOf: { version: { status: "active", effectiveFrom: "2026-01-01", effectiveTo: null }, assignments: [] },
      asOfRefusal: null,
      episodes: [],
      changeRequests: [
        { id: "cr-1", status: "draft", requestRevision: 3, expectedEmploymentRevision: 2, submittedAt: null, flowRunId: null },
        {
          id: "cr-2",
          status: "pending_approval",
          requestRevision: 4,
          expectedEmploymentRevision: 4,
          submittedAt: "2026-08-21",
          flowRunId: "run-1",
        },
      ],
    }),
  );
  t.after(restoreFetch);
  const unmount = await mountTab();
  t.after(unmount);

  const text = textOf();
  assert.ok(text.includes("Draft"), "the draft status renders through the catalog label");
  assert.ok(
    text.includes("Request revision 3 against employment revision 2"),
    "rows bind the request revision to the employment revision",
  );
  assert.ok(text.includes("Draft — no approval run yet."), "drafts state their lack of a run instead of a dead link");
  assert.ok(text.includes("View in inbox"), "bound runs link to the native inbox surface");
  assert.ok(text.includes("2026-08-21"), "submitted rows show their stamp");
});
