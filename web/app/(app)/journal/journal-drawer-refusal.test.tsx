import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __journalToasts: { kind: string; message: string }[] | undefined;
  var __journalRouter: { push(url: string): void; refresh(): void } | undefined;
  var __journalGets: number | undefined;
}

// JournalDrawer on the shared action path. Save failures toasted without
// pinning; a stale-revision void toasted translated copy without pinning.
// Both now pin as a record-level alert until the next action AND toast, with
// busy always releasing. The stale-revision recovery (reload the canonical
// revision, say so in translated copy — ) is preserved inside the
// task: the server sentence leaks the revision-token mechanism, and the
// reload already happened, so the message must describe what happened.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/journal",
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
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__journalRouter}export function usePathname(){return '/journal'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__journalToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__journalToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__journalToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__journalToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
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
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate entry'}",
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
const { JournalDrawer, isBlankJournalLine, findMissingJournalAccountLine } = await import("./JournalDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const TOKEN = "2026-09-17T12:00:00.000000Z";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
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
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
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
  // I4-webui-377: drawer panels are pressed buttons, never role=tab.
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
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await click(menu);
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
