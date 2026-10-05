import assert from "node:assert/strict";
import test from "node:test";
import { isUuid } from "@/lib/list-params";

// jsdom first: the workspace reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/banking/psp-settlements", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
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
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { PspSettlementsWorkspace } = await import("./sections");
import type { PspSettlementRow, PspSubsidiaryOption } from "./sections";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const STRINGS = {
  acceptanceNote: "Settlements reconcile payouts after the fact.",
  acceptanceLink: "Company Settings → Payment Providers",
  importTitle: "Import settlement",
  providerLabel: "Provider",
  externalRef: "External ref / payout id",
  settlementDate: "Settlement date",
  bankAccountId: "Receipt bank account",
  bankAccountHint: "The bank account the provider payout lands in. Required before posting.",
  feeAccountId: "Processing-fee account",
  feeAccountHint: "The expense account for provider processing fees. Required before posting.",
  clearingAccountId: "Provider clearing account",
  clearingAccountHint: "The clearing account holding provider receivables until payout. Required before posting.",
  subsidiaryLabel: "Subsidiary",
  noneLabel: "None",
  payloadShapeHint: "Each row needs id, type, amount, fee, net and currency.",
  genericPayloadHint: "One JSON object for a single settlement.",
  accountPlaceholder: "Select an account…",
  uploadPayload: "Upload JSON",
  invalidStripePayload: "Stripe payload must be a JSON array of balance transactions.",
  invalidGenericPayload: "This provider payload must be a single JSON object, not an array.",
  importDraft: "Import draft",
  recentBatches: "Recent batches",
  reversalDate: "Reversal date",
  reversalReason: "Reversal reason",
  reversalPlaceholder: "Required evidence for a controlled correction",
  colProvider: "Provider",
  colNet: "Net",
  colFx: "FX",
  filterProviderLabel: "Provider",
  filterAllProviders: "All providers",
  reviewLinkLabel: "Review refunds and disputes",
  reviewsHref: "/banking/psp-settlements/reviews",
  reviewPending: "1 awaiting review",
  reverse: "Reverse",
  empty: "No settlements imported yet.",
  referenceLabel: "Reference",
  dateLabel: "Date",
  statusLabel: "Status",
  postLabel: "Post",
  loadingLabel: "Loading…",
  loadFailedLabel: "Could not load settlements.",
  retryLabel: "Retry",
};

const ACCOUNTS = [
  { id: "11111111-1111-1111-1111-111111111111", label: "1000 · Operating Cash" },
  { id: "22222222-2222-2222-2222-222222222222", label: "6100 · Processing Fees" },
  { id: "33333333-3333-3333-3333-333333333333", label: "1150 · PSP Clearing" },
];

const ROWS: PspSettlementRow[] = [
  {
    id: "d0000000-0000-0000-0000-000000000001",
    provider: "stripe",
    providerLabel: "Stripe",
    externalRef: "po_draft",
    settlementDate: "Sep 20, 2026",
    currency: "USD",
    netAmount: "$100.00",
    fxAmount: null,
    disputeBadge: null,
    sourceCurrency: null,
    statusLabel: "Draft",
    status: "draft",
  },
  {
    id: "d0000000-0000-0000-0000-000000000002",
    provider: "stripe",
    providerLabel: "Stripe",
    externalRef: "po_posted",
    settlementDate: "Sep 21, 2026",
    currency: "USD",
    netAmount: "$200.00",
    fxAmount: null,
    disputeBadge: null,
    sourceCurrency: null,
    statusLabel: "Posted",
    status: "posted",
  },
  {
    id: "d0000000-0000-0000-0000-000000000003",
    provider: "paypal",
    providerLabel: "PayPal",
    externalRef: "week-34",
    settlementDate: "Sep 22, 2026",
    currency: "USD",
    netAmount: "$95.00",
    fxAmount: "$1.20",
    disputeBadge: "Disputes $45.00",
    sourceCurrency: "EUR",
    statusLabel: "Posted",
    status: "posted",
  },
];

