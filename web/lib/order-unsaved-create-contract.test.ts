import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Unsaved-create contract for shared Orders (Estimates, Sales Orders,
// Purchase Orders): every first-party New/redirect for the three kinds opens
// a URL-only createMode drawer over an in-memory payload. Cancel/close
// writes nothing; the first explicit Save creates status=draft through the
// tenant-scoped validated audited collection POST with a required
// Idempotency-Key (exact replay 200, changed/cross-org reuse 409), and the
// document number allocates only inside that save transaction.
//
// web/components/global-create-menu.tsx is OUT of this slice (parent-owned):
// it still mints drafts through the three legacy draft endpoints (exact
// direct hrefs asserted at the bottom), so those routes stay for backward
// compatibility. No other first-party UI caller may invoke them.

const ROOT = process.cwd();

function src(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

const BUTTON = "web/app/(app)/_order/NewOrderButton.tsx";
const REDIRECT = "web/app/(app)/_order/NewOrderRedirect.tsx";
const DRAWER = "web/app/(app)/_order/OrderDrawer.tsx";
const CREATE_ROUTE = "web/app/api/_order/create.ts";
const ESTIMATES_VIEW = "web/app/(app)/estimates/view.ts";
const SALES_VIEW = "web/app/(app)/sales-orders/view.ts";
const PURCHASE_VIEW = "web/app/(app)/purchase-orders/view.ts";

test("New button opens URL-only createMode with zero writes", () => {
  const button = src(BUTTON);
  // The createParam branch navigates to ?<createParam>=1 …
  assert.match(button, /\[createParam!\]: '1'/);
  assert.match(button, /mergeHref\(base, current/);
  // … and the createParam branch performs no fetch of its own: the only
  // draft POST left is the legacy field-tickets branch (documented in the
  // component header).
  assert.match(button, /\[createParam!\]: '1'/);
  const fetches = button.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 1);
  assert.match(button, /fetch\(`\$\{apiPath\}\/draft`/);
});

test("redirect swaps ?<param>=new to createMode with zero writes", () => {
  const redirect = src(REDIRECT);
  assert.match(redirect, /\[createParam\]: '1'/);
  assert.match(redirect, /router\.replace\(\s*mergeHref/s);
  assert.doesNotMatch(redirect, /fetch\(/);
  assert.doesNotMatch(redirect, /\/draft/);
  // A missing createParam must refuse to navigate, never silently trade
  // ?<param>=new for a markerless URL.
  assert.match(redirect, /if \(!createParam\)/);
});

test("OrderDrawer persists createMode through one idempotent collection POST", () => {
  const drawer = src(DRAWER);
  assert.match(drawer, /createMode\?: boolean/);
  // Save posts the in-memory payload to the COLLECTION (no id segment, no
  // /draft) carrying a stable per-drawer Idempotency-Key …
  assert.match(drawer, /method: 'POST'/);
  assert.match(drawer, /'Idempotency-Key': createKey\(\)/);
  assert.match(drawer, /request: \(\) => fetch\(apiBase, \{/);
  assert.doesNotMatch(drawer, /fetch\(`\$\{apiBase\}\/\$\{doc\.id\}`.*POST/);
  // … then routes to the persisted id in edit mode.
  assert.match(drawer, /router\.push\(`\$\{meta\.base\}\?\$\{meta\.param\}=\$\{id\}&mode=edit`\)/);
  // Cancel/close in createMode navigates away: no reset-to-row, no PATCH,
  // no DELETE — there is no row yet.
  assert.match(drawer, /if \(createMode\) \{\s*\n?.*clearRefusal\(\)\s*\n?.*router\.push\(closeHref \?\? meta\.base\)/);
  // Persisted-record surfaces stay hidden until the row exists.
  assert.match(drawer, /showEvidenceTabs=\{createMode \? false/);
  assert.match(drawer, /detailTabs=\{createMode \? \[\]/);
  assert.match(drawer, /canEditAttachments=\{createMode \? false/);
});

const ORDER_VIEWS = [
  { file: ESTIMATES_VIEW, createParam: "estimateNew", remount: "new-quote" },
  { file: SALES_VIEW, createParam: "orderNew", remount: "new-sales-order" },
  { file: PURCHASE_VIEW, createParam: "orderNew", remount: "new-purchase-order" },
] as const;

for (const { file, createParam, remount } of ORDER_VIEWS) {
  test(`${file}: ?${createParam}=1 opens an in-memory create drawer`, () => {
    const view = src(file);
    assert.match(view, /pickString\(sp\[CREATE_PARAM\]\)/);
    assert.match(view, new RegExp(`const CREATE_PARAM = '${createParam}'`));
    // In-memory payload: draft header, no number, no lines, no links.
    assert.match(view, /status: 'draft'/);
    assert.match(view, /lines: \[\],\s*\n?\s*links: \[\]/);
    assert.match(view, /document_number: null/);
    // Drawer opens editable in createMode over the unsaved payload and
    // closes back to the filter-preserving list href.
    assert.match(view, /createMode: creating \|\| undefined/);
    assert.match(view, new RegExp(`remountKey: creating \\? '${remount}'`));
    assert.match(view, /closeHref: creating\s*\n?\s*\? mergeHref\(BASE, sp/);
    // Every spec wires the createParam through both order widgets.
    assert.match(view, /createParam: CREATE_PARAM/);
  });

  test(`${file}: no UI caller invokes the legacy draft factory`, () => {
    const view = src(file);
    assert.doesNotMatch(view, /estimates\/draft|sales-orders\/draft|purchase-orders\/draft/);
  });
}

test("collection POST pins the idempotency/audit/tenant contract", () => {
  const route = src(CREATE_ROUTE);
  assert.match(route, /headers\.get\('Idempotency-Key'\)/);
  assert.match(route, /if \(!isUuid\(requestId\)\)/);
  // Number allocation lives inside the save transaction, via the one
  // canonical allocator — never on open, never on Cancel.
  assert.match(route, /await allocateDocumentNumber\(tx, user\.orgId, cfg\.kind, cfg\.numberPrefix\)/);
  assert.match(route, /on conflict \(id\) do nothing/);
  assert.match(route, /insert into audit_log/);
  assert.match(route, /action, changes, actor_id, request_id/);
  assert.match(route, /\{ status: replayed \? 200 : 201 \}/);
  assert.match(route, /invalid_idempotency_key.*409|409.*invalid_idempotency_key/s);
  // Creation always yields draft; issue/convert/void stay on [id] routes.
  assert.match(route, /status: 'draft'/);
  assert.doesNotMatch(route, /status,?\s*\n?\s*reason\?: string/);
  // Replay compares only the canonical request-controlled match (derived
  // date/totals/warehouses/number excluded) through the shared guard —
  // never a full-snapshot compare that 409s an identical retry.
  assert.match(route, /claimIdempotentCreate\(tx/);
  assert.match(route, /resolveIdempotentReplay\(tx/);
  assert.doesNotMatch(route, /canonicalJson\(original\) !== canonicalJson\(snapshot\)/);
  // Currency is the org's base or a named refusal — never an invented CAD.
  assert.match(route, /has no base currency configured/);
  assert.doesNotMatch(route, /base_currency \?\? 'CAD'/);
  // References validate same-org active before insert, never by raw FK.
  assert.match(route, /must be an active party of this organization/);
  assert.match(route, /must be an active non-summary account of this organization/);
});

test("collection routes parse the typed order-create boundary", () => {
  for (const file of [
    "web/app/api/estimates/route.ts",
    "web/app/api/sales-orders/route.ts",
    "web/app/api/purchase-orders/route.ts",
  ]) {
    const route = src(file);
    assert.match(route, /parseJsonBody\(req, orderCreateBody\)/);
    assert.doesNotMatch(route, /\/draft/);
  }
  assert.match(src("web/lib/api/json.ts"), /export const orderCreateBody/);
});

test("legacy draft routes remain for backward compatibility", () => {
  for (const route of [
    "web/app/api/estimates/draft/route.ts",
    "web/app/api/sales-orders/draft/route.ts",
    "web/app/api/purchase-orders/draft/route.ts",
  ]) {
    assert.ok(existsSync(join(ROOT, route)), `${route} must remain`);
  }
});

test("only the parent-owned global create menu still mints order drafts", () => {
  const menu = src("web/components/global-create-menu.tsx");
  const orderDraftEndpoints = menu.match(/api\/(estimates|sales-orders|purchase-orders)\/draft/g) ?? [];
  // Exact direct hrefs (parent-owned; this slice must not edit that file):
  // /api/estimates/draft → /estimates?estimate=<id>&mode=edit,
  // /api/sales-orders/draft → /sales-orders?order=<id>&mode=edit,
  // /api/purchase-orders/draft → /purchase-orders?order=<id>&mode=edit.
  assert.equal(orderDraftEndpoints.length, 3);
  const callers = [src(BUTTON), src(REDIRECT), src(ESTIMATES_VIEW), src(SALES_VIEW), src(PURCHASE_VIEW)];
  for (const caller of callers) {
    assert.doesNotMatch(caller, /api\/(estimates|sales-orders|purchase-orders)\/draft/);
  }
});
