import assert from "node:assert/strict";
import test from "node:test";
import { isUuid } from "@/lib/list-params";

// jsdom first: the workspace reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/banking/psp-settlements",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
// SearchSelect measures its trigger through matchMedia; jsdom has none.
if (typeof dom.window.matchMedia !== "function") {
  const stub = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  dom.window.matchMedia = stub as unknown as typeof window.matchMedia;
  globals.matchMedia = stub;
}

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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
    providerLabel: "Stripe",
    externalRef: "po_draft",
    settlementDate: "Sep 20, 2026",
    netAmount: "$100.00",
    statusLabel: "Draft",
    status: "draft",
  },
  {
    id: "d0000000-0000-0000-0000-000000000002",
    providerLabel: "Stripe",
    externalRef: "po_posted",
    settlementDate: "Sep 21, 2026",
    netAmount: "$200.00",
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

/** UX-18: the import form offers named house account pickers, not raw UUID
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

/** UX-18: a Stripe object payload is refused by name before any POST — the
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

/** UX-18: a well-shaped import posts the same stored body as before — UUID
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

/** F1T-9: every import/post/reverse mutation POSTs with banking.reconcile,
 * so a read-only operator must not see the import form or the row buttons —
 * only the batch list. */
test("read-only operators see batches but no import, post or reverse affordances", async (t) => {
  const { host, root } = await mount({ canReconcile: false, rows: ROWS });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(!buttons.includes(STRINGS.importDraft), "the import button must stay hidden without banking.reconcile");
  assert.ok(!buttons.includes(STRINGS.postLabel), "the post button must stay hidden without banking.reconcile");
  assert.ok(!buttons.includes(STRINGS.reverse), "the reverse button must stay hidden without banking.reconcile");
  assert.ok(host.textContent?.includes("po_draft"), "the draft batch row must still render");
  assert.ok(host.textContent?.includes("po_posted"), "the posted batch row must still render");
});

/** F1T-9 companion: the permitted path still offers all three mutations. */
test("reconcile operators keep the import, post and reverse affordances", async (t) => {
  const { host, root } = await mount({ canReconcile: true, rows: ROWS });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await tick();
  const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(buttons.includes(STRINGS.importDraft), "the import button must render with banking.reconcile");
  assert.ok(buttons.includes(STRINGS.postLabel), "the post button must render with banking.reconcile");
  assert.ok(buttons.includes(STRINGS.reverse), "the reverse button must render with banking.reconcile");
});
