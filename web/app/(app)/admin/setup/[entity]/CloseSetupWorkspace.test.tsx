import assert from "node:assert/strict";
import test from "node:test";
import { recordApprovalState } from "../../../../../testing/record-approval-state";
import { viewerDateTime } from "../../../../../lib/format";

declare global {
  var __setupCloseTestRouter:
    { push(url: string): void; refresh(): void; replace(url: string): void } | undefined;
  var __closeTestToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the workspace reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/admin/setup/period-close?tab=periods",
  matchMediaMatches: false,
  scrollIntoView: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__setupCloseTestRouter}export function usePathname(){return '/admin/setup/period-close'}export function useSearchParams(){return new URLSearchParams()}",
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}`,
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(m){(globalThis.__closeTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__closeTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const closeSetup = (
  await import("../../../../../messages/en/close.json", { with: { type: "json" } })
).default.setup as unknown as Record<string, Record<string, string>>;
const { CloseSetupWorkspace } = await import("./CloseSetupWorkspace");

type WorkspaceProps = Parameters<typeof CloseSetupWorkspace>[0];

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const BOOKS = [{ id: "b1", name: "Main" }];
const CALENDARS = [{ id: "cal-1", name: "Gregorian", is_default: true, is_active: true }];

function baseProps(params: Record<string, string | string[] | undefined>): WorkspaceProps {
  return {
    currentParams: params,
    fiscalYear: 2026,
    periodPage: 1,
    periodPerPage: 20,
    periodTotal: 0,
    configLists: {},
    configPerPage: 20,
    calendars: [],
    calendarOptions: CALENDARS,
    periods: [],
    books: BOOKS,
    selectedBookId: "b1",
    canReopen: true,
    viewerId: "viewer-1",
    blueprints: [],
    policies: [],
    automations: [],
    packages: [],
    users: [],
    roles: [],
    reportDefs: [],
    subsidiaries: [],
    dimensions: { departments: [], projects: [], locations: [], classes: [] },
    reopenRequests: [],
    reopenPage: 1,
    reopenTotal: 0,
    reopenPerPage: 20,
    advancedClose: false,
  } as unknown as WorkspaceProps;
}

async function mountWorkspace(props: WorkspaceProps) {
  const pushes: string[] = [];
  globalThis.__setupCloseTestRouter = {
    push(url: string) {
      pushes.push(url);
    },
    refresh() {},
    replace() {},
  };
  globalThis.__closeTestToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CloseSetupWorkspace {...props} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    pushes,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function clickButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === name,
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `expected a ${name} button`);
  return button;
}

const GENERATE = String(closeSetup.actions?.generate ?? "Generate periods");

test("period generation failure keeps the drawer open and renders the server reason", async () => {
  const reason = "FY2026 has ledger activity and its dates cannot be regenerated";
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: reason }, { status: 422 })) as typeof fetch;
  const { pushes, unmount } = await mountWorkspace(baseProps({ tab: "periods", period: "new" }));
  try {
    await act(async () => {
      clickButton(GENERATE).click();
      await tick();
      await tick();
    });
    const alert = document.querySelector('p[role="alert"]');
    assert.ok(alert, "the generate drawer must persist the failure as an alert");
    assert.equal(alert?.textContent, reason, "the alert carries the server reason verbatim");
    assert.deepEqual(pushes, [], "a failed generate must not navigate away");
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("period generation navigates away only on success", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  const { pushes, unmount } = await mountWorkspace(baseProps({ tab: "periods", period: "new" }));
  try {
    await act(async () => {
      clickButton(GENERATE).click();
      await tick();
      await tick();
    });
    assert.equal(pushes.length, 1, "exactly one post-generate navigation (the success path)");
    assert.match(pushes[0] ?? "", /fy=2026/, "success returns to the generated year");
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("period drawer surfaces pending reopen requests for its period and book", async () => {
  const props = baseProps({ tab: "periods", period: "p1" });
  const period = {
    id: "p1",
    name: "Jan 2026",
    starts_on: "2026-01-01",
    ends_on: "2026-01-31",
    entries: "0",
    fiscal_year: 2025,
    period_number: 12,
    locks: {},
    calendar_name: "Gregorian",
  };
  const mine = {
    id: "r1",
    period_id: "p1",
    book_id: "b1",
    status: "requested",
    reason: "close the gap week first",
    modules: ["gl"],
    period_name: "Jan 2026",
    book_name: "Main",
    requester_name: "Rae",
    approver_name: null,
  };
  const decided = { ...mine, id: "r2", status: "approved", reason: "already decided" };
  const otherPeriod = { ...mine, id: "r3", period_id: "p9", reason: "another period" };
  const withRows = {
    ...props,
    periods: [period],
    reopenRequests: [mine, decided, otherPeriod],
  } as unknown as WorkspaceProps;
  const { unmount } = await mountWorkspace(withRows);
  try {
    const body = document.body.textContent ?? "";
    assert.ok(body.includes(mine.reason), "the pending request for this period+book renders");
    assert.ok(!body.includes(decided.reason), "a decided request is not pending");
    assert.ok(!body.includes(otherPeriod.reason), "another period request stays out");
  } finally {
    await unmount();
  }
});

test("report package remove controls have names that identify each report", async () => {
  const list = { page: 1, total: 0 };
  const props = {
    ...baseProps({ tab: "packages", package: "new" }),
    advancedClose: true,
    configLists: { calendar: list, blueprint: list, policy: list, automation: list, package: list },
  };
  const { unmount } = await mountWorkspace(props);
  try {
    const removeControls = [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove "]'),
    ];
    assert.equal(
      removeControls.length,
      5,
      "every default attached report can be identified for removal",
    );
    assert.ok(
      removeControls.every(
        (button) => button.getAttribute("aria-label")!.length > "Remove ".length,
      ),
    );
  } finally {
    await unmount();
  }
});

function setNativeValue(element: HTMLElement, value: string) {
  const prototype =
    element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function partiallyClosedPeriod() {
  return {
    id: "p1",
    name: "Dec 2025",
    starts_on: "2025-12-01",
    ends_on: "2025-12-31",
    entries: 3,
    locks: {
      ar: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
      ap: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
      banking: { state: "open" },
      assets: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
      tax: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
      gl: { state: "open" },
    },
    calendar_name: "Gregorian",
  };
}

async function openCloseAllPanel(props: WorkspaceProps) {
  const { pushes, unmount } = await mountWorkspace(props);
  await act(async () => {
    clickButton(String(closeSetup.actions?.closeAll)).click();
    await tick();
  });
  const reasonBox = document.querySelector("textarea");
  assert.ok(reasonBox, "the close-all panel asks for one shared reason");
  return { pushes, unmount, reasonBox: reasonBox as HTMLTextAreaElement };
}

/** A close submit that cannot send must say why instead of dying silently:
 * with no book in scope the request never leaves the browser, so the
 * drawer persists the remedy inline and as a toast. */
test("close-all without a book sends nothing and names the missing scope", async () => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return Response.json({ ok: true, results: [] });
  }) as typeof fetch;
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    books: [],
    selectedBookId: "",
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount, reasonBox } = await openCloseAllPanel(props);
  try {
    await act(async () => {
      setNativeValue(reasonBox, "December re-close control");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click();
      await tick();
    });
    assert.deepEqual(calls, [], "no request may leave the browser without a book");
    assert.equal(
      document.querySelector('p[role="alert"]')?.textContent,
      closeSetup.periods?.closeUnavailable,
      "the drawer names the missing scope inline",
    );
    const errors = (globalThis.__closeTestToasts ?? []).filter((toast) => toast.kind === "error");
    assert.equal(errors.length, 1, "exactly one error toast names the missing scope");
    assert.equal(errors[0]?.message, closeSetup.periods?.closeUnavailable);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** A refused close-period keeps the panel open with the server text: the
 * operator sees which module blocked and why, not an empty alert. */
test("close-period refusal persists the server reason and keeps the panel open", async () => {
  const reason = "close BANKING before GL";
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: reason }, { status: 422 })) as typeof fetch;
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { pushes, unmount, reasonBox } = await openCloseAllPanel(props);
  try {
    await act(async () => {
      setNativeValue(reasonBox, "December re-close control");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click();
      await tick();
      await tick();
    });
    assert.equal(
      document.querySelector('p[role="alert"]')?.textContent,
      reason,
      "the refusal text renders verbatim",
    );
    assert.ok(
      [...document.querySelectorAll("button")].some(
        (b) => (b.textContent ?? "").trim() === String(closeSetup.actions?.confirmClose),
      ),
      "the panel stays open for the retry",
    );
    assert.deepEqual(pushes, [], "a refused close must not navigate away");
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** A hung close request must not wedge the drawer: the timeout surfaces a
 * visible error and releases the form for a checked retry. */
test("close-period timeout surfaces the timeout remedy and releases the form", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("The operation was aborted", "AbortError");
  }) as typeof fetch;
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount, reasonBox } = await openCloseAllPanel(props);
  try {
    await act(async () => {
      setNativeValue(reasonBox, "December re-close control");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click();
      await tick();
      await tick();
    });
    assert.equal(
      document.querySelector('p[role="alert"]')?.textContent,
      closeSetup.periods?.requestTimedOut,
      "the timeout remedy renders inline",
    );
    assert.equal(
      clickButton(String(closeSetup.actions?.confirmClose)).disabled,
      false,
      "the form releases for a checked retry",
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("a refused tenant Flow decision stays visible and releases the reopen action", async () => {
  const props = baseProps({ tab: "periods", reopen: "r1" });
  props.reopenRequests = [
    {
      id: "r1",
      period_id: "p1",
      book_id: "b1",
      status: "requested",
      reason: "correct the closing entry",
      modules: ["gl"],
      period_name: "January",
      book_name: "Main",
      requester_name: "Rae",
      approver_name: null,
    },
  ] as WorkspaceProps["reopenRequests"];
  const reason = "The approval evidence changed; reload the reopen request before deciding.";
  const calls: Array<{ url: string; body: unknown }> = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith("/api/flows/record-state"))
      return Response.json(
        recordApprovalState({ status: "requested", gateId: "g1", canDecide: true }),
      );
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ error: reason }, { status: 409 });
  }) as typeof fetch;
  const { pushes, unmount } = await mountWorkspace(props);
  try {
    await act(async () => {
      clickButton("Approve").click();
      await tick();
    });
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes(reason));
    assert.equal(clickButton("Approve").disabled, false);
    assert.deepEqual(calls, [
      { url: "/api/flows/gates/decide", body: { gateId: "g1", decision: "approved" } },
    ]);
    assert.deepEqual(pushes, []);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** A self-approved reopen quotes its stored attestation: the detail names
 * the sole-approver attestation and the exact words the approver signed,
 * read from the decision evidence rather than reconstructed. */
test("a self-approved reopen shows the approver and the quoted attestation", async () => {
  const props = baseProps({ tab: "periods", reopen: "r7" });
  props.reopenRequests = [
    {
      id: "r7",
      period_id: "p1",
      book_id: "b1",
      status: "approved",
      reason: "correct the closing entry",
      modules: ["gl"],
      period_name: "January",
      book_name: "Main",
      requested_by: "u-solo",
      requester_name: "Solo",
      approved_by: "u-solo",
      approver_name: "Solo",
      decision_action: "self_approve",
      decision_attestation: "Only administrator available; this correction is necessary",
      end_actor_name: null,
      end_reason: null,
    },
  ] as WorkspaceProps["reopenRequests"];
  const { unmount } = await mountWorkspace(props);
  try {
    const body = document.body.textContent ?? "";
    assert.ok(
      body.includes(String(closeSetup.periods?.selfApprovedNote)),
      "the self-approval names its sole-approver attestation",
    );
    assert.ok(
      body.includes("Only administrator available; this correction is necessary"),
      "the stored attestation text is quoted verbatim",
    );
  } finally {
    await unmount();
  }
});

/** An approved reopen offers an audited end action: the requester ends the
 * window with a reason instead of waiting out the expiry while overlap
 * blocks new requests. */
test("an approved reopen offers an end action that posts its reason", async () => {
  const bodies: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const props = baseProps({ tab: "periods", reopen: "r9" });
  props.reopenRequests = [
    {
      id: "r9",
      period_id: "p1",
      book_id: "b1",
      status: "approved",
      reason: "correction window",
      modules: ["gl"],
      period_name: "Nov 2025",
      book_name: "Main",
      requested_by: "requester-1",
      requester_name: "Rae",
      approved_by: "approver-1",
      approver_name: "Ari",
      decision_action: null,
      decision_attestation: null,
      end_actor_name: null,
      end_reason: null,
      expires_at: "2026-01-02T03:04:05.000Z",
    },
  ] as WorkspaceProps["reopenRequests"];
  const { unmount } = await mountWorkspace(props);
  try {
    const body = document.body.textContent ?? "";
    assert.ok(
      body.includes(viewerDateTime("2026-01-02T03:04:05.000Z", "en", "UTC")),
      "the window expiry reads in human terms",
    );
    await act(async () => {
      clickButton(String(closeSetup.actions?.endReopen)).click();
      await tick();
    });
    assert.deepEqual(bodies, [], "no end posts without a reason");
    const boxes = [...document.querySelectorAll("textarea")];
    assert.ok(boxes.length >= 1, "the end action asks for a reason");
    await act(async () => {
      setNativeValue(boxes[0]!, "Correction posted; window no longer needed");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.endReopen)).click();
      await tick();
      await tick();
    });
    assert.deepEqual(bodies, [
      {
        action: "reclose-reopen",
        requestId: "r9",
        reason: "Correction posted; window no longer needed",
      },
    ]);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** Module rows stay keyed by module in fixed order with closed modules in
 * place: closing one module must never reseat the Close buttons underneath
 * the operator's cursor. */
test("period module rows keep fixed order with closed modules in place", async () => {
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount } = await mountWorkspace(props);
  try {
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the period drawer opens");
    const grid = dialog.querySelector("div.grid.gap-2");
    assert.ok(grid, "the module rows render");
    const rows = [...grid.children].map((child) => {
      const el = child as HTMLElement;
      return {
        module: el.querySelector("span.font-medium")?.textContent?.trim() ?? "",
        state: (el.textContent ?? "").includes("Closed") ? "closed" : "open",
      };
    });
    assert.deepEqual(rows, [
      { module: "AR", state: "closed" },
      { module: "AP", state: "closed" },
      { module: "Banking", state: "open" },
      { module: "Assets", state: "closed" },
      { module: "Tax", state: "closed" },
      { module: "GL", state: "open" },
    ]);
  } finally {
    await unmount();
  }
});

function moduleRowCloseButton(module: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the period drawer opens");
  const grid = dialog.querySelector("div.grid.gap-2");
  assert.ok(grid, "the module rows render");
  const row = [...grid.children].find(
    (child) =>
      (child as HTMLElement).querySelector("span.font-medium")?.textContent?.trim() === module,
  ) as HTMLElement | undefined;
  assert.ok(row, `the ${module} row renders`);
  const close = [...row.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Close",
  );
  assert.ok(close, `the ${module} row offers Close`);
  return close as HTMLButtonElement;
}

/** The first Confirm click arms a summary naming the module and its
 * consequences instead of posting: a tap on the wrong row still cancels. */
test("closing a module arms a named confirm before anything posts", async () => {
  const bodies: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount } = await mountWorkspace(props);
  try {
    await act(async () => {
      moduleRowCloseButton("GL").click();
      await tick();
    });
    const reasonBox = document.querySelector('[role="dialog"] textarea');
    assert.ok(reasonBox, "the close panel asks for a reason");
    await act(async () => {
      setNativeValue(reasonBox as HTMLTextAreaElement, "December books reviewed and ready");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.reviewClose)).click();
      await tick();
    });
    assert.deepEqual(bodies, [], "the first confirm arms instead of posting");
    const summary = document.querySelector('div[role="alertdialog"]');
    assert.ok(summary, "an armed confirm names the module and its consequences");
    assert.ok(
      (summary.textContent ?? "").includes("Close GL for Dec 2025?"),
      "the confirm names the module and the period",
    );
    assert.ok(
      (summary.textContent ?? "").includes("New postings to GL will be rejected"),
      "the confirm states the posting consequence",
    );
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click();
      await tick();
      await tick();
    });
    assert.deepEqual(bodies, [
      {
        action: "set-lock",
        periodId: "p1",
        bookId: "b1",
        module: "gl",
        state: "closed",
        reason: "December books reviewed and ready",
      },
    ]);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** Closing Banking while reconciliations are in progress or statement lines
 * are unmatched shows those counts from the close readiness data. */
test("closing banking surfaces in-progress and unmatched counts in the confirm", async () => {
  const bodies: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    bodies.push(body);
    if (body.action === "banking-close-status") {
      return Response.json({
        ok: true,
        accounts: [
          {
            accountId: "a1",
            number: "1010",
            name: "Operating",
            status: "in_progress",
            throughDate: "2025-12-20",
            difference: "12.50",
            stale: false,
            staleSince: null,
            clearedEffect: null,
          },
          {
            accountId: "a2",
            number: "1020",
            name: "Savings",
            status: "signed_off",
            throughDate: "2025-12-31",
            difference: null,
            stale: false,
            staleSince: null,
            clearedEffect: null,
          },
        ],
        issues: [],
        unmatchedStatementLines: 3,
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount } = await mountWorkspace(props);
  try {
    await act(async () => {
      moduleRowCloseButton("Banking").click();
      await tick();
      await tick();
    });
    const reasonBox = document.querySelector('[role="dialog"] textarea');
    assert.ok(reasonBox, "the banking close panel asks for a reason");
    await act(async () => {
      setNativeValue(
        reasonBox as HTMLTextAreaElement,
        "Bank activity reviewed; proceeding with open items noted",
      );
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.reviewClose)).click();
      await tick();
    });
    const summary = document.querySelector('div[role="alertdialog"]');
    assert.ok(summary, "the banking close arms a confirm");
    assert.ok(
      (summary.textContent ?? "").includes("Close Banking for Dec 2025?"),
      "the confirm names Banking, not a shifted row",
    );
    assert.ok(
      (summary.textContent ?? "").includes(
        "Reconciliations in progress: 1. Unmatched statement lines: 3.",
      ),
      "the confirm shows the readiness counts",
    );
    assert.ok(
      bodies.some((body) => (body as { action?: string }).action === "banking-close-status"),
      "the counts come from the close readiness check",
    );
    assert.ok(
      !bodies.some((body) => (body as { action?: string }).action === "set-lock"),
      "nothing posts while the confirm is armed",
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("reopen permission does not grant a decision without an assigned Flow gate", async () => {
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") calls.push(String(input));
    return Response.json(recordApprovalState({ status: "requested", gateId: "g1" }));
  }) as typeof fetch;
  const props = baseProps({ tab: "periods", reopen: "r1" });
  props.reopenRequests = [
    {
      id: "r1",
      status: "requested",
      period_id: "p1",
      book_id: "b1",
      modules: ["gl"],
      reason: "Correction required",
      period_name: "January",
      book_name: "Main",
      requester_name: "Rae",
    },
  ] as WorkspaceProps["reopenRequests"];
  const { unmount } = await mountWorkspace(props);
  try {
    assert.ok(document.body.textContent?.includes("Assigned reviewer"));
    assert.equal(
      [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Approve"),
      false,
    );
    assert.deepEqual(calls, []);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("the requester submits a reopen through the native Flow command without an override", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith("/api/flows/record-state"))
      return Response.json(recordApprovalState({ status: "requested", neverSubmitted: true }));
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ gated: false });
  }) as typeof fetch;
  const props = baseProps({ tab: "periods", reopen: "r1" });
  props.reopenRequests = [
    {
      id: "r1",
      requested_by: "viewer-1",
      status: "requested",
      period_id: "p1",
      book_id: "b1",
      modules: ["gl"],
      reason: "Correction required",
      period_name: "January",
      book_name: "Main",
      requester_name: "Rae",
    },
  ] as WorkspaceProps["reopenRequests"];
  const { unmount } = await mountWorkspace(props);
  try {
    await act(async () => {
      clickButton(messages.common.approvalFlow.submitRun).click();
      await tick();
    });
    assert.deepEqual(calls, [{ url: "/api/close/reopens/r1/submit", body: {} }]);
    assert.equal(document.querySelector('[role="dialog"] input[type="checkbox"]'), null);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** A stale approved window on already-closed modules can be ended from the
 * period row itself: the row lists active windows with their own reason box
 * and posts the same audited end command as the request detail. */
test("the period row ends an active reopen window with its reason", async () => {
  const bodies: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const props = baseProps({ tab: "periods", period: "p1" });
  props.periods = [
    {
      id: "p1",
      name: "Dec 2025",
      is_adjustment: false,
      starts_on: "2025-12-01",
      ends_on: "2025-12-31",
      entries: "0",
      fiscal_year: 2025,
      period_number: 12,
      locks: {
        gl: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
        ap: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
        ar: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
      },
      calendar_name: "Gregorian",
    },
  ] as WorkspaceProps["periods"];
  props.reopenRequests = [
    {
      id: "r9",
      period_id: "p1",
      book_id: "b1",
      status: "approved",
      reason: "stale correction window",
      modules: ["gl", "ap", "ar"],
      period_name: "Dec 2025",
      book_name: "Main",
      requested_by: "requester-1",
      requester_name: "Rae",
      approved_by: "approver-1",
      approver_name: "Ari",
      decision_action: null,
      decision_attestation: null,
      end_actor_name: null,
      end_reason: null,
      expires_at: "2026-01-02T03:04:05.000Z",
    },
  ] as WorkspaceProps["reopenRequests"];
  const { unmount } = await mountWorkspace(props);
  try {
    const body = document.body.textContent ?? "";
    assert.ok(
      body.includes(String(closeSetup.periods?.activeReopenWindows)),
      "active windows list on the row",
    );
    assert.ok(
      body.includes(viewerDateTime("2026-01-02T03:04:05.000Z", "en", "UTC")),
      "the row window expiry reads in human terms",
    );
    await act(async () => {
      clickButton(String(closeSetup.actions?.endReopen)).click();
      await tick();
    });
    assert.deepEqual(bodies, [], "no end posts without a reason");
    const boxes = [...document.querySelectorAll("textarea")];
    assert.equal(boxes.length, 1, "the row window asks for its own reason");
    await act(async () => {
      setNativeValue(boxes[0]!, "Stale window; every module already re-closed");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.endReopen)).click();
      await tick();
      await tick();
    });
    assert.deepEqual(bodies, [
      {
        action: "reclose-reopen",
        requestId: "r9",
        reason: "Stale window; every module already re-closed",
      },
    ]);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** A refusal deep link arms the reopen form with the refused scope: the
 * period drawer opens on the period and book with the module's reopen form
 * armed and the entity carried into the request, then consumes the link. */
test("a refusal deep link arms the reopen form with period, book, entity and module", async () => {
  const bodies: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const entityId = "33333333-3333-3333-3333-333333333333";
  const props = baseProps({
    tab: "periods",
    period: "p1",
    book: "b1",
    reopenModule: "banking",
    reopenEntity: entityId,
  });
  props.periods = [
    {
      id: "p1",
      name: "Dec 2025",
      is_adjustment: false,
      starts_on: "2025-12-01",
      ends_on: "2025-12-31",
      entries: "0",
      fiscal_year: 2025,
      period_number: 12,
      locks: {
        banking: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
        gl: { state: "closed", lockedAt: null, reason: null, reopenExpiresAt: null },
      },
      calendar_name: "Gregorian",
    },
  ] as WorkspaceProps["periods"];
  props.subsidiaries = [{ id: entityId, name: "East" }] as WorkspaceProps["subsidiaries"];
  const { unmount, pushes } = await mountWorkspace(props);
  try {
    const body = document.body.textContent ?? "";
    assert.ok(
      body.includes(String(closeSetup.periods?.reopenTitle)),
      "the refused module opens its reopen form",
    );
    assert.ok(body.includes("Entity: East"), "the refused entity rides into the form");
    const box = document.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement | null;
    assert.ok(box, "the prefilled form asks for a reason without a row click");
    await act(async () => {
      setNativeValue(box!, "Refused banking posting needs a controlled window");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.requestReopen)).click();
      await tick();
      await tick();
    });
    const requests = bodies.filter(
      (entry) => (entry as { action?: string }).action === "request-reopen",
    );
    assert.deepEqual(requests, [
      {
        action: "request-reopen",
        periodId: "p1",
        bookId: "b1",
        subsidiaryId: entityId,
        modules: ["banking", "gl"],
        reason: "Refused banking posting needs a controlled window",
      },
    ]);
    assert.ok(
      pushes.some((url) => !url.includes("reopenModule") && !url.includes("reopenEntity")),
      "the posted request consumes the deep link",
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** The per-module close reason starts empty for each module: opening
 * another module's close must not prefill the previous module's text, and
 * a posted close clears its own module's draft. */
test("each module close starts with an empty reason", async () => {
  const bodies: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount } = await mountWorkspace(props);
  try {
    await act(async () => {
      moduleRowCloseButton("Banking").click();
      await tick();
    });
    const reasonBox = document.querySelector(
      '[role="dialog"] textarea',
    ) as HTMLTextAreaElement | null;
    assert.ok(reasonBox, "the banking close asks for a reason");
    await act(async () => {
      setNativeValue(reasonBox!, "Banking reconciliations reviewed and signed");
      await tick();
    });
    // Switching modules starts empty instead of prefilling banking's text.
    await act(async () => {
      moduleRowCloseButton("GL").click();
      await tick();
    });
    const glBox = document.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement | null;
    assert.ok(glBox, "the GL close asks for a reason");
    assert.equal(glBox!.value, "", "the GL box starts empty after banking");
    // Each module keeps its own draft while switching back and forth.
    await act(async () => {
      moduleRowCloseButton("Banking").click();
      await tick();
    });
    const bankingBox = document.querySelector(
      '[role="dialog"] textarea',
    ) as HTMLTextAreaElement | null;
    assert.equal(
      bankingBox!.value,
      "Banking reconciliations reviewed and signed",
      "banking keeps its own draft",
    );
    // Posting the banking close clears only banking's draft.
    await act(async () => {
      clickButton(String(closeSetup.actions?.reviewClose)).click();
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.confirmClose)).click();
      await tick();
      await tick();
    });
    const locks = bodies.filter((entry) => (entry as { action?: string }).action === "set-lock");
    assert.deepEqual(
      locks,
      [
        {
          action: "set-lock",
          periodId: "p1",
          bookId: "b1",
          module: "banking",
          state: "closed",
          reason: "Banking reconciliations reviewed and signed",
        },
      ],
      "the banking close posts once armed",
    );
    await act(async () => {
      moduleRowCloseButton("Banking").click();
      await tick();
    });
    const clearedBox = document.querySelector(
      '[role="dialog"] textarea',
    ) as HTMLTextAreaElement | null;
    assert.equal(clearedBox!.value, "", "the posted close clears its own draft");
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

/** Closing ahead of an earlier period with activity is allowed, but the
 * armed summary names the earlier periods whose module is still open. */
test("closing a module names earlier periods with activity still open", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  const earlier = {
    ...partiallyClosedPeriod(),
    id: "p0",
    name: "Nov 2025",
    starts_on: "2025-11-01",
    ends_on: "2025-11-30",
  };
  const props = {
    ...baseProps({ tab: "periods", period: "p1" }),
    periods: [earlier, partiallyClosedPeriod()],
  } as unknown as WorkspaceProps;
  const { unmount } = await mountWorkspace(props);
  try {
    await act(async () => {
      moduleRowCloseButton("GL").click();
      await tick();
    });
    const reasonBox = document.querySelector('[role="dialog"] textarea');
    await act(async () => {
      setNativeValue(reasonBox as HTMLTextAreaElement, "December books reviewed and ready");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.reviewClose)).click();
      await tick();
    });
    const summary = document.querySelector('div[role="alertdialog"]');
    assert.ok(
      (summary?.textContent ?? "").includes("Nov 2025"),
      "the earlier open period is named before closing",
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("the requester sees Withdraw when decision preview fails or omits identity", async () => {
  const prior = globalThis.fetch;
  try {
    for (const response of [
      () => Response.json({ error: "Preview unavailable" }, { status: 503 }),
      () => Response.json({ conflicts: [] }),
    ]) {
      globalThis.fetch = (async () => response()) as typeof fetch;
      const props = baseProps({ tab: "periods", reopen: "r-own" });
      props.viewerId = "u-requester";
      props.reopenRequests = [
        {
          id: "r-own",
          period_id: "p1",
          book_id: "b1",
          status: "requested",
          requested_by: "u-requester",
          requester_name: "Rae",
          reason: "Correct the closing entry",
          modules: ["gl"],
          period_name: "January",
          book_name: "Main",
          approver_name: null,
        },
      ] as WorkspaceProps["reopenRequests"];
      const { unmount } = await mountWorkspace(props);
      try {
        assert.equal(clickButton(String(closeSetup.periods?.reopenWithdraw)).disabled, false);
        assert.ok(
          ![...document.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === closeSetup.actions?.reject,
          ),
        );
      } finally {
        await unmount();
      }
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test("the requester submits module widening with no implicit additional hours and opens its new request", async () => {
  const prior = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true, requestId: "new-request" });
  }) as typeof fetch;
  const props = baseProps({ tab: "periods", reopen: "r-window" });
  props.viewerId = "u-requester";
  props.reopenRequests = [
    {
      id: "r-window",
      period_id: "p1",
      book_id: "b1",
      status: "approved",
      requested_by: "u-requester",
      requester_name: "Rae",
      reason: "Correct the closing entry",
      modules: ["gl"],
      period_name: "January",
      book_name: "Main",
      approver_name: "Ari",
    },
  ] as WorkspaceProps["reopenRequests"];
  const { pushes, unmount } = await mountWorkspace(props);
  try {
    const hours = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(
      (input) => input.getAttribute("aria-label") === closeSetup.periods?.extendHoursLabel,
    );
    assert.ok(hours);
    assert.equal(hours.value, "", "module widening starts without an added duration");
    const check = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.closest("label")?.textContent?.trim() === "AP",
    );
    assert.ok(check);
    const reasons = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")];
    assert.equal(reasons.length, 2);
    await act(async () => {
      check.click();
      setNativeValue(reasons[1]!, "Include AP in the correction scope");
      await tick();
    });
    await act(async () => {
      clickButton(String(closeSetup.actions?.extendReopen)).click();
      await tick();
    });
    assert.deepEqual(bodies, [
      {
        action: "extend-reopen",
        requestId: "r-window",
        reason: "Include AP in the correction scope",
        addModules: ["ap"],
      },
    ]);
    assert.equal(pushes.length, 1);
    assert.match(pushes[0]!, /reopen=new-request/);
    assert.equal(globalThis.__closeTestToasts?.[0]?.message, closeSetup.messages?.reopenRequested);
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("a pending widening request shows the requested expiry before its decision", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ ownRequest: false, conflicts: [] })) as typeof fetch;
  const props = baseProps({ tab: "periods", reopen: "r-change" });
  props.reopenRequests = [
    {
      id: "r-change",
      period_id: "p1",
      book_id: "b1",
      status: "requested",
      requested_by: "u-requester",
      requester_name: "Rae",
      reason: "Include AP in the correction scope",
      modules: ["gl", "ap"],
      period_name: "January",
      book_name: "Main",
      approver_name: null,
      impact_snapshot: { amendment: { expiresAt: "2026-11-02T10:15:00.000Z" } },
    },
  ] as WorkspaceProps["reopenRequests"];
  const { unmount } = await mountWorkspace(props);
  try {
    assert.ok(
      document.body.textContent?.includes(
        `Requested expiry: ${viewerDateTime("2026-11-02T10:15:00Z", "en", "UTC")}`,
      ),
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});