async function mount(options?: { canReconcile?: boolean; rows?: typeof ROWS; subsidiaries?: PspSubsidiaryOption[] }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-23">
            <PspSettlementsWorkspace
              canReconcile={options?.canReconcile ?? true}
              strings={STRINGS}
              initialRows={options?.rows ?? []}
              initialSubsidiaries={options?.subsidiaries ?? []}
              initialAccounts={ACCOUNTS}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

test("PSP reversal fields are associated with their visible labels", async (t) => {
  const { host, root } = await mount({ canReconcile: true, rows: ROWS });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  for (const name of [STRINGS.reversalDate, STRINGS.reversalReason]) {
    const label = [...host.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === name);
    assert.ok(label, `${name} label renders`);
    assert.ok(label.control, `${name} label controls its input`);
  }
});

function setNativeValue(element: HTMLElement, value: string) {
  const prototype = element instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

async function importClick(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === STRINGS.importDraft,
  ) as HTMLButtonElement;
  assert.ok(button, "the import button must render");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  return button;
}

/** Open a house picker by its trigger id and choose the named option. The
 * menu portals to the document body, so options are read off `document`. */
async function chooseAccount(triggerId: string, optionLabel: string) {
  const trigger = document.getElementById(triggerId) as HTMLButtonElement;
  assert.ok(trigger, `picker trigger ${triggerId} must render`);
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  const option = [...document.querySelectorAll('button[role="option"]')].find(
    (candidate) => candidate.textContent?.includes(optionLabel),
  ) as HTMLButtonElement | undefined;
  assert.ok(option, `the picker must offer a named ${optionLabel} option`);
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
}

/** : the import form offers named house account pickers, not raw UUID
 * text inputs, with each account's posting role explained beside it. */
test("settlement accounts render as labelled pickers with posting hints", async (t) => {
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  assert.equal(
    host.querySelector('input[placeholder="UUID"]'),
    null,
    "no raw UUID text input may remain on the import form",
  );
  for (const [id, label] of [
    ["psp-bank-account", STRINGS.bankAccountId],
    ["psp-fee-account", STRINGS.feeAccountId],
    ["psp-clearing-account", STRINGS.clearingAccountId],
  ] as const) {
    const labelled = host.querySelector(`label[for="${id}"]`);
    assert.ok(labelled, `${id} must have an associated label`);
    assert.equal(labelled.textContent, label);
  }
  for (const hint of [STRINGS.bankAccountHint, STRINGS.feeAccountHint, STRINGS.clearingAccountHint]) {
    assert.ok(host.textContent?.includes(hint), `the form must explain: ${hint}`);
  }
  // The closed pickers show the empty state; opening one lists named
  // accounts plus the empty option — never bare UUIDs.
  const trigger = document.getElementById("psp-bank-account") as HTMLButtonElement;
  assert.ok(trigger, "the bank picker trigger must render");
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  const options = [...document.querySelectorAll('button[role="option"]')];
  assert.equal(options.length, 4, "the picker must list the empty option plus three named accounts");
  assert.ok(
    options.some((candidate) => candidate.textContent?.includes("1000 · Operating Cash")),
    "the picker must name the operating cash account",
  );
  assert.ok(
    options.every((candidate) => !isUuid(candidate.textContent?.trim() ?? "")),
    "no option may render a bare UUID",
  );
});

/** : a Stripe object payload is refused by name before any POST — the
 * provider settles an array, and the operator learns the expected shape. */
test("a stripe object payload is refused by name without posting", async (t) => {
  let fetched = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched += 1;
    return Response.json({ batchId: "batch-1" }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  setNativeValue(host.querySelector("#psp-external-ref") as HTMLElement, "po_123");
  setNativeValue(host.querySelector("#psp-payload") as HTMLElement, '{"id":"po_123"}');
  await tick();
  await importClick(host);
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the shape refusal must surface as a row alert");
  assert.match(alert.textContent ?? "", /JSON array of balance transactions/);
  assert.equal(fetched, 0, "a mis-shaped payload must never reach the API");
});

/** : a well-shaped import posts the same stored body as before — UUID
 * account references, provider payload keying, no new fields. */
test("a well-shaped stripe array posts the unchanged stored body", async (t) => {
  // The successful import reloads the list (a bodyless GET): only POSTed
  // bodies count toward the stored-shape assertion.
  const seen: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === "string") seen.push(JSON.parse(init.body));
    return Response.json({ batchId: "batch-1", batches: [], subsidiaries: [] }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  // Pick the receipt account by NAME through the house picker: the stored
  // body must still carry its UUID.
  await chooseAccount("psp-bank-account", "1000 · Operating Cash");
  assert.match(
    (document.getElementById("psp-bank-account") as HTMLButtonElement).textContent ?? "",
    /1000 · Operating Cash/,
    "the closed picker must show the chosen account name",
  );
  setNativeValue(host.querySelector("#psp-external-ref") as HTMLElement, "po_123");
  setNativeValue(host.querySelector("#psp-payload") as HTMLElement, "[]");
  await tick();
  await importClick(host);
  assert.equal(seen.length, 1, "the valid import must POST once");
  assert.deepEqual(seen[0], {
    action: "import",
    provider: "stripe",
    externalRef: "po_123",
    settlementDate: "2026-09-23",
    bankAccountId: "11111111-1111-1111-1111-111111111111",
    payoutId: "po_123",
    transactions: [],
  });
});

test("multi-entity imports require and post the selected subsidiary with provider guidance", async (t) => {
  const subsidiary = { id: "sub-north", name: "North Division", baseCurrency: "USD" };
  const bodies: Record<string, unknown>[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    return Response.json({ batchId: "batch-sub", batches: [], subsidiaries: [subsidiary] }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount({ subsidiaries: [subsidiary] });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();

  assert.ok(host.textContent?.includes(STRINGS.payloadShapeHint), "Stripe guidance must preserve the external row shape");
  const provider = host.querySelectorAll("select")[0]!;
  await act(async () => setSelectValue(provider, "recurly"));
  await tick();
  assert.ok(host.textContent?.includes(STRINGS.genericPayloadHint), "non-Stripe providers receive generic object guidance");
  await act(async () => {
    setSelectValue(provider, "stripe");
    setNativeValue(host.querySelector("#psp-external-ref") as HTMLElement, "po_multi");
    setNativeValue(host.querySelector("#psp-payload") as HTMLElement, "[]");
  });
  await tick();

  const importButton = [...host.querySelectorAll("button")].find((button) => button.textContent === STRINGS.importDraft) as HTMLButtonElement;
  assert.ok(importButton.disabled, "a multi-entity draft must not be created without a posting subsidiary");
  const subsidiarySelect = [...host.querySelectorAll("select")].find((select) =>
    [...select.options].some((option) => option.value === subsidiary.id),
  );
  assert.ok(subsidiarySelect, "the loader-provided subsidiary must be available to select");
  await act(async () => setSelectValue(subsidiarySelect, subsidiary.id));
  await tick();
  assert.equal(importButton.disabled, false, "choosing the posting subsidiary enables import");
  await act(async () => { importButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await tick();
  await tick();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.subsidiaryId, subsidiary.id, "the chosen legal entity must be part of the imported draft");
});

/** The provider filter narrows the batch list without hiding the import form:
 * choosing PayPal leaves only the PayPal batch visible. */
test("the provider filter narrows batches to the chosen provider", async (t) => {
  const { host, root } = await mount({ canReconcile: true, rows: ROWS });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });
  await tick();
  assert.ok(host.textContent?.includes("po_posted"), "both providers render before filtering");
  assert.ok(host.textContent?.includes("week-34"), "both providers render before filtering");
  // The house Select renders its trigger button under the id and the genuine
  // native select under the same name: drive the native control.
  const filter = host.querySelector('select[name="psp-provider-filter"]') as HTMLSelectElement;
  assert.ok(filter, "the provider filter must render");
  await act(async () => setSelectValue(filter, "paypal"));
  await tick();
  assert.ok(!host.textContent?.includes("po_posted"), "Stripe batches hide under the PayPal filter");
  assert.ok(host.textContent?.includes("week-34"), "the PayPal batch stays under the PayPal filter");
});

/** A batch carrying dispute activity wears the dispute badge with its amount;
 * batches without disputes render no badge. */
test("dispute activity renders as a named badge on the batch", async (t) => {
  const { host, root } = await mount({ canReconcile: true, rows: ROWS });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });
  await tick();
  const badges = [...host.querySelectorAll("div")].filter((candidate) =>
    candidate.textContent === "Disputes $45.00",
  );
  assert.equal(badges.length, 1, "exactly the disputed batch wears the dispute badge");
});

/** The review queue link names the pending count so the operator knows work
 * is waiting before opening it. */
test("the review queue link carries the pending count", async (t) => {
  const { host, root } = await mount({ canReconcile: false, rows: ROWS });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });
  await tick();
  // The next/link stub renders children without an anchor, so the link is
  // asserted by its label; the href stays loader-resolved through reviewsHref.
  assert.ok(host.textContent?.includes(STRINGS.reviewLinkLabel), "read-only operators still reach the review queue");
  assert.ok(host.textContent?.includes("1 awaiting review"), "the pending count must render beside the link");
});

