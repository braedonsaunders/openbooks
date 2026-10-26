import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

// sign-off blocked by unmatched lines 422s with zero user
// feedback. The route answers a typed { error } body, but the workspace's
// call does `await res.json` bare: when the error body is not JSON
// (empty body, proxy 5xx page) the READ itself throws, the toast never
// fires, and the failure goes silent with an unhandled rejection. The fix
// mirrors the documents row-action hardening: never let the read throw,
// always surface the server message or the fallback copy.
const { bootJsdomEnvironment } = await import("../../../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/banking/acc/reconcile/rec",
  matchMediaMatches: false,
  scrollIntoView: false,
  resizeObserver: false,
});

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
};
Object.assign(globalThis, {
  __reconcileTestToasts: script.toasts,
  __reconcileTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
});
const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__reconcileTestRouter}export function usePathname(){return "/banking/acc/reconcile/rec"}export function useSearchParams(){return new URLSearchParams()}',
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__reconcileTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__reconcileTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__reconcileTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
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
        url: 'data:text/javascript,export async function promptDialog(o){globalThis.__reconcileTestPromptOptions=o;return Object.hasOwn(globalThis,"__reconcileTestPrompt")?globalThis.__reconcileTestPrompt:"not a transaction"}',
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
const messages = (await import("../../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../../components/money-provider");
const { ReconcileWorkspace } = await import("./ReconcileWorkspace");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const pane = { q: "", sort: "date", dir: "asc" as const, page: 1, perPage: 25 };

async function mountWorkspace(
  t: TestContext,
  fetchImpl: typeof fetch,
  override: {
    status?: string;
    canReconcile?: boolean;
    canReviewSignOff?: boolean;
    stmtRows?: {
      id: string;
      posted_on: string;
      amount: string;
      description: string | null;
      counterparty_ref?: string | null;
      possible_duplicate_of?: string | null;
      dup_posted_on?: string | null;
      dup_amount?: string | null;
    }[];
    stmtTotal?: number;
    stmtOutstandingTotal?: string;
    glRows?: {
      id: string;
      posting_date: string;
      entry_number: string;
      amount: string;
      memo: string | null;
      party?: string | null;
    }[];
    glTotal?: number;
    glOutstandingTotal?: string;
    glClearings?: { group_id: string; lines: number; entries: string | null; total: string }[];
    stale?: {
      reviewed?: boolean;
      reviewedHref?: string | null;
      reviewedText?: string | null;
      badge: string;
      effect: string;
      late: {
        entryNumber: string;
        postingDate: string;
        amount: string;
        postedBy: string | null;
        postedAt: string | null;
      }[];
      reversed: {
        entryNumber: string;
        postingDate: string;
        amount: string;
        reversal: string | null;
      }[];
    } | null;
    priorEffects?: string[];
    opening?: {
      isFirst: boolean;
      statementOpening: string | null;
      coverageStart: string | null;
      bookBalance: string;
      confirmation: {
        amount: string;
        startDate: string;
        reason: string;
        confirmedAt: string;
        confirmedByName: string | null;
      } | null;
      carryApplies: boolean;
      carryStart: string | null;
    } | null;
  } = {},
): Promise<void> {
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });
  script.toasts.length = 0;
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ReconcileWorkspace
            basePath="/banking/acc/reconcile/rec"
            accountPath="/banking/acc"
            currentParams={{}}
            reconciliation={{
              id: "rec-1",
              status: override.status ?? "in_progress",
              throughDate: "2026-09-10",
              statementBalance: "17070.01",
              currency: "CAD",
            }}
            difference="0.00"
            canReconcile={override.canReconcile ?? true}
            canReviewSignOff={override.canReviewSignOff}
            stmtRows={(override.stmtRows ?? []).map((row) => ({
              counterparty_ref: null,
              possible_duplicate_of: null,
              dup_posted_on: null,
              dup_amount: null,
              ...row,
            }))}
            stmtTotal={override.stmtTotal ?? 0}
            stmtOutstandingTotal={override.stmtOutstandingTotal ?? "0"}
            stmtParams={pane}
            glRows={(override.glRows ?? []).map((row) => ({ party: null, ...row }))}
            glTotal={override.glTotal ?? 0}
            glOutstandingTotal={override.glOutstandingTotal ?? "0"}
            glParams={pane}
            matchedRows={[]}
            matchedTotal={0}
            mParams={pane}
            glClearings={override.glClearings ?? []}
            stale={override.stale ?? null}
            priorEffects={override.priorEffects ?? []}
            opening={override.opening ?? null}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
}

function signOffButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Sign off"),
  );
  assert.ok(found, "the balanced workspace must offer Sign off");
  return found as HTMLButtonElement;
}

test("adjustment inputs are associated with their visible labels", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch);
  const adjust = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Adjust"),
  );
  assert.ok(adjust, "the workspace offers an adjustment action");
  await act(async () => {
    adjust.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  for (const name of ["Reconcile through", "Statement balance"]) {
    const label = [...document.querySelectorAll("label")].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    assert.ok(label, `${name} label renders`);
    assert.ok(label.control, `${name} label controls its input`);
  }
});

test("adjustment balance refuses exponent notation and posts large amounts as exact text", async (t) => {
  let requestBody: Record<string, unknown> | undefined;
  await mountWorkspace(t, (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH")
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return Response.json({});
  }) as typeof fetch);
  const adjust = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Adjust"),
  );
  assert.ok(adjust);
  await act(async () => {
    adjust.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  const balance = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;
  assert.ok(balance);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(balance, "1e3");
    balance.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  const save = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Save"),
  ) as HTMLButtonElement | undefined;
  assert.ok(save && save.disabled, "scientific notation must be refused client-side");
  await act(async () => {
    setter?.call(balance, "9007199254740993.0123");
    balance.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  assert.ok(save && !save.disabled);
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  assert.equal(requestBody?.statementBalance, "9007199254740993.0123");
});

test("a sign-off refusal surfaces the server message", async (t) => {
  await mountWorkspace(t, (async () =>
    Response.json(
      { error: "Cannot sign off: 3 statement line(s) through the cutoff remain unmatched" },
      { status: 422 },
    )) as typeof fetch);
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    await tick();
  });
  assert.ok(
    script.toasts.some(
      (toast) => toast.kind === "error" && toast.message.includes("3 statement line(s)"),
    ),
    `the refusal must surface, got ${JSON.stringify(script.toasts)}`,
  );
  assert.equal(
    signOffButton().disabled,
    false,
    "the workspace must not wedge busy after a refusal",
  );
});

test("an unreadable sign-off error body still surfaces the fallback copy", async (t) => {
  await mountWorkspace(t, (async () => new Response("", { status: 422 })) as typeof fetch);
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    await tick();
  });
  assert.ok(
    script.toasts.some((toast) => toast.kind === "error"),
    `an empty-body 422 must still toast, got ${JSON.stringify(script.toasts)}`,
  );
  assert.equal(
    signOffButton().disabled,
    false,
    "the workspace must not wedge busy on an unreadable body",
  );
});

