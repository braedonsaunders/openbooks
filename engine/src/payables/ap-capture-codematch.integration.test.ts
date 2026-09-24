import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { NormalizedCapture } from "./ap-capture.ts";
import { CaptureMaterializationError, resolveAndValidateCapture, materializeCapture } from "./ap-capture-service.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { cmp } from "../money/money.ts";

/**
 * Single-line purchase-order code matching (mapLines in
 * ap-capture-service.ts).
 *
 * When the purchase order has exactly one line and the capture has exactly
 * one line, a capture line carrying NO product code still binds
 * positionally — that fallback is load-bearing for codeless OCR lines. But
 * a capture line carrying an EXPLICIT code that matches no purchase-order
 * line must refuse with blocking po_line_unmatched, never silently
 * force-bind the wrong line and advance its billed quantity.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  itemX: string;
  poId: string;
  poLineId: string;
  fileId: string;
};

function line(productCode: string | null, quantity = "2.0000") {
  return {
    description: productCode ? `Line for ${productCode}` : "Codeless line",
    productCode,
    quantity,
    unit: "ea",
    unitPrice: "10.0000",
    amount: "20.0000",
    taxAmount: "0.0000",
    confidence: "1.0000",
  };
}

function normalized(invoiceNumber: string, lines: ReturnType<typeof line>[]): NormalizedCapture {
  const subtotal = `${lines.length * 20}.0000`;
  return {
    vendorName: "Acme Vendor",
    vendorTaxId: null,
    invoiceNumber,
    invoiceDate: "2026-07-15",
    dueDate: null,
    purchaseOrderNumber: null,
    currency: "CAD",
    subtotal,
    taxTotal: "0.0000",
    total: subtotal,
    memo: null,
    lines,
  };
}

async function setupSingleLinePo(): Promise<Fixture> {
  const org = await createScratchOrg();
  const itemX = randomUUID();
  const poId = randomUUID();
  const poLineId = randomUUID();
  const folderId = randomUUID();
  const fileId = randomUUID();
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, default_expense_account_id)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${org.accounts.cogs})`);
  await db.execute(sql`
    insert into items (id, org_id, kind, code, name, default_cost, default_rate, expense_account_id,
                       cost_recovery_account_id, income_account_id, is_active, custom)
    values (${itemX}, ${org.orgId}, 'non_inventory', 'X-001', 'Ordered widget', '10.0000', '10.0000',
            ${org.accounts.cogs}, ${org.accounts.adjustment}, ${org.accounts.revenue}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (${poId}, ${org.orgId}, 'purchase_order', 'draft', 'PO-CODE-MATCH',
            ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 100, 0, 100, null)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, custom, extra_dims)
    values (${poLineId}, ${org.orgId}, ${poId}, 1, ${itemX}, ${org.accounts.cogs},
            'PO line for X-001', 10, 'ea', 10, 100, 0, false, 0, 0, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${poId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    insert into folders (id, org_id, name) values (${folderId}, ${org.orgId}, 'AP code match')`);
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${org.orgId}, ${folderId}, 'invoice.pdf', 'application/pdf', 4)`);
  return { org, itemX, poId, poLineId, fileId };
}

async function insertCapture(fx: Fixture, captureId: string, data: NormalizedCapture, status = "needs_review") {
  await db.execute(sql`
    insert into ap_capture_items
      (id, org_id, file_id, status, original_filename, content_hash,
       document_kind, normalized, validation_issues, vendor_candidate_id, purchase_order_id,
       created_by, updated_by)
    values (${captureId}, ${fx.org.orgId}, ${fx.fileId}, ${status}, 'invoice.pdf',
            ${`codematch-${randomUUID().replaceAll("-", "")}`}, 'vendor_bill',
            ${JSON.stringify(data)}::jsonb, '[]'::jsonb, ${fx.org.vendorId}, ${fx.poId},
            null, null)`);
}

async function resolve(fx: Fixture, captureId: string, data: NormalizedCapture) {
  return resolveAndValidateCapture({
    orgId: fx.org.orgId,
    captureItemId: captureId,
    normalized: data,
    confidenceThreshold: "0.9000",
    vendorId: fx.org.vendorId,
    purchaseOrderId: fx.poId,
    documentKind: "vendor_bill",
  });
}

async function billedOf(fx: Fixture): Promise<string> {
  return (await db.execute<{ quantity_billed: string }>(sql`
    select quantity_billed::text as quantity_billed from document_lines where id = ${fx.poLineId}
  `)).rows[0]!.quantity_billed;
}

function assertBilled(actual: string, expected: string, message: string) {
  assert.equal(cmp(actual, expected), 0, `${message} (billed=${actual})`);
}

test("explicit non-matching product code on a single-line PO refuses as blocking", { skip: !DB }, async () => {
  const fx = await setupSingleLinePo();
  try {
    const captureId = randomUUID();
    const data = normalized("CODE-MISMATCH-1", [line("Y-999")]);
    await insertCapture(fx, captureId, data);
    const resolved = await resolve(fx, captureId, data);
    const unmatched = resolved.issues.filter((i) => i.code === "po_line_unmatched");
    assert.equal(unmatched.length, 1, `explicit code Y-999 must not silently match PO line X-001; issues=${JSON.stringify(resolved.issues)}`);
    assert.equal(unmatched[0]!.severity, "blocking");
    assert.equal(unmatched[0]!.lineIndex, 0);
    const mapped = resolved.normalized.lines[0]!;
    assert.equal(mapped.purchaseOrderLineId ?? null, null);
    assert.equal(mapped.itemId ?? null, null);
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("explicit bad code leaves no PO reserve and materialize refuses", { skip: !DB }, async () => {
  const fx = await setupSingleLinePo();
  try {
    const captureId = randomUUID();
    const data = normalized("CODE-MISMATCH-2", [line("Y-999")]);
    await insertCapture(fx, captureId, data);
    const resolved = await resolve(fx, captureId, data);
    assert.ok(resolved.issues.some((i) => i.code === "po_line_unmatched" && i.severity === "blocking"));
    // Persist the refused resolution the way a review save would, then try
    // to bill through it: no PO line may be reserved and no draft may form.
    await db.execute(sql`
      update ap_capture_items set normalized = ${JSON.stringify(resolved.normalized)}::jsonb,
             validation_issues = ${JSON.stringify(resolved.issues)}::jsonb, updated_at = now()
       where id = ${captureId} and org_id = ${fx.org.orgId}`);
    await assert.rejects(
      materializeCapture({ orgId: fx.org.orgId, captureItemId: captureId, actorId: null, allowedSubsidiaryIds: null }),
      (error: unknown) => error instanceof CaptureMaterializationError,
    );
    assertBilled(await billedOf(fx), "0", "the refused line reserves nothing on the PO line");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("correct product code binds, including case/format variants", { skip: !DB }, async () => {
  const fx = await setupSingleLinePo();
  try {
    for (const [invoiceNumber, code] of [["CODE-EXACT-1", "X-001"], ["CODE-CASE-1", "x 001"]] as const) {
      const captureId = randomUUID();
      const data = normalized(invoiceNumber, [line(code)]);
      await insertCapture(fx, captureId, data);
      const resolved = await resolve(fx, captureId, data);
      assert.deepEqual(
        resolved.issues.filter((i) => i.code === "po_line_unmatched"),
        [],
        `code ${code} must bind PO line X-001 without refusal`,
      );
      const mapped = resolved.normalized.lines[0]!;
      assert.equal(mapped.purchaseOrderLineId, fx.poLineId);
      assert.equal(mapped.itemId, fx.itemX);
      assert.equal(mapped.accountId, fx.org.accounts.cogs);
    }
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("codeless single line keeps the legacy positional fallback", { skip: !DB }, async () => {
  const fx = await setupSingleLinePo();
  try {
    const captureId = randomUUID();
    const data = normalized("CODELESS-1", [line(null)]);
    await insertCapture(fx, captureId, data);
    const resolved = await resolve(fx, captureId, data);
    assert.deepEqual(
      resolved.issues.filter((i) => i.code === "po_line_unmatched"),
      [],
      "a codeless single line must keep binding positionally",
    );
    assert.equal(resolved.normalized.lines[0]!.purchaseOrderLineId, fx.poLineId);
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("multi-line capture against a single PO line is unchanged", { skip: !DB }, async () => {
  const fx = await setupSingleLinePo();
  try {
    const captureId = randomUUID();
    const data = normalized("CODE-MULTI-1", [line("Y-999"), line(null)]);
    await insertCapture(fx, captureId, data);
    const resolved = await resolve(fx, captureId, data);
    // The 1:1 fallback never applied here (two capture lines), before or
    // after the fix: both lines stay unbound and both refuse.
    const unmatched = resolved.issues.filter((i) => i.code === "po_line_unmatched");
    assert.equal(unmatched.length, 2);
    assert.ok(unmatched.every((i) => i.severity === "blocking"));
    // Anchor the loop: with no normalized lines every assertion below is
    // vacuous, and "both lines stay unbound" is exactly what is being proven.
    assert.equal(resolved.normalized.lines.length, 2);
    for (const mapped of resolved.normalized.lines) {
      assert.equal(mapped.purchaseOrderLineId ?? null, null);
    }
    assertBilled(await billedOf(fx), "0", "no line of the refused capture reserves PO quantity");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});