/** A Shopify payout import posts the payout and its balance transactions, not
 * a Stripe-shaped body. */
test("a shopify payout posts payout and transactions", async (t) => {
  const seen: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === "string") seen.push(JSON.parse(init.body));
    return Response.json({ batchId: "batch-1", batches: [], subsidiaries: [] }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  const provider = host.querySelectorAll("select")[0]!;
  await act(async () => setSelectValue(provider, "shopify_payments"));
  await tick();
  setNativeValue(host.querySelector("#psp-external-ref") as HTMLElement, "payout-9");
  setNativeValue(
    host.querySelector("#psp-payload") as HTMLElement,
    '{"payout":{"id":"payout-9","currency":"USD"},"transactions":[{"id":"t1","type":"charge","amount":"104.50"}]}',
  );
  await tick();
  await importClick(host);
  assert.equal(seen.length, 1, "the valid import must POST once");
  assert.deepEqual(seen[0], {
    action: "import",
    provider: "shopify_payments",
    externalRef: "payout-9",
    settlementDate: "2026-09-23",
    payout: { id: "payout-9", currency: "USD" },
    transactions: [{ id: "t1", type: "charge", amount: "104.50" }],
  });
});

/** Pasted PayPal CSV (not JSON) posts as settlement-report text under the
 * operator's reference. */