test("grouped selection posts both sides as one group", async (t) => {
  const calls: { url: string; body?: string }[] = [];
  await mountWorkspace(
    t,
    (async (_input: unknown, init?: RequestInit) => {
      if (String(_input).includes("/matches") && init?.method === "POST") {
        calls.push({ url: String(_input), body: String(init.body) });
      }
      return Response.json({ ok: true, totals: { difference: "0.00" } });
    }) as typeof fetch,
    {
      stmtRows: [
        { id: "stmt-a", posted_on: "2026-09-01", amount: "-4000.00", description: "Wire A" },
        { id: "stmt-b", posted_on: "2026-09-01", amount: "-4000.00", description: "Wire B" },
      ],
      stmtTotal: 2,
      stmtOutstandingTotal: "-8000.00",
      glRows: [
        {
          id: "gl-1",
          posting_date: "2026-08-30",
          entry_number: "JE-9",
          amount: "-8000.00",
          memo: null,
          party: null,
        },
      ],
      glTotal: 1,
      glOutstandingTotal: "-8000.00",
    },
  );
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.equal(boxes.length, 3, "both bank lines and the ledger line offer checkboxes");
  await act(async () => {
    for (const box of boxes) box.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const match = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Match selected",
  ) as HTMLButtonElement | undefined;
  assert.ok(match, "the workspace offers Match selected");
  assert.equal(match.disabled, false, "a selected group enables Match selected");
  await act(async () => {
    match.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const posted = calls.find((c) => c.url.includes("/matches"));
  assert.ok(posted, "matching must POST the session matches route");
  const body = JSON.parse(posted.body ?? "{}") as {
    statementLineIds?: string[];
    journalLineIds?: string[];
  };
  assert.deepEqual(
    [...(body.statementLineIds ?? [])].sort(),
    ["stmt-a", "stmt-b"],
    "both bank lines post as the group",
  );
  assert.deepEqual(body.journalLineIds, ["gl-1"], "the ledger side posts with them");
  assert.ok(
    script.toasts.some((toast) => toast.kind === "success"),
    `the group match must toast success, got ${JSON.stringify(script.toasts)}`,
  );
});

test("a sign-off refusal persists the message with its blocking lines", async (t) => {
  await mountWorkspace(
    t,
    (async (input: unknown) => {
      if (String(input).includes("/blockers")) {
        return Response.json({
          ok: true,
          lines: [
            {
              id: "stmt-x",
              postedOn: "2026-09-01",
              amount: "3068.57",
              description: "Opening balance",
            },
            { id: "stmt-y", postedOn: "2026-09-02", amount: "-45.00", description: "Card payment" },
          ],
          total: 2,
        });
      }
      return Response.json(
        { error: "Cannot sign off: 2 statement line(s) through the cutoff remain unmatched" },
        { status: 422 },
      );
    }) as typeof fetch,
    {
      stmtRows: [
        {
          id: "stmt-x",
          posted_on: "2026-09-01",
          amount: "3068.57",
          description: "Opening balance",
        },
        { id: "stmt-y", posted_on: "2026-09-02", amount: "-45.00", description: "Card payment" },
      ],
      stmtTotal: 2,
      stmtOutstandingTotal: "3023.57",
    },
  );
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i++) await tick();
  });
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must persist as a workspace alert");
  assert.ok(
    (alert.textContent ?? "").includes("2 statement line(s) through the cutoff remain unmatched"),
    `the alert must carry the typed refusal, got ${JSON.stringify(alert.textContent)}`,
  );
  assert.ok(
    (alert.textContent ?? "").includes("Blocking lines"),
    "the alert must name the blocking lines",
  );
  assert.ok(
    (alert.textContent ?? "").includes("Opening balance"),
    "the alert must list the blocking row",
  );
  const link = document.querySelector('a[href="#stmt-line-stmt-x"]');
  assert.ok(link, "each blocking line must link to its workspace row");
  assert.ok(
    (link.textContent ?? "").includes("2026-09-01") &&
      (link.textContent ?? "").includes("Opening balance"),
    `the link must carry the date and description, got ${JSON.stringify(link.textContent)}`,
  );
  assert.ok(document.getElementById("stmt-line-stmt-x"), "the linked row anchor must exist");
  assert.equal(
    signOffButton().disabled,
    false,
    "the workspace must not wedge busy after a refusal",
  );
});

test("an unreadable blockers read still leaves the refusal standing", async (t) => {
  await mountWorkspace(t, (async () => new Response("", { status: 422 })) as typeof fetch);
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i++) await tick();
  });
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must persist even when the blockers read fails");
  assert.equal(
    document.querySelector('a[href^="#stmt-line-"]'),
    null,
    "no blocker links render without blocker data",
  );
});

