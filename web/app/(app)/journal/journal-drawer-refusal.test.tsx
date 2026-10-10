import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __journalToasts: { kind: string; message: string }[] | undefined;
  var __journalRouter: { push(url: string): void; refresh(): void } | undefined;
  var __journalGets: number | undefined;
  var __journalQuery: string | undefined;
}

// JournalDrawer on the shared action path. Save failures toasted without
// pinning; a stale-revision void toasted translated copy without pinning.
// Both now pin as a record-level alert until the next action AND toast, with
// busy always releasing. The stale-revision recovery (reload the canonical
// revision, say so in translated copy — ) is preserved inside the
// task: the server sentence leaks the revision-token mechanism, and the
// reload already happened, so the message must describe what happened.

// jsdom first: the drawer reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/journal", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__journalRouter}" +
      "export function usePathname(){return '/journal'}" +
      "export function useSearchParams(){return new URLSearchParams(globalThis.__journalQuery??'')}",
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

// Confirm/prompt doubles stay suffix-wired: shared components import them
// through several relative spellings plus `@/`, which one exact key cannot name.
const { registerHooks: registerConfirmHooks } = await import("node:module");
registerConfirmHooks({
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
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate entry'}",
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
const { JournalDrawer, isBlankJournalLine, findMissingJournalAccountLine } = await import("./JournalDrawer");
const { JournalEntryDrawer } = await import("./JournalEntryDrawer");
const { EntryFlyout } = await import("../reports/EntryFlyout");
const { NavigationProvider } = await import("../../../components/navigation-provider");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const TOKEN = "2026-09-17T12:00:00.000000Z";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function freshGlobals() {
  globalThis.__journalToasts = [];
  globalThis.__journalRouter = { push() {}, refresh() {} };
  globalThis.__journalGets = 0;
  globalThis.__journalQuery = undefined;
}

function snapshotBody(id: string) {
  return {
    doc: { id, updated_at: TOKEN, document_date: "2026-09-17", memo: "", reference_number: "" },
    lines: BALANCED_LINES,
  };
}

async function mountJournal(doc: Record<string, unknown>, initialMode?: string, lines: Record<string, unknown>[] = BALANCED_LINES) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <JournalDrawer
            journal={{ doc, lines } as never}
            parties={[]}
            accounts={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            initialMode={initialMode as never}
            canPost
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    rerender: async (nextDoc: Record<string, unknown>, nextLines: Record<string, unknown>[] = BALANCED_LINES) => {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <MoneyProvider currency="USD">
              <JournalDrawer
                journal={{ doc: nextDoc, lines: nextLines } as never}
                parties={[]}
                accounts={[]}
                departments={[]}
                projects={[]}
                subsidiaries={[]}
                headerDefs={[]}
                lineDefs={[]}
                canPost
              />
            </MoneyProvider>
          </NextIntlClientProvider>,
        )
        await tick()
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

const DRAFT_DOC = () => ({
  id: randomUUID(),
  kind: "journal",
  status: "draft",
  document_number: "JE-00012",
  currency: "USD",
  updated_at: TOKEN,
  document_date: "2026-09-17",
  memo: "accrual",
  total: "0.00",
});

// Balanced legs so Save/Post enable: the drawer disables both on invalid
// amounts, and a disabled button cannot prove the refusal path.
const BALANCED_LINES = [
  { account_id: "a1", amount: "100.00", description: "leg one", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "-100.00", description: "leg two", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
];

test("switching journals resets the editor without a false revision conflict", async (t) => {
  freshGlobals();
  const first = DRAFT_DOC();
  const second = { ...DRAFT_DOC(), document_number: "JE-00013", memo: "second journal" };
  const restoreFetch = scriptFetch((url) => {
    const doc = url === `/api/journals/${first.id}` ? first : url === `/api/journals/${second.id}` ? second : null;
    return doc ? Response.json({ doc, lines: BALANCED_LINES }) : null;
  });
  t.after(restoreFetch);
  const drawer = await mountJournal(first, "edit");
  t.after(drawer.unmount);
  assert.doesNotMatch(document.body.textContent ?? "", /Unsaved changes/);
  await drawer.rerender(second);
  await tick();
  assert.match(document.body.textContent ?? "", /JE-00013/);
  assert.match(document.body.textContent ?? "", /second journal/);
  assert.equal((globalThis.__journalToasts ?? []).filter((toast) => /changed after you opened it/.test(toast.message)).length, 0);
});

test("posted journal links use one native drawer with immutable ledger lines", async (t) => {
  freshGlobals();
  const doc = { ...DRAFT_DOC(), status: "posted" };
  const entryId = randomUUID();
  globalThis.__journalQuery = `journalEntry=${entryId}&txn=stale-payment`;
  const requests: string[] = [];
  let entryReads = 0;
  let deliver!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { deliver = resolve; });
  const restoreFetch = scriptFetch((url) => {
    requests.push(url);
    if (url === `/api/reports/entry/${entryId}?journal=1`) {
      entryReads += 1;
      return entryReads === 1 ? response : Response.json({ ...loadedData, sourceJournal: {
        ...loadedData.sourceJournal, doc: { ...loadedData.sourceJournal.doc, updated_at: '43', custom: { approval_reference: 'Reopened review' } },
      } });
    }
    return null;
  });
  const loadedData = {
      entry: { id: entryId, entry_number: "JE-4080", date: "2026-09-17", status: "posted", origin: "manual", subsidiary_id: "sub-1" },
      sourceJournal: { doc: { ...doc, updated_at: '42', custom: { approval_reference: "Reviewed September" } }, lines: [{ ...BALANCED_LINES[0], amount: "999.00", description: "source document line" }] },
      canPost: true,
      headerDefs: [{ id: "header-note", key: "approval_reference", label: "Approval reference", fieldType: "text", config: {}, isRequired: false }],
      lineDefs: [{ id: "line-note", key: "posting_reference", label: "Posting reference", fieldType: "text", config: {}, isRequired: false }],
      segments: [],
      lines: BALANCED_LINES.map((line, index) => ({ ...line, line_number: index + 1, memo: "immutable ledger line", account_number: String(index + 1000), account_name: `Account ${index}`, subsidiary_id: "sub-1", subsidiary: "Main entity", functional_currency: "CAD", custom: { posting_reference: "Posted evidence" } })),
  };
  t.after(restoreFetch);
  t.after(() => { globalThis.__journalQuery = undefined; });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = () => root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="USD"><NavigationProvider><JournalEntryDrawer /><EntryFlyout /></NavigationProvider></MoneyProvider></NextIntlClientProvider>);
  await act(async () => {
    render();
    await tick();
  });
  const loadingDialog = document.querySelector('[role="dialog"]');
  assert.ok(loadingDialog, "the shared drawer opens immediately while its record loads");
  assert.ok(loadingDialog.querySelector('[aria-busy="true"]'));
  const fullscreen = loadingDialog.querySelector('button[aria-label*="ull screen"], button[aria-label*="ullscreen"]') as HTMLButtonElement | null;
  assert.ok(fullscreen, "the loading shell exposes the standard drawer controls");
  await click(fullscreen);
  const fullscreenLabel = fullscreen.getAttribute('aria-label');
  await act(async () => { deliver(Response.json(loadedData)); await tick(); });
  await tick();
  assert.equal(document.querySelector('[role="dialog"]'), loadingDialog, "resolving the record must preserve the same dialog DOM node");
  assert.equal(fullscreen.getAttribute('aria-label'), fullscreenLabel, "loading must retain the chosen drawer size");
  assert.ok(buttonsNamed("Void")[0], "a current posted journal offers its lifecycle action directly in the header");
  assert.match(document.body.textContent ?? "", /Approval reference|Posting reference/);
  assert.match(document.body.textContent ?? "", /Reviewed September/);
  assert.match(document.body.textContent ?? "", /Posted evidence/);
  assert.match(document.body.textContent ?? "", /JE-4080/);
  assert.match(document.body.textContent ?? "", /immutable ledger line/);
  assert.match(document.body.textContent ?? "", /CAD/);
  assert.doesNotMatch(document.body.textContent ?? "", /999\.00/);
  assert.doesNotMatch(document.body.textContent ?? "", /source document line|Open full transaction/i);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(requests.some((url) => url.includes('stale-payment')), false);
  assert.equal(requests.some((url) => url === `/api/journals/${doc.id}`), false, "opening posted evidence does not reload editable source lines");
  await act(async () => { globalThis.__journalQuery = ''; render(); await tick(); });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await act(async () => { globalThis.__journalQuery = `journalEntry=${entryId}`; render(); await tick(); });
  assert.match(document.body.textContent ?? '', /Reopened review/, 'reopening a journal initializes from a fresh snapshot rather than a cached revision');
  assert.equal(entryReads, 2);
});

test("a refused save pins the reason instead of toasting into the void", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      globalThis.__journalGets = (globalThis.__journalGets ?? 0) + 1;
      return Response.json(snapshotBody(String(doc.id)));
    }
    if (url === `/api/journals/${doc.id}` && init?.method === "PATCH") {
      return Response.json({ error: "Out of balance by 0.01" }, { status: 422 });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc, "edit");
  t.after(unmount);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "edit mode must offer Save");
  await click(save);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the save refusal must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Out of balance/, "the alert must carry the server reason");
  const toasts = globalThis.__journalToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Out of balance/.test(toast.message)),
    "the save refusal must also toast",
  );
  assert.equal(save.disabled, false, "busy must release after the refusal");
});