test("pasted paypal csv posts report text instead of json", async (t) => {
  const seen: unknown[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === "string") seen.push(JSON.parse(init.body));
    return Response.json({ batchId: "batch-1", batches: [], subsidiaries: [] }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  const provider = host.querySelectorAll("select")[0]!;
  await act(async () => setSelectValue(provider, "paypal"));
  await tick();
  setNativeValue(host.querySelector("#psp-external-ref") as HTMLElement, "stl-august");
  setNativeValue(host.querySelector("#psp-payload") as HTMLElement, "Transaction ID,Event Code\ntxn-1,T0000\n");
  await tick();
  await importClick(host);
  assert.equal(seen.length, 1, "the valid import must POST once");
  assert.deepEqual(seen[0], {
    action: "import",
    provider: "paypal",
    externalRef: "stl-august",
    settlementDate: "2026-09-23",
    csv: "Transaction ID,Event Code\ntxn-1,T0000\n",
  });
});

/** A half-filled foreign-currency section is refused naming the missing
 * fields before any POST — a rate the operator never typed must never post. */
test("half-filled fx evidence is refused before posting", async (t) => {
  let fetched = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched += 1;
    return Response.json({ batchId: "batch-1" }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount();
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  setNativeValue(host.querySelector("#psp-external-ref") as HTMLElement, "po_123");
  setNativeValue(host.querySelector("#psp-payload") as HTMLElement, "[]");
  setNativeValue(host.querySelector("#psp-fx-rate") as HTMLElement, "1.0842");
  await tick();
  await importClick(host);
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the fx refusal must surface as a row alert");
  assert.match(alert.textContent ?? "", /payout currency|rate source/i);
  assert.equal(fetched, 0, "half-evidenced fx must never reach the API");
});

/** Opening a batch renders its reconciliation (gross, fees, refunds,
 * disputes, adjustments, FX, net) with the evidence lines beneath. */
test("settlement detail shows the reconciliation with its lines", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("batchId=")) {
      return Response.json(
        {
          batch: {
            id: "d0000000-0000-0000-0000-000000000003",
            provider: "paypal",
            externalRef: "week-34",
            status: "posted",
            currency: "USD",
            sourceCurrency: "EUR",
            conversionRate: "1.0842",
            conversionRateSource: "PayPal export",
            payoutRate: null,
            payoutRateSource: null,
            grossAmount: "140.0000",
            feeAmount: "1.7500",
            refundAmount: "0.0000",
            disputeAmount: "45.0000",
            adjustmentAmount: "0.0000",
            fxAmount: "1.2000",
            netAmount: "95.0000",
            settlementDate: "2026-09-22",
            journalEntryId: null,
            memo: null,
            lineCount: 2,
          },
          lines: [
            { lineNumber: 1, kind: "charge", externalRef: "txn-1", description: "PayPal T0000", amount: "140.0000", currency: "USD", documentId: null, documentKind: null, documentNumber: null },
            { lineNumber: 2, kind: "dispute", externalRef: "txn-9", description: "PayPal T2000", amount: "45.0000", currency: "USD", documentId: null, documentKind: null, documentNumber: null },
          ],
        },
        { status: 200 },
      );
    }
    return Response.json({ batches: [], subsidiaries: [] }, { status: 200 });
  }) as typeof fetch;
  const { host, root } = await mount({ canReconcile: true, rows: ROWS });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = prior;
  });
  await tick();
  const opener = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "week-34",
  ) as HTMLButtonElement;
  assert.ok(opener, "the batch reference must open its reconciliation");
  await act(async () => {
    opener.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  // The detail drawer portals to the document body, outside the mount host.
  const body = document.body.textContent ?? "";
  assert.ok(body.includes("PayPal T0000"), "the evidence lines render beneath the totals");
  assert.ok(body.includes("PayPal T2000"), "dispute lines render with their provider description");
});