test("clearing GL-only lines posts the group without a bank line", async (t) => {
  const calls: { url: string; body?: string }[] = [];
  await mountWorkspace(
    t,
    (async (_input: unknown, init?: RequestInit) => {
      if (String(_input).includes("/gl-clearing") && init?.method === "POST") {
        calls.push({ url: String(_input), body: String(init.body) });
      }
      return Response.json({ ok: true, totals: { difference: "0.00" } });
    }) as typeof fetch,
    {
      glRows: [
        {
          id: "gl-a",
          posting_date: "2026-09-01",
          entry_number: "JE-1",
          amount: "271.20",
          memo: "Voided deposit",
          party: null,
        },
        {
          id: "gl-b",
          posting_date: "2026-09-02",
          entry_number: "JE-2",
          amount: "-271.20",
          memo: "Correction",
          party: null,
        },
      ],
      glTotal: 2,
      glOutstandingTotal: "0.00",
    },
  );
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.equal(boxes.length, 2, "both ledger lines offer checkboxes");
  await act(async () => {
    for (const box of boxes) box.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const clear = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Clear selected",
  ) as HTMLButtonElement | undefined;
  assert.ok(clear, "the workspace offers Clear selected");
  assert.equal(clear.disabled, false, "a GL-only selection enables Clear selected");
  const match = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Match selected",
  ) as HTMLButtonElement | undefined;
  assert.ok(match && match.disabled, "Match selected stays disabled without a bank line");
  await act(async () => {
    clear.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const posted = calls.find((c) => c.url.includes("/gl-clearing"));
  assert.ok(posted, "clearing must POST the session gl-clearing route");
  const body = JSON.parse(posted.body ?? "{}") as { journalLineIds?: string[] };
  assert.deepEqual(
    [...(body.journalLineIds ?? [])].sort(),
    ["gl-a", "gl-b"],
    "both ledger lines post as the group",
  );
  assert.ok(
    script.toasts.some((toast) => toast.kind === "success" && toast.message.includes("Cleared")),
    `clearing must toast success, got ${JSON.stringify(script.toasts)}`,
  );
});

test("a GL clearing group lists with an unmatch action", async (t) => {
  const calls: string[] = [];
  await mountWorkspace(
    t,
    (async (_input: unknown, init?: RequestInit) => {
      if (String(_input).includes("/gl-clearing") && init?.method === "DELETE")
        calls.push(String(_input));
      return Response.json({ ok: true, totals: { difference: "0.00" } });
    }) as typeof fetch,
    {
      glClearings: [{ group_id: "group-1", lines: 2, entries: "JE-1, JE-2", total: "0.0000" }],
    },
  );
  assert.ok(
    (document.body.textContent ?? "").includes("GL clearing groups"),
    "the workspace must list its clearing groups",
  );
  assert.ok(
    (document.body.textContent ?? "").includes("JE-1, JE-2"),
    "the group must name its entries",
  );
  const unmatch = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Unmatch",
  ) as HTMLButtonElement | undefined;
  assert.ok(unmatch, "the group must offer Unmatch");
  await act(async () => {
    unmatch.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  assert.ok(
    calls.some((url) => url.includes("/gl-clearing?groupId=group-1")),
    `unmatching must call the group route, got ${JSON.stringify(calls)}`,
  );
});

test("excluding a bank line prompts for a reason and patches the line", async (t) => {
  const calls: { url: string; body?: string }[] = [];
  await mountWorkspace(
    t,
    (async (_input: unknown, init?: RequestInit) => {
      if (String(_input).includes("/statement-lines/") && init?.method === "PATCH") {
        calls.push({ url: String(_input), body: String(init.body) });
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
    {
      stmtRows: [
        {
          id: "stmt-x",
          posted_on: "2026-09-01",
          amount: "3068.57",
          description: "Opening balance",
        },
      ],
      stmtTotal: 1,
      stmtOutstandingTotal: "3068.57",
    },
  );
  const exclude = [...document.querySelectorAll("button[title]")].find(
    (b) => b.getAttribute("title") === "Exclude",
  ) as HTMLButtonElement | undefined;
  assert.ok(exclude, "the unmatched row must offer Exclude");
  await act(async () => {
    exclude.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  assert.ok(
    calls.some(
      (c) =>
        c.url.includes("/statement-lines/stmt-x") &&
        (c.body ?? "").includes('"action":"exclude"') &&
        (c.body ?? "").includes("not a transaction"),
    ),
    `excluding must patch the line with the prompted reason, got ${JSON.stringify(calls)}`,
  );
  assert.ok(
    script.toasts.some(
      (toast) => toast.kind === "success" && toast.message.includes("Line excluded"),
    ),
    `excluding must toast success, got ${JSON.stringify(script.toasts)}`,
  );
});

test("a signed-off session lists its outstanding items with totals instead of empty panes", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    status: "signed_off",
    stmtRows: [],
    stmtTotal: 0,
    stmtOutstandingTotal: "0",
    glRows: [
      {
        id: "gl-orphan",
        posting_date: "2026-09-05",
        entry_number: "JE-7",
        amount: "250.00",
        memo: "Deposit in transit",
        party: null,
      },
    ],
    glTotal: 1,
    glOutstandingTotal: "250.00",
  });
  const text = document.body.textContent ?? "";
  assert.ok(
    text.includes("Deposit in transit"),
    "the orphaned book entry stays visible after sign-off",
  );
  assert.ok(text.includes("outstanding"), "the panes name their outstanding totals");
  assert.ok(!text.includes("Match selected"), "a signed-off session offers no matching");
  assert.ok(!text.includes("Sign off"), "a signed-off session offers no second sign-off");
});

test("a stale signed-off session names the late entries, their effect, and the remedy", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    status: "signed_off",
    stale: {
      badge: "Stale since 2026-07-25",
      effect: "Effect on cleared balance: -$920.00",
      late: [
        {
          entryNumber: "STALE-late-receipt",
          postingDate: "2026-07-10",
          amount: "3500.0000",
          postedBy: "Bank reviewer",
          postedAt: "2026-07-25",
        },
        {
          entryNumber: "STALE-late-payment",
          postingDate: "2026-07-12",
          amount: "-4420.0000",
          postedBy: "Bank reviewer",
          postedAt: "2026-07-26",
        },
      ],
      reversed: [
        {
          entryNumber: "STALE-matched",
          postingDate: "2026-07-10",
          amount: "100.0000",
          reversal: "Reversal STALE-rev on 2026-07-27",
        },
      ],
    },
  });
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("Stale since 2026-07-25"), "the workspace badges the stale sign-off");
  assert.ok(text.includes("STALE-late-receipt"), "the panel names the late receipt");
  assert.ok(text.includes("STALE-late-payment"), "the panel names the late payment");
  assert.ok(text.includes("Bank reviewer"), "the panel names who posted the late entries");
  assert.ok(text.includes("STALE-matched"), "the panel names the reversed match");
  assert.ok(
    text.includes("Reversal STALE-rev on 2026-07-27"),
    "the panel names the reversal behind it",
  );
  assert.ok(
    text.includes("Match these lines in the next reconciliation session"),
    "the panel states the remedy",
  );
});

test("an unsigned session explains its opening difference from earlier late periods", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    priorEffects: ["-920.00 from entries posted into 2026-07-15 after its sign-off"],
  });
  const text = document.body.textContent ?? "";
  assert.ok(
    text.includes("-920.00 from entries posted into 2026-07-15 after its sign-off"),
    "the workspace carries the earlier period effect into the opening difference explanation",
  );
});

