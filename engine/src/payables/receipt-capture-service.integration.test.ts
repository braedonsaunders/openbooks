import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import {
  claimReceiptRetry,
  confirmReceiptLines,
  discardReceiptCapture,
  extractReceiptCapture,
  listReceiptCaptures,
  ReceiptCaptureRefusal,
  registerReceiptCapture,
  requireEditableReceiptReport,
} from "./receipt-capture-service.ts";

const ENDPOINT = "https://receipts-proof.cognitiveservices.azure.com";
const lookup = async () => ["20.50.100.1"];

function money(amount: number, code: string) {
  return { type: "currency", content: String(amount), confidence: 0.98, valueCurrency: { amount, currencyCode: code } };
}

function receiptPayload(currency: string, merchant = "The Keg Steakhouse #214") {
  return {
    status: "succeeded",
    analyzeResult: {
      pages: [{ pageNumber: 1, width: 8.5, height: 11 }],
      documents: [{
        docType: "receipt.retailMeal",
        confidence: 0.97,
        fields: {
          MerchantName: { type: "string", valueString: merchant, content: merchant, confidence: 0.97 },
          TransactionDate: { type: "date", valueDate: "2026-10-03", content: "Oct 3, 2026", confidence: 0.96 },
          Subtotal: money(84.5, currency),
          TotalTax: money(10.99, currency),
          Tip: money(15, currency),
          Total: money(110.49, currency),
        },
      }],
    },
  };
}

function providerFetch(payload: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(null, { status: 202, headers: { "operation-location": `${ENDPOINT}/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/1` } });
    }
    assert.ok(String(input).startsWith(ENDPOINT), "polling stays on the provider host");
    return Response.json(payload);
  }) as typeof fetch;
}

type Fixture = {
  org: ScratchOrg;
  actorId: string;
  employeeId: string;
  vendorId: string;
  mealsAccountId: string;
  reportA: string;
  reportB: string;
};

async function setup(options: { configure?: boolean } = {}): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Receipt reviewer", "receipt_reviewer");
  const employeeId = randomUUID();
  const vendorId = randomUUID();
  const mealsAccountId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'employee', 'Riley Fieldworker', true, '{}'::jsonb),
           (${vendorId}, ${org.orgId}, 'company', 'The Keg Steakhouse #214', true, '{}'::jsonb)`);
  await db.execute(sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`);
  await db.execute(sql`insert into vendor_roles (id, org_id, party_id, is_active) values (${randomUUID()}, ${org.orgId}, ${vendorId}, true)`);
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${mealsAccountId}, ${org.orgId}, '6150', 'Meals', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const reportA = randomUUID();
  const reportB = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${reportA}, ${org.orgId}, 'expense_report', 'draft', 'EXP-RCPT-A', ${org.date}, ${employeeId}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb),
           (${reportB}, ${org.orgId}, 'expense_report', 'draft', 'EXP-RCPT-B', ${org.date}, ${employeeId}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`);
  if (options.configure !== false) {
    await db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
        'ai', coalesce(settings->'ai', '{}'::jsonb) || ${JSON.stringify({
          enabled: true,
          documentCapture: {
            enabled: true,
            endpoint: ENDPOINT,
            confidenceThreshold: "0.8000",
            keyEncrypted: sealSecret("receipt-proof-key", { orgId: org.orgId, purpose: "payables.ap-capture.key" }),
          },
        })}::jsonb)
       where id = ${org.orgId}`);
  }
  return { org, actorId, employeeId, vendorId, mealsAccountId, reportA, reportB };
}

async function teardown(fixture: Fixture) {
  const orgId = fixture.org.orgId;
  await db.execute(sql`delete from expense_receipt_captures where org_id = ${orgId}`);
  await db.execute(sql`delete from employee_roles where org_id = ${orgId}`);
  await db.execute(sql`update users set is_active = false where org_id = ${orgId}`);
  await db.execute(sql`delete from role_assignments where org_id = ${orgId}`);
  await db.execute(sql`delete from users where org_id = ${orgId}`);
  await db.execute(sql`delete from app_roles where org_id = ${orgId}`);
  await dropScratchOrg(orgId);
}

/** Store a receipt file and register its capture on a report, returning the capture and attempt. */
async function scan(fixture: Fixture, documentId: string, bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])) {
  const folderId = randomUUID();
  const fileId = randomUUID();
  const versionId = randomUUID();
  const orgId = fixture.org.orgId;
  await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${orgId}, ${`Receipts ${folderId.slice(0, 8)}`})`);
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${orgId}, ${folderId}, 'receipt.jpg', 'image/jpeg', ${bytes.length})`);
  await db.execute(sql`
    insert into file_versions (id, file_id, version_number, size_bytes, content_type)
    values (${versionId}, ${fileId}, 1, ${bytes.length}, 'image/jpeg')`);
  await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${bytes})`);
  await db.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${orgId}`);
  return registerReceiptCapture(db, {
    orgId,
    documentId,
    fileId,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    originalFilename: "receipt.jpg",
    actorId: fixture.actorId,
  });
}

