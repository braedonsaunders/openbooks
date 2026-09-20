import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

test("ap-capture actions refuse a 36-hyphen id as not_found before a uuid bind", () => {
  const src = source("actions/route.ts");
  assert.match(src, /import \{ isUuid \}/);
  assert.match(src, /if \(!ids\.every\(isUuid\)\)/);
  assert.match(src, /error: 'not_found'/);
  assert.match(src, /status: 404/);
  assert.match(
    src,
    /\[0-9a-f-\]\{36\}/,
    "the 36-character collector must still name a dash string so it 404s instead of becoming invalid_action",
  );
});