test("a gl-clearing refusal on a lone opening line surfaces its message", async (t) => {
  // The book opening journal has no bank line by nature: clearing it alone
  // 422s (a clearing group must sum to zero) and the typed refusal — not
  // silence — is what the operator must see.
  await mountWorkspace(
    t,
    (async () =>
      Response.json(
        {
          error:
            "Selected journal lines total 63412.5500, not zero — a GL clearing group must sum exactly to zero",
        },
        { status: 422 },
      )) as typeof fetch,
    {
      glRows: [
        {
          id: "gl-opening",
          posting_date: "2026-07-01",
          entry_number: "JE-OPEN",
          amount: "63412.55",
          memo: "Opening balance",
          party: null,
        },
      ],
      glTotal: 1,
      glOutstandingTotal: "63412.55",
    },
  );
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.equal(boxes.length, 1, "the opening ledger line offers a checkbox");
  await act(async () => {
    boxes[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const clear = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Clear selected",
  ) as HTMLButtonElement | undefined;
  assert.ok(clear, "the workspace offers Clear selected");
  assert.equal(clear.disabled, false, "a GL-only selection enables Clear selected");
  await act(async () => {
    clear.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  assert.ok(
    script.toasts.some(
      (toast) => toast.kind === "error" && toast.message.includes("must sum exactly to zero"),
    ),
    `the clearing refusal must surface, got ${JSON.stringify(script.toasts)}`,
  );
  assert.equal(clear.disabled, false, "the workspace must not wedge busy after a clearing refusal");
});

const balanceLessOpening = {
  isFirst: true,
  statementOpening: null,
  coverageStart: "2026-07-02",
  bookBalance: "63412.5500",
  confirmation: null,
  carryApplies: false,
  carryStart: null,
};

test("a balance-less first reconciliation offers to confirm its opening", async (t) => {
  const calls: { url: string; body?: string }[] = [];
  await mountWorkspace(
    t,
    (async (_input: unknown, init?: RequestInit) => {
      if (String(_input).includes("/opening") && init?.method === "POST") {
        calls.push({ url: String(_input), body: String(init.body) });
      }
      return Response.json({ ok: true, totals: { difference: "0.00" } });
    }) as typeof fetch,
    { opening: balanceLessOpening },
  );
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("Opening balance"), "the workspace names the opening position");
  assert.ok(
    text.includes("63,412.55") || text.includes("63412.55"),
    `the workspace shows the book balance carried in, got ${JSON.stringify(text.slice(0, 2000))}`,
  );
  const amount = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;
  assert.ok(amount, "the opening amount is editable");
  assert.ok(
    (amount.value ?? "").includes("63412.55"),
    "the amount starts at the book balance carried in",
  );
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const reason = [...document.querySelectorAll("input")].find((input) =>
    input.getAttribute("placeholder")?.includes("Opening balance from"),
  ) as HTMLInputElement | undefined;
  assert.ok(reason, "the opening reason is prompted");
  await act(async () => {
    setter?.call(
      reason,
      "Opening balance from the prior-year close, confirmed to the bank records",
    );
    reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    for (let i = 0; i < 4; i++) await tick();
  });
  const confirm = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Confirm opening",
  ) as HTMLButtonElement | undefined;
  assert.ok(confirm, "the workspace offers Confirm opening");
  assert.equal(confirm.disabled, false, "a reasoned confirmation enables Confirm opening");
  await act(async () => {
    confirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const posted = calls.find((c) => c.url.includes("/opening"));
  assert.ok(posted, "confirming must POST the session opening route");
  const body = JSON.parse(posted.body ?? "{}") as { openingBalance?: string; reason?: string };
  assert.equal(
    body.openingBalance,
    "63412.5500",
    "the confirmed opening posts as exact decimal text",
  );
  assert.ok((body.reason ?? "").length >= 5, "the reason posts with the confirmation");
  assert.ok(
    script.toasts.some((toast) => toast.kind === "success"),
    `confirming must toast success, got ${JSON.stringify(script.toasts)}`,
  );
});

test("an unproven opening confirmation surfaces the refusal", async (t) => {
  await mountWorkspace(
    t,
    (async () =>
      Response.json(
        {
          error:
            "The confirmed opening 63000.0000 does not match the book balance carried in (63412.5500 through 2026-07-02) — correct the amount or post the missing book entries first",
        },
        { status: 422 },
      )) as typeof fetch,
    { opening: balanceLessOpening },
  );
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const amount = document.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;
  const reason = [...document.querySelectorAll("input")].find((input) =>
    input.getAttribute("placeholder")?.includes("Opening balance from"),
  ) as HTMLInputElement | undefined;
  assert.ok(amount && reason, "the opening form renders");
  await act(async () => {
    setter?.call(amount, "63000");
    amount.dispatchEvent(new window.Event("input", { bubbles: true }));
    setter?.call(
      reason,
      "Opening balance from the prior-year close, confirmed to the bank records",
    );
    reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    for (let i = 0; i < 4; i++) await tick();
  });
  const confirm = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Confirm opening",
  ) as HTMLButtonElement | undefined;
  assert.ok(confirm && !confirm.disabled, "the edited confirmation is submittable");
  await act(async () => {
    confirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  assert.ok(
    script.toasts.some(
      (toast) =>
        toast.kind === "error" &&
        toast.message.includes("does not match the book balance carried in"),
    ),
    `the confirmation refusal must surface with its remedy, got ${JSON.stringify(script.toasts)}`,
  );
});

test("a refused opening confirmation persists beside the opening form", async (t) => {
  // A refused confirmation that only fires a transient toast reads as
  // "nothing happened" once it dismisses: the typed refusal must persist
  // as a workspace alert until the next success.
  await mountWorkspace(
    t,
    (async () =>
      Response.json(
        {
          error:
            "Import the statement lines first — there is no covered period to carry an opening into",
        },
        { status: 422 },
      )) as typeof fetch,
    { opening: balanceLessOpening },
  );
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const reason = [...document.querySelectorAll("input")].find((input) =>
    input.getAttribute("placeholder")?.includes("Opening balance from"),
  ) as HTMLInputElement | undefined;
  assert.ok(reason, "the opening form renders");
  await act(async () => {
    setter?.call(
      reason,
      "Opening balance from the prior-year close, confirmed to the bank records",
    );
    reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    for (let i = 0; i < 4; i++) await tick();
  });
  const confirm = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Confirm opening",
  ) as HTMLButtonElement | undefined;
  assert.ok(confirm && !confirm.disabled, "the reasoned confirmation is submittable");
  await act(async () => {
    confirm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const alert = document.querySelector('[role="alert"]');
  assert.ok(
    alert && (alert.textContent ?? "").includes("Import the statement lines first"),
    `the opening refusal must persist in the workspace, got ${JSON.stringify(alert?.textContent ?? null)}`,
  );
});

test("a confirmed opening reads as the session opening position", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    opening: {
      ...balanceLessOpening,
      confirmation: {
        amount: "63412.5500",
        startDate: "2026-07-02",
        reason: "Opening balance from the prior-year close, confirmed to the bank records",
        confirmedAt: "2026-07-15T10:00:00Z",
        confirmedByName: "Bank reviewer",
      },
      carryApplies: true,
      carryStart: "2026-07-02",
    },
  });
  const text = document.body.textContent ?? "";
  assert.ok(text.includes("confirmed"), "the workspace states the opening is confirmed");
  assert.ok(
    text.includes("Opening balance from the prior-year close"),
    "the workspace shows the confirmation reason",
  );
  assert.equal(
    [...document.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Confirm opening",
    ),
    undefined,
    "a carried confirmation offers no second confirmation",
  );
});

test("a possible-duplicate bank line offers Exclude duplicate with the duplicated line named in the reason", async (t) => {
  const calls: { url: string; body?: string }[] = [];
  (globalThis as Record<string, unknown>).__reconcileTestPrompt =
    "Duplicate of the bank line dated 2026-09-01 for -7.0000: COFFEE SHOP";
  await mountWorkspace(
    t,
    (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/statement-lines/") && init?.method === "PATCH") {
        calls.push({ url: String(input), body: String(init.body) });
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
    {
      stmtRows: [
        {
          id: "stmt-dup",
          posted_on: "2026-09-02",
          amount: "-7.0000",
          description: "COFFEE SHOP",
          possible_duplicate_of: "stmt-first",
          dup_posted_on: "2026-09-01",
          dup_amount: "-7.0000",
        },
      ],
      stmtTotal: 1,
      stmtOutstandingTotal: "-7.00",
    },
  );
  const excludeDuplicate = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === "Exclude duplicate",
  ) as HTMLButtonElement | undefined;
  assert.ok(excludeDuplicate, "a flagged line must offer Exclude duplicate");
  assert.ok(
    (document.body.textContent ?? "").includes("Possible duplicate"),
    "the flagged line is labelled",
  );
  await act(async () => {
    excludeDuplicate.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  });
  const options = (globalThis as Record<string, unknown>).__reconcileTestPromptOptions as
    { initialValue?: string } | undefined;
  assert.ok(
    (options?.initialValue ?? "").includes("2026-09-01") &&
      (options?.initialValue ?? "").includes("-7.0000"),
    `the reason must be prefilled naming the duplicated line, got ${JSON.stringify(options)}`,
  );
  assert.ok(
    calls.some(
      (c) =>
        c.url.includes("/statement-lines/stmt-dup") &&
        (c.body ?? "").includes('"action":"exclude"') &&
        (c.body ?? "").includes("dated 2026-09-01"),
    ),
    `excluding must patch the flagged line with the reason, got ${JSON.stringify(calls)}`,
  );
  delete (globalThis as Record<string, unknown>).__reconcileTestPrompt;
});

test("a sign-off blocker that is a possible duplicate names the line it duplicates", async (t) => {
  await mountWorkspace(
    t,
    (async (input: unknown) => {
      if (String(input).includes("/blockers")) {
        return Response.json({
          ok: true,
          lines: [
            {
              id: "stmt-dup",
              postedOn: "2026-09-02",
              amount: "-7.0000",
              description: "COFFEE SHOP",
              possibleDuplicateOf: "stmt-first",
              possibleDuplicateOfPostedOn: "2026-09-01",
              possibleDuplicateOfAmount: "-7.0000",
            },
          ],
          total: 1,
        });
      }
      return Response.json(
        { error: "Cannot sign off: 1 statement line(s) through the cutoff remain unmatched" },
        { status: 422 },
      );
    }) as typeof fetch,
    {
      stmtRows: [
        {
          id: "stmt-dup",
          posted_on: "2026-09-02",
          amount: "-7.0000",
          description: "COFFEE SHOP",
          possible_duplicate_of: "stmt-first",
          dup_posted_on: "2026-09-01",
          dup_amount: "-7.0000",
        },
      ],
      stmtTotal: 1,
      stmtOutstandingTotal: "-7.00",
    },
  );
  await act(async () => {
    signOffButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i++) await tick();
  });
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal must persist as a workspace alert");
  const text = alert.textContent ?? "";
  assert.ok(
    text.includes("Possible duplicate"),
    `the blocker must be labelled a possible duplicate, got ${JSON.stringify(text)}`,
  );
  assert.ok(
    text.includes("of 2026-09-01"),
    `the blocker must name the duplicated line's date, got ${JSON.stringify(text)}`,
  );
});

test("neutral review obtains the exact basis before its reasoned confirmation, and a refusal remains visible", async (t) => {
  const calls: { method: string; body: unknown }[] = [];
  const digest = "a".repeat(64);
  await mountWorkspace(
    t,
    (async (input, init) => {
      if (String(input).startsWith("/api/flows/record-state"))
        return Response.json({
          approvalState: { status: "signed_off", pendingWith: [], myActions: null },
          history: [],
          canRetry: false,
          failedRun: null,
          neverSubmitted: false,
          submittedByViewer: false,
        });
      calls.push({
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return init?.method === "POST"
        ? Response.json(
            { error: "The reviewed ledger evidence changed. Reload the review." },
            { status: 409 },
          )
        : Response.json({
            reconciliationId: "rec-1",
            throughDate: "2026-09-10",
            currency: "CAD",
            statementBalance: "17070.0100",
            proof: {
              digest,
              lateEntries: 2,
              lateJournalLines: 2,
              lateEffect: "0.0000",
              neutralBasis: "late_movements",
            },
          });
    }) as typeof fetch,
    { status: "signed_off", stale: { badge: "Stale", effect: "0", late: [], reversed: [] } },
  );
  const button = [...document.querySelectorAll("button")].find((row) =>
    row.textContent?.includes("Review neutral account history"),
  );
  assert.ok(button);
  await act(async () => {
    button.click();
    await tick();
    await tick();
    await tick();
  });
  assert.deepEqual(calls, [
    { method: "GET", body: null },
    { method: "POST", body: { expectedDigest: digest, reason: "not a transaction" } },
  ]);
  assert.ok(
    document.body.textContent?.includes("The reviewed ledger evidence changed. Reload the review."),
  );
  assert.equal(button.disabled, false);
});

test("a reviewed later sign-off retains late movements and links its actual earlier review without offering another mutation", async (t) => {
  const calls: unknown[] = [];
  await mountWorkspace(
    t,
    (async (...args) => {
      calls.push(args);
      return Response.json({});
    }) as typeof fetch,
    {
      status: "signed_off",
      stale: {
        reviewed: true,
        reviewedHref: "/banking/acc/reconcile/earlier",
        reviewedText: "Review evidence through 2026-07-31",
        badge: "Neutral history reviewed",
        effect: "0",
        late: [
          {
            entryNumber: "ADJ-1",
            postingDate: "2026-07-15",
            amount: "10.0000",
            postedBy: "Reviewer",
            postedAt: "2026-10-01",
          },
        ],
        reversed: [],
      },
    },
  );
  assert.ok(document.body.textContent?.includes("ADJ-1"));
  assert.equal(
    document.querySelector('a[href="/banking/acc/reconcile/earlier"]')?.textContent,
    "Review evidence through 2026-07-31",
  );
  assert.equal(
    [...document.querySelectorAll("button")].some((row) =>
      row.textContent?.includes("Review neutral account history"),
    ),
    false,
  );
  assert.equal(calls.length, 0);
});

test("the review discloses a nonzero late movement and its complete zero-net uncleared set before a cancelled confirmation", async (t) => {
  const state = globalThis as Record<string, unknown>;
  const previous = state.__reconcileTestPrompt;
  state.__reconcileTestPrompt = null;
  t.after(() => {
    if (previous === undefined) delete state.__reconcileTestPrompt;
    else state.__reconcileTestPrompt = previous;
  });
  const calls: string[] = [];
  await mountWorkspace(
    t,
    (async (input, init) => {
      if (String(input).startsWith("/api/flows/record-state"))
        return Response.json({
          approvalState: { status: "signed_off", pendingWith: [], myActions: null },
          history: [],
          canRetry: false,
          failedRun: null,
          neverSubmitted: false,
          submittedByViewer: false,
        });
      calls.push(init?.method ?? "GET");
      return Response.json({
        reconciliationId: "rec-1",
        throughDate: "2026-09-10",
        currency: "CAD",
        statementBalance: "17070.0100",
        proof: {
          digest: "b".repeat(64),
          lateEntries: 1,
          lateJournalLines: 1,
          lateEffect: "8000.0000",
          neutralBasis: "outstanding_movements",
          outstandingEntries: 2,
          outstandingJournalLines: 2,
          outstandingEffect: "0.0000",
        },
      });
    }) as typeof fetch,
    { status: "signed_off", stale: { badge: "Stale", effect: "8000", late: [], reversed: [] } },
  );
  const button = [...document.querySelectorAll("button")].find((row) =>
    row.textContent?.includes("Review neutral account history"),
  );
  assert.ok(button);
  await act(async () => {
    button.click();
    await tick();
    await tick();
    await tick();
  });
  const prompt = state.__reconcileTestPromptOptions as { message: string };
  assert.ok(prompt.message.includes("8,000"), "the actual nonzero late movement is disclosed");
  assert.ok(
    prompt.message.includes("retained counterparts"),
    "the complete reviewed set includes the older evidence",
  );
  assert.deepEqual(calls, ["GET"], "cancelling review records no financial or audit command");
});

test("an independent review-only workspace offers review while ordinary reconciliation actions remain unavailable", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    status: "signed_off",
    canReconcile: false,
    canReviewSignOff: true,
    stale: { badge: "Stale", effect: "0", late: [], reversed: [] },
  });
  const labels = [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
  assert.ok(labels.some((label) => label.includes("Review neutral account history")));
  for (const forbidden of ["Withdraw sign-off", "Adjust", "Sign off"]) {
    assert.equal(
      labels.some((label) => label.includes(forbidden)),
      false,
      `review-only authority does not offer ${forbidden}`,
    );
  }
});

test("a banking reader cannot open neutral-history review without a review duty", async (t) => {
  await mountWorkspace(t, (async () => Response.json({})) as typeof fetch, {
    status: "signed_off",
    canReconcile: false,
    canReviewSignOff: false,
    stale: { badge: "Stale", effect: "0", late: [], reversed: [] },
  });
  assert.equal(
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Review neutral account history"),
    ),
    false,
  );
});