test("a stale-revision void reloads and pins translated copy", async (t) => {
  freshGlobals();
  const doc = { ...DRAFT_DOC(), status: "posted" };
  let voidPayload: Record<string, unknown> | null = null;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      globalThis.__journalGets = (globalThis.__journalGets ?? 0) + 1;
      return Response.json(snapshotBody(String(doc.id)));
    }
    if (url === `/api/documents/${doc.id}/void` && init?.method === "POST") {
      voidPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json(
        { error: "Reload the document and supply its exact revision before voiding", code: "stale-revision" },
        { status: 409 },
      );
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const voidButton = buttonsNamed("Void")[0];
  assert.ok(voidButton, "a posted journal must offer Void");
  await click(voidButton);
  await tick();
  assert.deepEqual(voidPayload, { reason: "duplicate entry", expectedUpdatedAt: TOKEN });
  assert.ok(
    (globalThis.__journalGets ?? 0) >= 2,
    "the stale revision must reload the canonical snapshot behind the refusal",
  );
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the stale-revision refusal must pin as an alert");
  assert.match(
    alert.textContent ?? "",
    /changed after you opened it/,
    "the pin must render the translated recovery copy, not the revision-token mechanism",
  );
  const toasts = globalThis.__journalToasts ?? [];
  assert.equal(
    toasts.filter((toast) => toast.kind === "error").length,
    1,
    "the recovery must toast exactly once — no server-text duplicate beside the translated copy",
  );
});