async function captureView(fixture: Fixture, documentId: string, captureId: string) {
  const view = (await listReceiptCaptures(fixture.org.orgId, documentId)).find((entry) => entry.id === captureId);
  assert.ok(view, "the capture is listed on its report");
  return view;
}

test("extraction drafts a reviewed line, matches the vendor, suggests the employee's last category and warns on duplicates", async () => {
  const fixture = await setup();
  try {
    // Report A carries an earlier confirmed receipt from the same merchant.
    const earlier = await scan(fixture, fixture.reportA);
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: earlier.id, attempt: earlier.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    await confirmReceiptLines(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportA,
      reportCurrency: "CAD",
      actorId: fixture.actorId,
      lines: [{ accountId: fixture.mealsAccountId, amount: "99.5000", taxAmount: "10.9900" }],
      confirmations: [{ captureId: earlier.id, lineIndex: 0, transactionDate: "2026-10-03", merchantName: "The Keg Steakhouse", merchantPartyId: null }],
    });

    // The same photo scanned again on report B.
    const again = await scan(fixture, fixture.reportB);
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: again.id, attempt: again.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    const view = await captureView(fixture, fixture.reportB, again.id);
    assert.equal(view.status, "extracted");
    assert.equal(view.draft?.total.value, "110.4900");
    assert.equal(view.draft?.transactionDate.value, "2026-10-03");
    assert.equal(view.draft?.merchantPartyId, fixture.vendorId);
    assert.equal(view.merchantPartyName, "The Keg Steakhouse #214");
    assert.deepEqual(view.draft?.suggestedAccount, { accountId: fixture.mealsAccountId, source: "employee_history" });
    const duplicates = view.issues.filter((issue) => issue.code === "possible_duplicate");
    assert.deepEqual(duplicates.map((issue) => [issue.cause, issue.detail, issue.severity]), [
      ["same_file", "EXP-RCPT-A", "warning"],
    ]);
  } finally {
    await teardown(fixture);
  }
});

test("a different photo of the same receipt warns by merchant, date and total", async () => {
  const fixture = await setup();
  try {
    const first = await scan(fixture, fixture.reportA, Buffer.from([0xff, 0xd8, 0xff, 1]));
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: first.id, attempt: first.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    const second = await scan(fixture, fixture.reportB, Buffer.from([0xff, 0xd8, 0xff, 2]));
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: second.id, attempt: second.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD", "THE KEG STEAKHOUSE #9")), lookup });
    const view = await captureView(fixture, fixture.reportB, second.id);
    assert.deepEqual(view.issues.filter((issue) => issue.code === "possible_duplicate").map((issue) => issue.cause), ["same_receipt"]);
    // A discarded capture no longer counts.
    await discardReceiptCapture(db, { orgId: fixture.org.orgId, documentId: fixture.reportA, captureId: first.id, actorId: fixture.actorId });
    const audit = (await db.execute<{ changes: { after: { status: string } } }>(sql`
      select changes from audit_log where org_id = ${fixture.org.orgId} and table_name = 'expense_receipt_captures' and row_id = ${first.id}`)).rows;
    assert.equal(audit.at(-1)?.changes.after.status, "discarded");
  } finally {
    await teardown(fixture);
  }
});

