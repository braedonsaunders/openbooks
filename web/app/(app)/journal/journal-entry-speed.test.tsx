// Keyboard-speed entry for manual journals: the create shortcut opens an
// unsaved form (no draft row, no number), ⌘S / Ctrl+S and the Save & new
// chord run the drawer's own save, Ctrl+Enter posts and starts the next
// journal on the same date, a blank line arrives pre-entered with the
// balancing amount, and optional header settings stay folded unless they
// hold a value.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __journalToasts: { kind: string; message: string }[] | undefined;
  var __journalRouter:
    { push(url: string): void; replace(url: string): void; refresh(): void } | undefined;
}

await bootJsdomEnvironment({
  url: "http://localhost:4800/journal?entryNew=1&mode=edit",
  matchMediaMatches: false,
});
// The primary modifier follows the platform; pin a non-Apple one so Ctrl is primary.
Object.defineProperty(globalThis.navigator, "platform", {
  value: "Linux x86_64",
  configurable: true,
});

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__journalRouter}" +
      "export function usePathname(){return '/journal'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__journalToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__journalToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__journalToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__journalToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
  },
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return 'reason'}",
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
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { ShortcutProvider } = await import("../../../components/shortcuts/shortcut-provider");
const { GlobalCreateMenu } = await import("../../../components/global-create-menu");
const {
  JournalDrawer,
  balanceLineAt,
  balancingLeg,
  freshJournalHref,
  journalOptionsAreNonDefault,
  suggestBalancingLine,
} = await import("./JournalDrawer");

const copy = messages.journal.drawer;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function freshGlobals() {
  globalThis.__journalToasts = [];
  const router = {
    pushes: [] as string[],
    replaces: [] as string[],
    push(url: string) {
      this.pushes.push(url);
    },
    replace(url: string) {
      this.replaces.push(url);
    },
    refresh() {},
  };
  globalThis.__journalRouter = router;
  return router;
}

type Call = { url: string; init?: RequestInit };
function installFetch(
  t: TestContext,
  responder: (url: string, init?: RequestInit) => Response | null,
) {
  const prior = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, init });
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return responder(url, init) ?? Response.json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  return calls;
}

const ACCOUNTS = [
  { id: "a1", number: "1000", name: "Cash" },
  { id: "a2", number: "4000", name: "Revenue" },
];

// Lines with an account and no amount yet, as an operator would have them
// after picking accounts.
const ACCOUNT_LINES = [
  { account_id: "a1", amount: "0", description: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "0", description: "", custom: {}, extra_dims: {} },
];

const BLANK_CREATE = () => ({
  id: "",
  kind: "journal",
  status: "draft",
  document_number: null,
  currency: "USD",
  updated_at: "",
  document_date: "2026-10-14",
  memo: "",
  reference_number: null,
  party_id: null,
  party_name: null,
  subsidiary_id: null,
  custom: {},
  extra_dims: {},
  entry_id: null,
});

const DRAFT = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: "journal",
  status: "draft",
  document_number: "JE-00012",
  currency: "USD",
  updated_at: "5",
  document_date: "2026-10-14",
  memo: "accrual",
  reference_number: null,
  party_id: null,
  party_name: null,
  subsidiary_id: null,
  custom: {},
  extra_dims: {},
  entry_id: null,
  ...overrides,
});

async function mount(
  t: TestContext,
  doc: Record<string, unknown>,
  options: {
    lines?: Record<string, unknown>[];
    createMode?: boolean;
    initialMode?: "edit" | "view";
    canCreate?: boolean;
  } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ShortcutProvider>
            <JournalDrawer
              journal={{ doc, lines: options.lines ?? [] } as never}
              parties={[{ id: "p1", display_name: "Acme Supply" }]}
              accounts={ACCOUNTS}
              departments={[]}
              projects={[]}
              subsidiaries={[]}
              headerDefs={[]}
              lineDefs={[]}
              createMode={options.createMode}
              initialMode={options.initialMode ?? (options.createMode ? "edit" : "view")}
              canPost
              canCreate={options.canCreate ?? true}
              closeHref="/journal"
            />
          </ShortcutProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: Element) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
    await tick();
  });
  await tick();
  await tick();
}