test("a successful post refreshes the revision used by a later void", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const afterPostRevision = "2026-09-17T12:00:05.000000Z";
  let canonicalReads = 0;
  let voidPayload: Record<string, unknown> | null = null;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      canonicalReads += 1;
      return Response.json({
        ...snapshotBody(String(doc.id)),
        doc: { ...snapshotBody(String(doc.id)).doc, updated_at: canonicalReads === 1 ? TOKEN : afterPostRevision },
      });
    }
    if (url === "/api/journals/actions" && init?.method === "POST") return Response.json({});
    if (url === `/api/documents/${doc.id}/void` && init?.method === "POST") {
      voidPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ status: "voided" });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({ approvalState: { status: "none", pendingWith: [], myActions: null }, history: [], failedRun: null, canRetry: false, neverSubmitted: true });
    }
    return null;
  });
  t.after(restoreFetch);
  const drawer = await mountJournal(doc);
  t.after(drawer.unmount);

  await click(buttonsNamed("Actions")[0]!);
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "a draft journal offers Post");
  await click(post);
  assert.equal(canonicalReads, 2, "a successful post reads the new canonical revision");

  await drawer.rerender({ ...doc, status: "posted" });
  await click(buttonsNamed("Actions")[0]!);
  const voidButton = buttonsNamed("Void")[0];
  assert.ok(voidButton, "the posted journal offers Void");
  await click(voidButton);
  assert.equal((voidPayload as Record<string, unknown> | null)?.expectedUpdatedAt, afterPostRevision);
});