test("confirmation records the saved line and refuses foreign-currency, repeated and other-report receipts", async () => {
  const fixture = await setup();
  try {
    const usd = await scan(fixture, fixture.reportB, Buffer.from([0xff, 0xd8, 0xff, 7]));
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: usd.id, attempt: usd.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("USD")), lookup });
    const usdView = await captureView(fixture, fixture.reportB, usd.id);
    assert.equal(usdView.draft?.total.value, null, "a foreign-currency receipt drafts no amount");
    assert.ok(usdView.issues.some((issue) => issue.code === "currency_mismatch" && issue.severity === "blocking"));
    const line = { accountId: fixture.mealsAccountId, amount: "99.5000", taxAmount: "10.9900" };
    const confirmation = { lineIndex: 0, transactionDate: "2026-10-03", merchantName: "The Keg", merchantPartyId: null };
    await assert.rejects(
      confirmReceiptLines(db, { orgId: fixture.org.orgId, documentId: fixture.reportB, reportCurrency: "CAD", actorId: fixture.actorId, lines: [line], confirmations: [{ captureId: usd.id, ...confirmation }] }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 422 && error.code === "currency_mismatch",
    );

    const cad = await scan(fixture, fixture.reportB, Buffer.from([0xff, 0xd8, 0xff, 8]));
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: cad.id, attempt: cad.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    await assert.rejects(
      confirmReceiptLines(db, { orgId: fixture.org.orgId, documentId: fixture.reportA, reportCurrency: "CAD", actorId: fixture.actorId, lines: [line], confirmations: [{ captureId: cad.id, ...confirmation }] }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "a receipt confirms lines only on its own report",
    );
    await assert.rejects(
      confirmReceiptLines(db, { orgId: fixture.org.orgId, documentId: fixture.reportB, reportCurrency: "CAD", actorId: fixture.actorId, lines: [line], confirmations: [{ captureId: cad.id, ...confirmation }, { captureId: cad.id, ...confirmation, lineIndex: 0 }] }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.code === "receipt_repeated",
    );
    await assert.rejects(
      confirmReceiptLines(db, { orgId: fixture.org.orgId, documentId: fixture.reportB, reportCurrency: "CAD", actorId: fixture.actorId, lines: [line], confirmations: [{ captureId: cad.id, ...confirmation, transactionDate: "2026-02-30" }] }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.code === "invalid_transaction_date",
    );

    await confirmReceiptLines(db, { orgId: fixture.org.orgId, documentId: fixture.reportB, reportCurrency: "CAD", actorId: fixture.actorId, lines: [line], confirmations: [{ captureId: cad.id, ...confirmation, merchantPartyId: fixture.vendorId }] });
    const confirmed = await captureView(fixture, fixture.reportB, cad.id);
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(
      { ...confirmed.confirmed, at: undefined },
      { lineNumber: 1, accountId: fixture.mealsAccountId, amount: "99.5000", taxAmount: "10.9900", merchantName: "The Keg", transactionDate: "2026-10-03", at: undefined },
    );
    const row = (await db.execute<{ total: string; merchant_key: string; merchant_party_id: string; confirmed_by: string }>(sql`
      select total::text, merchant_key, merchant_party_id, confirmed_by from expense_receipt_captures where id = ${cad.id}`)).rows[0]!;
    assert.deepEqual(row, { total: "110.4900", merchant_key: "thekeg", merchant_party_id: fixture.vendorId, confirmed_by: fixture.actorId });
    await assert.rejects(
      confirmReceiptLines(db, { orgId: fixture.org.orgId, documentId: fixture.reportB, reportCurrency: "CAD", actorId: fixture.actorId, lines: [line], confirmations: [{ captureId: cad.id, ...confirmation }] }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 409,
      "a confirmed receipt cannot confirm a second line",
    );
  } finally {
    await teardown(fixture);
  }
});

test("an unconfigured provider records a failure that retry re-runs under a new attempt", async () => {
  const fixture = await setup({ configure: false });
  try {
    const captured = await scan(fixture, fixture.reportA);
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: captured.id, attempt: captured.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    const failed = await captureView(fixture, fixture.reportA, captured.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.lastError ?? "", /not configured under Platform → AI/);

    const attempt = await claimReceiptRetry(db, { orgId: fixture.org.orgId, documentId: fixture.reportA, captureId: captured.id, actorId: fixture.actorId });
    assert.equal(attempt, 2);
    // A superseded attempt never writes.
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: captured.id, attempt: 1, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    assert.equal((await captureView(fixture, fixture.reportA, captured.id)).status, "extracting");
    await assert.rejects(
      claimReceiptRetry(db, { orgId: fixture.org.orgId, documentId: fixture.reportA, captureId: captured.id, actorId: fixture.actorId }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 409,
      "a running extraction is not retried",
    );
  } finally {
    await teardown(fixture);
  }
});

test("receipt operations require an in-scope draft report and stay inside the organization", async () => {
  const fixture = await setup();
  const other = await setup();
  try {
    await db.execute(sql`update documents set status = 'pending_approval' where id = ${fixture.reportA} and org_id = ${fixture.org.orgId}`);
    await assert.rejects(
      requireEditableReceiptReport(db, { orgId: fixture.org.orgId, documentId: fixture.reportA, allowedSubsidiaryIds: null }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 422 && error.code === "report_not_draft",
    );
    await assert.rejects(
      requireEditableReceiptReport(db, { orgId: fixture.org.orgId, documentId: fixture.reportB, allowedSubsidiaryIds: new Set([randomUUID()]) }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "a report outside the caller's subsidiaries reads as missing",
    );
    await assert.rejects(
      requireEditableReceiptReport(db, { orgId: other.org.orgId, documentId: fixture.reportB, allowedSubsidiaryIds: null }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "another organization's report reads as missing",
    );
    const captured = await scan(fixture, fixture.reportB);
    await extractReceiptCapture({ orgId: fixture.org.orgId, captureId: captured.id, attempt: captured.attempt, actorId: fixture.actorId, fetchImpl: providerFetch(receiptPayload("CAD")), lookup });
    await assert.rejects(
      discardReceiptCapture(db, { orgId: other.org.orgId, documentId: fixture.reportB, captureId: captured.id, actorId: other.actorId }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
    );
    assert.equal((await listReceiptCaptures(other.org.orgId, fixture.reportB)).length, 0);
  } finally {
    await teardown(other);
    await teardown(fixture);
  }
});