async function focus(element: HTMLElement) {
  await act(async () => {
    element.focus();
    await tick();
  });
  await tick();
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

function memoInput(): HTMLInputElement {
  const hint = [...document.querySelectorAll("[role='dialog'] p")].find(
    (p) => p.textContent === copy.memoHint,
  );
  const input = hint?.previousElementSibling;
  assert.ok(input instanceof window.HTMLInputElement, "the memo field renders with its hint");
  return input;
}

function dateInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    "[role='dialog'] input[data-date-field][data-autofocus]",
  );
  assert.ok(input, "the entry date input carries the drawer's initial-focus marker");
  return input;
}

/** The amount inputs of one grid line, debit then credit. */
function amountInputs(row: number): HTMLInputElement[] {
  return [
    ...document.querySelectorAll<HTMLInputElement>(
      `[data-lg-row="${row}"] input[inputmode="decimal"]`,
    ),
  ];
}

const journalPosts = (calls: Call[]) =>
  calls.filter(
    (call) =>
      call.url.startsWith("/api/journals") && call.init?.method && call.init.method !== "GET",
  );

test("the journal create shortcut opens the unsaved form without writing a draft", async (t) => {
  const router = freshGlobals();
  const calls = installFetch(t, () => null);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const permissions = {
    accountsReceivable: false,
    accountsPayable: false,
    journal: true,
    customerPayments: false,
    vendorPayments: false,
    expenses: false,
    parties: false,
    items: false,
    projects: false,
    assets: false,
    orders: false,
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GlobalCreateMenu permissions={permissions} />
      </NextIntlClientProvider>,
    );
  });
  const trigger = document.querySelector(
    `button[aria-label="${messages.shell.globalCreate.ariaLabel}"]`,
  );
  assert.ok(trigger);
  await click(trigger);
  const journal = buttonsNamed(messages.shell.globalCreate.items.journal)[0];
  assert.ok(journal, "the journal choice is offered to a gl.post holder");
  await click(journal);
  assert.equal(router.pushes.at(-1), "/journal?entryNew=1&mode=edit");
  assert.deepEqual(
    calls.map((call) => call.url),
    [],
    "opening a journal allocates no draft and no number",
  );
});

test("an unsaved journal opens on its date field, writes nothing, and saves through the shortcut", async (t) => {
  const router = freshGlobals();
  const createdId = randomUUID();
  const calls = installFetch(t, (url, init) => {
    if (url === "/api/journals" && init?.method === "POST") {
      return Response.json(
        { doc: { ...DRAFT({ id: createdId, document_number: "JE-00042" }) }, lines: [] },
        { status: 201 },
      );
    }
    return null;
  });
  await mount(t, BLANK_CREATE(), { createMode: true });

  assert.deepEqual(journalPosts(calls), [], "opening the create form writes nothing");
  assert.equal(
    document.querySelector("[data-autofocus]"),
    dateInput(),
    "the entry date is the drawer's first field",
  );
  assert.ok(buttonsNamed(copy.saveAndNew)[0], "Save & new sits beside Save");

  await key(dateInput(), { code: "KeyS", key: "s", ctrlKey: true });

  const posts = journalPosts(calls);
  assert.equal(posts.length, 1, "Ctrl+S runs exactly one create");
  assert.equal(posts[0]!.url, "/api/journals");
  assert.match(
    String((posts[0]!.init?.headers as Record<string, string>)["Idempotency-Key"]),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.equal(
    router.replaces.at(-1),
    `/journal?entry=${createdId}`,
    "a plain save opens the created journal",
  );
});

test("Save & new keeps the entry date and opens a blank journal under a fresh key", async (t) => {
  const router = freshGlobals();
  const keys: string[] = [];
  const calls = installFetch(t, (url, init) => {
    if (url === "/api/journals" && init?.method === "POST") {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
      return Response.json(
        { doc: DRAFT({ document_number: `JE-0004${keys.length}` }), lines: [] },
        { status: 201 },
      );
    }
    return null;
  });
  await mount(t, BLANK_CREATE(), { createMode: true });

  await typeInto(memoInput(), "October accrual");
  assert.equal(memoInput().value, "October accrual");
  await key(dateInput(), { code: "KeyS", key: "s", ctrlKey: true, altKey: true });

  assert.equal(journalPosts(calls).length, 1, "the Save & new chord saves once");
  assert.equal(
    router.replaces.at(-1),
    "/journal?entryNew=1&mode=edit&entryDate=2026-10-14",
    "the next journal keeps the date",
  );
  assert.ok(
    (globalThis.__journalToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message === "Saved JE-00041",
    ),
  );
  assert.notEqual(dateInput().value, "", "the fresh form still shows the carried date");
  assert.equal(memoInput().value, "", "the fresh form starts blank");

  await click(buttonsNamed(copy.saveAndNew)[0]!);
  assert.equal(keys.length, 2);
  assert.notEqual(
    keys[0],
    keys[1],
    "each fresh journal mints its own idempotency key, so it cannot replay the previous one",
  );
});

test("Ctrl+Enter creates, posts on the created revision, and starts the next journal on the same date", async (t) => {
  const router = freshGlobals();
  const createdId = randomUUID();
  let postBody: Record<string, unknown> | null = null;
  const calls = installFetch(t, (url, init) => {
    if (url === "/api/journals" && init?.method === "POST") {
      return Response.json(
        { doc: DRAFT({ id: createdId, updated_at: "9" }), lines: [] },
        { status: 201 },
      );
    }
    if (url === "/api/journals/actions" && init?.method === "POST") {
      postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ ok: true, warnings: [] });
    }
    return null;
  });
  await mount(t, BLANK_CREATE(), { createMode: true, lines: ACCOUNT_LINES });

  // No amounts yet: refused up front, nothing written.
  await key(dateInput(), { code: "Enter", key: "Enter", ctrlKey: true });
  assert.deepEqual(journalPosts(calls), [], "an entry with no amounts never reaches the server");
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    new RegExp(copy.postNeedsAmounts),
  );

  await typeInto(amountInputs(0)[0]!, "250.10");
  await key(amountInputs(0)[0]!, { code: "Enter", key: "Enter", ctrlKey: true });
  assert.deepEqual(journalPosts(calls), [], "an unbalanced entry never reaches the server");
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Out of balance/);

  await typeInto(amountInputs(1)[1]!, "250.10");
  await key(amountInputs(1)[1]!, { code: "Enter", key: "Enter", ctrlKey: true });
  const writes = journalPosts(calls);
  assert.deepEqual(
    writes.map((call) => call.url),
    ["/api/journals", "/api/journals/actions"],
    "create, then the journal post action",
  );
  assert.deepEqual(
    postBody,
    { action: "post", documentId: createdId, expectedUpdatedAt: "9" },
    "the post fences on the revision the create returned",
  );
  assert.equal(router.replaces.at(-1), "/journal?entryNew=1&mode=edit&entryDate=2026-10-14");
  assert.ok(
    (globalThis.__journalToasts ?? []).some((toast) => toast.message === copy.postedAndNew),
  );
});