test("a posted journal keeps uploads available and explains why its evidence stays attached", async (t) => {
  freshGlobals();
  const doc = { ...DRAFT_DOC(), status: "posted" };
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith("/api/file-cabinet/attachments?")) {
      return Response.json({ attachments: [{
        id: "file-1",
        name: "bank-statement.pdf",
        fileType: "pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        createdAt: "2026-09-17T12:00:00.000Z",
        createdBy: null,
        attachmentId: "attachment-1",
      }] });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({ approvalState: { status: "none", pendingWith: [], myActions: null }, history: [], failedRun: null, canRetry: false, neverSubmitted: true });
    }
    if (url === `/api/journals/${doc.id}`) return Response.json(snapshotBody(String(doc.id)));
    return null;
  });
  t.after(restoreFetch);
  const drawer = await mountJournal(doc);
  t.after(drawer.unmount);
  // Drawer panels are pressed buttons, never role=tab.
  const attachments = buttonsNamed("Attachments")[0];
  assert.ok(attachments, "a persisted journal has an Attachments tab");
  await click(attachments as HTMLButtonElement);
  await tick();

  assert.match(document.body.textContent ?? "", /bank-statement\.pdf/);
  assert.match(document.body.textContent ?? "", /Attachments of posted records are retained and cannot be removed\./);
  assert.ok(buttonsNamed("Add files").length > 0, "posted evidence can still be supplemented");
  assert.ok(document.querySelector('input[type="file"]'), "the upload control remains available");
  assert.equal(document.querySelector('button[aria-label="Remove bank-statement.pdf"]'), null);
});

test("a post warning names partyless control accounts in a persistent alert", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) return Response.json(snapshotBody(String(doc.id)));
    if (url === "/api/journals/actions" && init?.method === "POST") {
      return Response.json({ warnings: [{ code: "partyless_control_lines", accounts: [{ number: "1100", name: "Accounts receivable" }] }] });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({ approvalState: { status: "none", pendingWith: [], myActions: null }, history: [], failedRun: null, canRetry: false, neverSubmitted: true });
    }
    return null;
  });
  t.after(restoreFetch);
  const drawer = await mountJournal(doc);
  t.after(drawer.unmount);
  await click(buttonsNamed("Actions")[0]!);
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "a draft journal offers Post");
  await click(post);

  const warning = document.querySelector('[role="alert"]');
  assert.ok(warning, "a partyless-control warning stays visible after the success toast");
  assert.match(warning.textContent ?? "", /1100 Accounts receivable/);
  assert.match(warning.textContent ?? "", /outside any customer or vendor subledger/);
});

test("a refused post still pins the server reason ( preservation)", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      return Response.json(snapshotBody(String(doc.id)));
    }
    if (url === "/api/journals/actions" && init?.method === "POST") {
      return Response.json({ error: "No open period covers September" }, { status: 422 });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc);
  t.after(unmount);
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "a draft journal must offer Post");
  await click(post);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the post refusal must pin as an alert");
  assert.match(alert.textContent ?? "", /No open period/, "the alert must carry the server reason");
});

const blankJournalRow = () => ({
  accountId: "",
  description: "",
  partyId: "",
  departmentId: "",
  projectId: "",
  subsidiaryId: "",
  debit: "",
  credit: "",
});

test("only a truly blank journal row is blank", () => {
  assert.equal(isBlankJournalLine(blankJournalRow()), true);
  assert.equal(isBlankJournalLine({ debit: "", credit: "" }), true);
  // An exact zero leg carries no financial meaning: it counts as empty, so
  // a leg that is genuinely empty or zero still drops.
  assert.equal(isBlankJournalLine({ ...blankJournalRow(), debit: "0.0000" }), true);
  assert.equal(isBlankJournalLine({ ...blankJournalRow(), credit: "0" }), true);
});

test("any journal content makes the row non-blank — even without an account", () => {
  for (const content of [
    { accountId: "a1", debit: "100" },
    { debit: "100" },
    { credit: "50" },
    { description: "mystery leg" },
    { partyId: "p1" },
    { cf_note: "keep me" },
  ]) {
    assert.equal(isBlankJournalLine({ ...blankJournalRow(), ...content }), false, JSON.stringify(content));
  }
});