/** Receipt and invoice lines address their record drawers; provider-only
 * lines have no record. (The file's next/link stub renders children without
 * anchors, so the address logic is asserted directly.) */
test("settlement lines address the invoice and receipt drawers", async () => {
  const { settlementDocumentHref } = await import("./sections");
  assert.equal(
    settlementDocumentHref({ documentId: "d0000000-0000-0000-0000-000000000011", documentKind: "customer_invoice", documentNumber: "INV-1" }),
    "/ar/invoices?doc=d0000000-0000-0000-0000-000000000011",
  );
  assert.equal(
    settlementDocumentHref({ documentId: "d0000000-0000-0000-0000-000000000012", documentKind: "customer_payment", documentNumber: "RCPT-1" }),
    "/receipts?payment=d0000000-0000-0000-0000-000000000012",
  );
  assert.equal(
    settlementDocumentHref({ documentId: null, documentKind: null, documentNumber: null }),
    null,
  );
  assert.equal(
    settlementDocumentHref({ documentId: "d0000000-0000-0000-0000-000000000013", documentKind: "charge", documentNumber: "txn-9" }),
    null,
  );
});

/** F1T-9: every import/post/reverse mutation POSTs with banking.reconcile,
 * so a read-only operator must not see the import form or the row buttons —
 * only the batch list. Companion: the permitted path still offers all three
 * mutations. */
for (const [name, canReconcile, present] of [
  ["read-only operators see batches but no import, post or reverse affordances", false, false],
  ["reconcile operators keep the import, post and reverse affordances", true, true],
] as Array<[string, boolean, boolean]>) {
  test(name, async (t) => {
    const { host, root } = await mount({ canReconcile, rows: ROWS });
    t.after(async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    });
    await tick();
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
    const verb = present ? "render with" : "stay hidden without";
    assert.equal(buttons.includes(STRINGS.importDraft), present, `the import button must ${verb} banking.reconcile`);
    assert.equal(buttons.includes(STRINGS.postLabel), present, `the post button must ${verb} banking.reconcile`);
    assert.equal(buttons.includes(STRINGS.reverse), present, `the reverse button must ${verb} banking.reconcile`);
    if (!present) {
      assert.ok(host.textContent?.includes("po_draft"), "the draft batch row must still render");
      assert.ok(host.textContent?.includes("po_posted"), "the posted batch row must still render");
    }
  });
}