test("Ctrl+Enter on a journal governed by an approval flow submits it and says so", async (t) => {
  freshGlobals();
  const doc = DRAFT();
  const lines = [
    { account_id: "a1", amount: "40.00", description: "", custom: {}, extra_dims: {} },
    { account_id: "a2", amount: "-40.00", description: "", custom: {}, extra_dims: {} },
  ];
  installFetch(t, (url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET"))
      return Response.json({ doc, lines });
    if (url === "/api/journals/actions" && init?.method === "POST")
      return Response.json({ ok: true, pendingApproval: true, requestId: randomUUID() });
    return null;
  });
  await mount(t, doc, { lines });
  const dialog = document.querySelector("[role='dialog']")!;
  await key(dialog.querySelector("button") ?? dialog, {
    code: "Enter",
    key: "Enter",
    ctrlKey: true,
  });
  assert.ok(
    (globalThis.__journalToasts ?? []).some((toast) => toast.message === copy.submittedAndNew),
    "the operator learns the journal was submitted for approval, not posted",
  );
});

test("a refused post after the create commits opens the saved draft instead of losing it", async (t) => {
  const router = freshGlobals();
  const createdId = randomUUID();
  installFetch(t, (url, init) => {
    if (url === "/api/journals" && init?.method === "POST")
      return Response.json(
        { doc: DRAFT({ id: createdId, updated_at: "3" }), lines: [] },
        { status: 201 },
      );
    if (url === "/api/journals/actions")
      return Response.json({ error: "The period 2026-10 is closed." }, { status: 422 });
    return null;
  });
  await mount(t, BLANK_CREATE(), { createMode: true, lines: ACCOUNT_LINES });
  await typeInto(amountInputs(0)[0]!, "10");
  await typeInto(amountInputs(1)[1]!, "10");
  await key(amountInputs(1)[1]!, { code: "Enter", key: "Enter", ctrlKey: true });
  assert.equal(
    router.replaces.at(-1),
    `/journal?entry=${createdId}`,
    "the saved draft opens so the refusal can be resolved",
  );
  const toasts = globalThis.__journalToasts ?? [];
  assert.ok(
    toasts.some(
      (toast) => toast.kind === "error" && /period 2026-10 is closed/.test(toast.message),
    ),
    "the server's reason is shown",
  );
  assert.ok(toasts.some((toast) => toast.message === copy.savedNotPosted));
});

