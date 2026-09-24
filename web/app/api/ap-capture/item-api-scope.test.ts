import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseBulkActionIds } from "../../../lib/api/bulk-ids.ts";

/**
 * The AP capture inbox hides a capture when its vendor or PO sits outside the
 * caller's subsidiary set (null vendor/PO stay org-wide). Item APIs must apply
 * that same fence by id — a record missing from the list is unreachable here.
 *
 * Bulk actions must refuse a 36-character dash string as not_found before it
 * is bound into a uuid column (the item routes already 404; actions used to
 * return the PostgreSQL cast error inside HTTP 200).
 */

const dir = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(join(dir, relativePath), "utf8");
}

const ITEM_ROUTES = [
  "[id]/route.ts",
  "[id]/file/route.ts",
  "[id]/materialize/route.ts",
  "actions/route.ts",
] as const;

for (const file of ITEM_ROUTES) {
  test(`AP capture item API applies the inbox subsidiary fence: ${file}`, () => {
    const src = source(file);
    assert.match(src, /function apCaptureSubsidiaryScope\(/, `${file} must own the inbox visibility fragment`);
    assert.match(src, /allowed\.size === 0/, `${file} must fail closed on an empty subsidiary set`);
    assert.match(
      src,
      /subsidiaryVisibleFilter\(sql`po\.subsidiary_id`, allowed, \{ orgWideNull: true \}\)/,
      `${file} must reuse the shared PO org-wide-null filter`,
    );
    assert.match(
      src,
      /subsidiaryVisibleFilter\(sql`vendor\.subsidiary_id`, allowed, \{ orgWideNull: true \}\)/,
      `${file} must reuse the shared vendor org-wide-null filter`,
    );
    assert.match(src, /\$\{apCaptureSubsidiaryScope\(/, `${file} must interpolate the fence into its queries`);
    assert.match(
      src,
      /left join parties vendor on vendor\.id = ci\.vendor_candidate_id and vendor\.org_id = ci\.org_id/,
      `${file} must resolve the vendor subsidiary the inbox joins`,
    );
    assert.match(
      src,
      /left join documents po on po\.id = ci\.purchase_order_id and po\.org_id = ci\.org_id/,
      `${file} must resolve the PO subsidiary the inbox joins`,
    );
  });
}

test("PATCH fences the vendor and PO resolveAndValidateCapture will persist, not only the pre-update row", () => {
  const src = source("[id]/route.ts");
  const resolveAt = src.indexOf("const resolved = await resolveAndValidateCapture(");
  assert.ok(resolveAt >= 0, "PATCH must resolve before persisting associations");
  const afterResolve = src.slice(resolveAt);
  assert.match(
    afterResolve,
    /if \(resolved\.vendorId\)[\s\S]*?from parties[\s\S]*?for update[\s\S]*?guardSubsidiaryScope\(gate, vendor\.subsidiaryId, \{ orgWideNull: true \}\)/,
    "auto-resolved vendorId must be locked then gated before UPDATE",
  );
  assert.match(
    afterResolve,
    /if \(resolved\.purchaseOrderId\)[\s\S]*?from documents[\s\S]*?for update[\s\S]*?guardSubsidiaryScope\(gate, purchaseOrder\.subsidiaryId, \{ orgWideNull: true \}\)/,
    "auto-resolved purchaseOrderId must be locked then gated before UPDATE",
  );
  assert.match(
    afterResolve,
    /resolvedAssociationsInScope\(gate\.user\.orgId, gate\.allowedSubsidiaryIds, resolved\.vendorId, resolved\.purchaseOrderId\)/,
    "the UPDATE WHERE must predicate on the resolved ids, not only the pre-update row",
  );
  assert.match(afterResolve, /throw new Error\('capture_not_found'\)/, "out-of-scope resolved associations must be the same 404 as a missing capture");
});

test("materialize routes pass subsidiary scope into the locking engine transaction", () => {
  for (const file of ["[id]/materialize/route.ts", "actions/route.ts"] as const) {
    const src = source(file);
    assert.match(
      src,
      /materializeCapture\(\{[\s\S]*?allowedSubsidiaryIds: gate\.allowedSubsidiaryIds/,
      `${file} must thread the caller's fence into materializeCapture so the check runs after FOR UPDATE`,
    );
  }
  const engine = readFileSync(join(dir, "../../../../engine/src/payables/ap-capture-service.ts"), "utf8");
  const lockAt = engine.indexOf("from ap_capture_items where org_id = ${input.orgId} and id = ${input.captureItemId} for update");
  assert.ok(lockAt >= 0, "materializeCapture must lock the capture row");
  const afterLock = engine.slice(lockAt);
  const checkAt = afterLock.indexOf("assertLockedCaptureAssociationsVisible");
  const documentAt = afterLock.indexOf("if (item.document_id)");
  assert.ok(checkAt >= 0, "materializeCapture must re-check vendor/PO visibility after the capture lock");
  assert.ok(documentAt >= 0 && checkAt < documentAt, "the visibility check must run before a draft is reused or created");
  assert.match(engine, /from parties[\s\S]*for update/);
  assert.match(engine, /from documents[\s\S]*for update/);
});

test("ap-capture malformed-id authz double exports the PATCH subsidiary gate", () => {
  const src = source("route-malformed-id.integration.test.ts");
  assert.match(
    src,
    /export function guardSubsidiaryScope/,
    "the authz mock must export every symbol [id]/route.ts imports or the suite fails to link and reports zero tests",
  );
});

test("ap-capture actions refuse a 36-hyphen id as not_found before a uuid bind", () => {
  // The id parse lives in lib/api/bulk-ids.ts (pure, behaviour-tested in
  // bulk-ids.test.ts); the route only wires it to statuses.
  const src = source("actions/route.ts");
  assert.match(src, /parseBulkActionIds\(parsedBody\.data\)/, "the route must parse ids through the shared bulk parser");
  assert.match(src, /error === 'not_found' \? 404 : 400/, "not_found stays a 404, refusals stay 400");
  // Behavioural, against the real pure parser (never a double): a dash-only
  // id is a named id, so it refuses as not_found — never dropped into
  // invalid_action, never bound into a uuid column.
  assert.deepEqual(
    parseBulkActionIds({ action: "reject", ids: ["------------------------------------"] }),
    { ok: false, error: "not_found" },
  );
});