test("the missing-account probe names the first contentful account-less journal row", () => {
  assert.equal(findMissingJournalAccountLine([blankJournalRow()]), null);
  assert.deepEqual(
    findMissingJournalAccountLine([
      { ...blankJournalRow(), accountId: "a1", debit: "100" },
      { ...blankJournalRow(), description: "mystery leg", debit: "100" },
      blankJournalRow(),
    ]),
    { index: 1, lineNumber: 2 },
  );
});

test("a contentful account-less journal leg survives to the save payload ( guard)", () => {
  const rows = [
    { ...blankJournalRow(), accountId: "a1", debit: "100" },
    { ...blankJournalRow(), description: "mystery leg", debit: "100" },
    { ...blankJournalRow(), accountId: "a2", credit: "200" },
    blankJournalRow(),
  ];
  const payload = rows.filter((r) => !isBlankJournalLine(r));
  assert.equal(payload.length, 3);
  assert.deepEqual(findMissingJournalAccountLine(rows)?.lineNumber, 2);
});

// A balanced journal whose second debit leg names no account: debits 200,
// credits 200, so Save enables and the refusal path — not the balance gate —
// is what must fire.
const ACCOUNTLESS_LINES = [
  { account_id: "a1", amount: "100.00", description: "leg one", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "", amount: "100.00", description: "mystery leg", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "-200.00", description: "leg three", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
];

test(" journal: saving with a contentful account-less leg refuses by line name and keeps the row", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const writes: string[] = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      return Response.json({
        doc: { id: doc.id, updated_at: TOKEN, document_date: "2026-09-17", memo: "", reference_number: "" },
        lines: ACCOUNTLESS_LINES,
      });
    }
    if (url === `/api/journals/${doc.id}` && init?.method === "PATCH") {
      writes.push(`${init.method} ${url}`);
      return Response.json({ error: "should never be reached" }, { status: 500 });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc, "edit", ACCOUNTLESS_LINES);
  t.after(unmount);
  // The footer prices the account-less $100 leg: debits read 200, not 100.
  assert.match(document.body.textContent ?? "", /200/, "the footer must include the account-less leg");
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "a balanced journal must offer an enabled Save");
  assert.equal(save.disabled, false, "Save must enable on balanced legs so the refusal path is what fires");
  await click(save);
  await tick();
  assert.deepEqual(writes, [], "no journal write may fire while a contentful leg has no account");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the missing account must pin as an alert, not only toast");
  assert.match(alert.textContent ?? "", /Line 2: choose an account/, "the refusal must name the grid line and the remedy");
  const toasts = globalThis.__journalToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error" && /Line 2/.test(toast.message)),
    "the missing account must also toast with the line named",
  );
  // The entered leg stays in state: the footer still reads 200 debits.
  assert.match(document.body.textContent ?? "", /200/, "the refused leg must stay in the drawer with its amount priced");
  assert.equal(save.disabled, false, "busy must release after the refusal");
});

test("deleting a draft journal sends the revision fence with the delete", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const seen: { body: unknown }[] = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && init?.method === "DELETE") {
      seen.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc, "edit");
  t.after(unmount);
  const del = buttonsNamed("Delete")[0];
  assert.ok(del, "a draft journal offers Delete");
  await click(del);
  assert.equal(seen.length, 1, "the delete reaches the API once");
  assert.deepEqual(seen[0]?.body, { expectedUpdatedAt: TOKEN }, "the concurrency fence rides along");
});

test("a posted partyless journal names its control accounts, never undefined", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/journals/actions" && init?.method === "POST") {
      return Response.json({
        pendingApproval: false,
        warnings: [
          {
            code: "partyless_control_lines",
            accounts: [
              { accountId: "a1", accountNumber: "1100", accountName: "Receivables", amount: "100.00" },
              { accountId: "a2", accountNumber: null, accountName: "Payables", amount: "-100.00" },
            ],
          },
        ],
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountJournal(doc, "edit");
  t.after(unmount);
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "a balanced draft journal offers Post");
  await click(post);
  await tick();
  const text = document.body.textContent ?? "";
  assert.match(text, /Posted with no party on 1100 Receivables, Payables/);
  assert.doesNotMatch(text, /undefined/);
});