test("Enter on the last line appends a line pre-entered with the balancing amount, selected for overtyping", async (t) => {
  freshGlobals();
  const doc = DRAFT();
  const lines = [
    { account_id: "a1", amount: "100.00", description: "", custom: {}, extra_dims: {} },
  ];
  installFetch(t, (url, init) =>
    url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")
      ? Response.json({ doc, lines })
      : null,
  );
  await mount(t, doc, { lines, initialMode: "edit" });

  const credit = amountInputs(0)[1]!;
  await focus(credit);
  await key(credit, { key: "Enter", code: "Enter" });

  const [newDebit, newCredit] = amountInputs(1);
  assert.equal(newDebit!.value, "", "the debit side of the appended line stays empty");
  assert.equal(newCredit!.value, "100.00", "the appended line carries the exact balancing credit");
  assert.equal(
    document.activeElement,
    newCredit,
    "focus follows into the same column of the new line",
  );
  assert.equal(newCredit!.selectionStart, 0);
  assert.equal(
    newCredit!.selectionEnd,
    newCredit!.value.length,
    "the suggestion is selected so typing replaces it",
  );
  assert.match(document.body.textContent ?? "", /Balanced/);
});

test("entering the amounts of a blank line pre-enters the balancing side", async (t) => {
  freshGlobals();
  installFetch(t, () => null);
  await mount(t, BLANK_CREATE(), { createMode: true });
  await typeInto(amountInputs(0)[0]!, "75");
  // Straight into the cell that takes the suggestion.
  const credit = amountInputs(1)[1]!;
  await focus(credit);
  assert.equal(
    credit.value,
    "75.00",
    "the blank second line is pre-entered with the balancing credit",
  );
  assert.equal(credit.selectionStart, 0);
  assert.equal(
    credit.selectionEnd,
    "75.00".length,
    "the suggestion is selected so typing replaces it",
  );
  assert.equal(amountInputs(1)[0]!.value, "");

  // Leaving the cell keeps the suggestion as an ordinary amount.
  await focus(amountInputs(1)[0]!);
  assert.equal(amountInputs(1)[1]!.value, "75.00");
  assert.match(document.body.textContent ?? "", /Balanced/);

  await typeInto(amountInputs(1)[0]!, "5");
  assert.equal(amountInputs(1)[1]!.value, "", "typing the other side replaces the suggestion");
});

test("focusing a line that already holds a typed amount never replaces it", async (t) => {
  freshGlobals();
  const doc = DRAFT();
  const lines = [
    { account_id: "a1", amount: "100.00", description: "", custom: {}, extra_dims: {} },
    { account_id: "a2", amount: "-30.00", description: "", custom: {}, extra_dims: {} },
  ];
  installFetch(t, (url, init) =>
    url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")
      ? Response.json({ doc, lines })
      : null,
  );
  await mount(t, doc, { lines, initialMode: "edit" });
  await focus(amountInputs(1)[1]!);
  assert.equal(
    amountInputs(1)[1]!.value,
    "30.00",
    "a typed credit survives focus while the entry is out of balance",
  );
  assert.equal(amountInputs(1)[0]!.value, "");

  // The explicit Balance action overrides the line the operator chose.
  await click(buttonsNamed(copy.balanceLine)[0]!);
  assert.equal(
    amountInputs(1)[1]!.value,
    "100.00",
    "Balance puts the remaining difference on the focused line",
  );
  assert.equal(
    buttonsNamed(copy.balanceLine).length,
    0,
    "a balanced entry offers no Balance action",
  );
});

type GridRow = {
  debit: string;
  credit: string;
  accountId?: string;
  autoBalance?: "debit" | "credit";
  autoBalanceValue?: string;
};

