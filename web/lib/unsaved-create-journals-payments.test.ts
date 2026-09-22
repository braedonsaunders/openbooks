import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Canonical unsaved-create contract, Journals + Payments slice (customer
// receipts + vendor payments).
//
// New buttons open URL-controlled unsaved editable drawers (?entryNew=1 /
// ?paymentNew=1, draft by default, kind fixed by the entry surface).
// Open/cancel perform zero database writes and allocate no sequence or
// document number. Explicit Save is the first write: one idempotent audited
// POST to the collection endpoint. The instant-into-draft flow is gone from
// every caller this slice owns.
//
// web/components/global-create-menu.tsx is OUT of this slice (parent-owned):
// it still mints drafts, so the draft endpoints stay until the parent
// rewires those three actions to the hrefs below and deletes the routes. The
// paired assertion at the bottom names that handoff — it fails the moment
// the menu stops referencing drafts, which is the signal to delete them.

const ROOT = process.cwd();

function src(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

const JOURNAL_BUTTON = "web/app/(app)/journal/NewJournalButton.tsx";
const PAYMENT_BUTTON = "web/app/(app)/payments/NewPaymentButton.tsx";
const JOURNAL_DRAWER = "web/app/(app)/journal/JournalDrawer.tsx";
const PAYMENT_DRAWER = "web/app/(app)/payments/PaymentDrawer.tsx";
const JOURNAL_VIEW = "web/app/(app)/journal/view.ts";
const PAYMENTS_SECTION = "web/app/(app)/payments/PaymentsSection.tsx";
const JOURNALS_ROUTE = "web/app/api/journals/route.ts";
const PAYMENTS_ROUTE = "web/app/api/payments/route.ts";
const JOURNALS_DRAFT_ROUTE = "web/app/api/journals/draft/route.ts";
const PAYMENTS_DRAFT_ROUTE = "web/app/api/payments/draft/route.ts";
const GLOBAL_MENU = "web/components/global-create-menu.tsx";

const SLICE_CALLERS = [
  JOURNAL_BUTTON,
  PAYMENT_BUTTON,
  JOURNAL_DRAWER,
  PAYMENT_DRAWER,
  JOURNAL_VIEW,
  PAYMENTS_SECTION,
  JOURNALS_ROUTE,
  PAYMENTS_ROUTE,
];

test("no caller in this slice mints instant drafts", () => {
  for (const file of SLICE_CALLERS) {
    const body = src(file);
    assert.doesNotMatch(
      body,
      /api\/journals\/draft/,
      `${file} must not reference the journals draft endpoint`,
    );
    assert.doesNotMatch(
      body,
      /api\/payments\/draft/,
      `${file} must not reference the payments draft endpoint`,
    );
  }
  // The scanner above is not vacuous: the allowlisted owners still reference
  // the draft endpoints, and the scanner sees them.
  assert.match(src(GLOBAL_MENU), /api\/journals\/draft/);
  assert.match(src(GLOBAL_MENU), /api\/payments\/draft/);
  assert.match(src(JOURNALS_DRAFT_ROUTE), /createDraftJournal/);
  assert.match(src(PAYMENTS_DRAFT_ROUTE), /createPaymentDocument/);
});

test("new buttons open URL-controlled unsaved drawers with zero writes", () => {
  const journal = src(JOURNAL_BUTTON);
  assert.match(journal, /entryNew: '1'/, "journal button must open ?entryNew=1");
  assert.doesNotMatch(journal, /fetch\(/, "journal button must perform zero writes on open");

  const payment = src(PAYMENT_BUTTON);
  assert.match(payment, /paymentNew: '1'/, "payment button must open ?paymentNew=1");
  assert.doesNotMatch(payment, /fetch\(/, "payment button must perform zero writes on open");
});

test("loaders serve the unsaved drawer only to permitted roles, draft by default", () => {
  const journal = src(JOURNAL_VIEW);
  assert.match(
    journal,
    /pickString\(sp\.entryNew\) === '1' && can\(authz, 'gl\.post'\)/,
    "journal loader must gate ?entryNew=1 on the posting grant",
  );
  assert.match(journal, /status: 'draft'/, "journal loader must default the unsaved record to draft");
  assert.match(journal, /document_number: null/, "journal loader must not allocate a document number on open");
  assert.match(journal, /createMode/, "journal loader must hand the drawer its create mode");
  assert.match(journal, /closeHref/, "journal loader must hand the drawer its list return URL");

  const payments = src(PAYMENTS_SECTION);
  assert.match(
    payments,
    /pickString\(sp\.paymentNew\) === '1' && canManage/,
    "payments loader must gate ?paymentNew=1 on the manage grant",
  );
  assert.match(payments, /status: 'draft'/, "payments loader must default the unsaved record to draft");
  assert.match(payments, /document_number: null/, "payments loader must not allocate a document number on open");
  assert.match(payments, /kind,/, "payments loader must fix the kind from the entry surface");
  assert.match(payments, /createMode/, "payments loader must hand the drawer its create mode");
  assert.match(payments, /closeHref/, "payments loader must hand the drawer its list return URL");
});

test("drawers cancel with zero writes and save with one idempotent POST", () => {
  const journal = src(JOURNAL_DRAWER);
  assert.match(
    journal,
    /if \(createMode\) \{\n\s*clearRefusal\(\)\n\s*router\.push\(returnHref as never\)/,
    "journal drawer must cancel to the return URL with zero writes",
  );
  assert.match(journal, /fetchAction\('\/api\/journals', \{\n\s*method: 'POST',/);
  assert.match(journal, /'Idempotency-Key': requestIdRef\.current!/);
  assert.match(journal, /showEvidenceTabs=\{!createMode\}/);

  const payment = src(PAYMENT_DRAWER);
  assert.match(
    payment,
    /if \(createMode\) \{\n\s*clearRefusal\(\)\n\s*router\.push\(returnHref as never\)/,
    "payment drawer must cancel to the return URL with zero writes",
  );
  assert.match(payment, /fetchAction\('\/api\/payments', \{\n\s*method: 'POST',/);
  assert.match(payment, /'Idempotency-Key': requestIdRef\.current!/);
  assert.match(payment, /showEvidenceTabs=\{!createMode\}/);
});

test("create routes serialize on the key and replay only the request-controlled match", () => {
  for (const file of [JOURNALS_ROUTE, PAYMENTS_ROUTE]) {
    const body = src(file);
    assert.match(body, /Idempotency-Key/);
    assert.match(body, /pg_advisory_xact_lock\(hashtextextended/);
    assert.match(body, /claimIdempotentCreate/);
    assert.match(body, /resolveIdempotentReplay/);
    assert.match(body, /on conflict \(id\) do nothing/);
    assert.match(body, /idempotency_key_conflict/);
    assert.match(body, /insert into audit_log/);
    assert.match(body, /request_id/);
    // The scoped claim lives in the shared helper — no inline by-id
    // documents read that could cross the tenant boundary.
    assert.doesNotMatch(body, /from documents where id/);
    // The persisted image carries the full snapshot, but replay compares
    // only the request-controlled match: server-derived defaults (date,
    // subsidiary, currency, totals, number) live outside `request`, so a
    // clock or config change under a defaulted field cannot 409 a retry.
    // A null date/subsidiary in the match means "the caller omitted it".
    assert.match(body, /request: match/);
    assert.match(body, /documentDate: body\.documentDate \?\? null/);
  }
  assert.match(src(JOURNALS_ROUTE), /allocateDocumentNumber\(tx, user\.orgId, 'journal', 'JE-'\)/);
  assert.match(src(PAYMENTS_ROUTE), /allocateDocumentNumber\(tx, user\.orgId, kind, NUMBER_PREFIX\[kind\]\)/);
});

test("handoff: draft endpoints stay exactly while the global menu mints drafts", () => {
  // The parent owns the menu. Rewire its three actions to the unsaved hrefs —
  //   /journal?entryNew=1&mode=edit, /payments?paymentNew=1&mode=edit,
  //   /receipts?paymentNew=1&mode=edit —
  // then delete the two draft routes and update this test to assert they are
  // gone. A menu that no longer references drafts with the routes still
  // present fails here on purpose: dead draft-minting endpoints must not
  // linger.
  const menu = src(GLOBAL_MENU);
  const menuMintsDrafts =
    menu.includes("/api/journals/draft") || menu.includes("/api/payments/draft");
  let routesExist = true;
  try {
    src(JOURNALS_DRAFT_ROUTE);
    src(PAYMENTS_DRAFT_ROUTE);
  } catch {
    routesExist = false;
  }
  assert.equal(
    routesExist,
    menuMintsDrafts,
    "draft endpoints and global-menu draft references must appear and disappear together",
  );
});