test("balancing helpers use exact units and refuse to guess", () => {
  const typed: GridRow = { debit: "0.0050", credit: "", accountId: "a1" };
  const blank: GridRow = { debit: "", credit: "", accountId: "" };
  assert.deepEqual(
    balancingLeg([typed, blank], 1),
    { side: "credit", amount: "0.0050" },
    "sub-cent differences survive exactly",
  );
  assert.equal(
    balancingLeg([{ debit: "1.5", credit: "" }, { debit: "", credit: "1.50" }, blank], 2),
    null,
    "a level entry needs no suggestion",
  );
  assert.equal(
    balancingLeg([{ debit: "abc", credit: "" }, blank], 1),
    null,
    "an unreadable amount yields no suggestion",
  );

  const filled = suggestBalancingLine([typed, blank], 1);
  assert.equal(filled[1]!.credit, "0.0050");
  assert.equal(filled[1]!.autoBalance, "credit");
  const withTyped = [typed, { debit: "", credit: "9.00", accountId: "" }];
  assert.equal(
    suggestBalancingLine(withTyped, 1),
    withTyped,
    "a typed amount is never replaced by a suggestion",
  );
  const zeroTyped = [typed, { debit: "0", credit: "", accountId: "" }];
  assert.equal(
    suggestBalancingLine(zeroTyped, 1),
    zeroTyped,
    "a typed zero is the operator's value too",
  );

  // An untouched suggestion follows the entry; once the entry balances it clears.
  const moved = suggestBalancingLine([{ ...typed, debit: "2.00" }, filled[1]!], 1);
  assert.equal(moved[1]!.credit, "2.0000");
  const level = suggestBalancingLine(
    [typed, filled[1]!, { debit: "", credit: "0.0050", accountId: "a2" }],
    1,
  );
  assert.equal(level[1]!.credit, "");
  assert.equal(level[1]!.autoBalance, undefined);

  const balanced = balanceLineAt<GridRow>(
    [
      { debit: "10", credit: "" },
      { debit: "", credit: "4" },
    ],
    1,
  );
  assert.equal(balanced[1]!.credit, "10.0000");
  assert.equal(
    balanced[1]!.autoBalance,
    undefined,
    "an explicit Balance is the operator's own amount",
  );
  const unreadable = [
    { debit: "x", credit: "" },
    { debit: "", credit: "4" },
  ];
  assert.equal(balanceLineAt(unreadable, 1), unreadable);
});

test("More options stays folded for defaults and opens for any stored value", async (t) => {
  freshGlobals();
  installFetch(t, () => null);
  await mount(t, BLANK_CREATE(), { createMode: true });
  const details = () => document.querySelector<HTMLDetailsElement>("[data-journal-more-options]");
  assert.equal(
    details()?.open,
    false,
    "a new journal folds mode, currency, rate, reversal and party",
  );
  const header = document.querySelector("[role='dialog']")!.textContent ?? "";
  assert.ok(
    header.indexOf(messages.common.labels.date) < header.indexOf(copy.moreOptions),
    "Date leads the header",
  );
  assert.ok(
    header.indexOf(copy.referenceNumber) < header.indexOf(copy.moreOptions),
    "Reference leads the header",
  );
});

test("an existing journal with a party opens More options so the value is visible", async (t) => {
  freshGlobals();
  const doc = DRAFT({ party_id: "p1", party_name: "Acme Supply" });
  installFetch(t, (url, init) =>
    url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")
      ? Response.json({ doc, lines: [] })
      : null,
  );
  await mount(t, doc);
  assert.equal(
    document.querySelector<HTMLDetailsElement>("[data-journal-more-options]")?.open,
    true,
  );
});

test("non-default option detection covers every folded setting", () => {
  const base = {
    journalMode: "monetary",
    currency: "USD",
    defaultCurrency: "USD",
    fxRate: "1",
    reverseOn: "",
    partyId: "",
    accountingBookId: "",
  };
  assert.equal(journalOptionsAreNonDefault(base), false);
  assert.equal(
    journalOptionsAreNonDefault({ ...base, fxRate: "1.0000000000" }),
    false,
    "a stored unit rate is the default",
  );
  assert.equal(journalOptionsAreNonDefault({ ...base, currency: "EUR" }), true);
  assert.equal(journalOptionsAreNonDefault({ ...base, fxRate: "1.08" }), true);
  assert.equal(journalOptionsAreNonDefault({ ...base, journalMode: "statistical" }), true);
  assert.equal(journalOptionsAreNonDefault({ ...base, reverseOn: "2026-11-01" }), true);
  assert.equal(journalOptionsAreNonDefault({ ...base, partyId: "p1" }), true);
  assert.equal(journalOptionsAreNonDefault({ ...base, accountingBookId: "b1" }), true);
  assert.equal(
    freshJournalHref("/journal?journalTab=drafts", "2026-10-14"),
    "/journal?journalTab=drafts&entryNew=1&mode=edit&entryDate=2026-10-14",
  );
  assert.equal(
    freshJournalHref("/journal", ""),
    "/journal?entryNew=1&mode=edit",
    "no date is carried when none was entered",
  );
});
