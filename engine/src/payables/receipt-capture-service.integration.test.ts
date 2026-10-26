import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  claimReceiptRetry,
  confirmReceiptLines,
  discardReceiptCapture,
  extractReceiptCapture,
  listReceiptCaptures,
  ReceiptCaptureRefusal,
  receiptReader,
  registerReceiptCapture,
  requireEditableReceiptReport,
} from "./receipt-capture-service.ts";
import { getDocumentCaptureRuntimeConfig } from "./ap-capture-config.ts";

const ENDPOINT = "https://receipts-proof.cognitiveservices.azure.com";
const AZURE_READER = {
  provider: "azure_document_intelligence",
  model: "prebuilt-receipt",
  apiVersion: "2024-11-30",
};
/** Saved report-currency line facts with no original currency. */
function cadLine(accountId: string, amount: string, taxAmount: string) {
  return {
    accountId,
    amount,
    taxAmount,
    originalCurrency: null,
    originalAmount: null,
    originalTaxAmount: null,
  };
}
const lookup = async () => ["20.50.100.1"];

function money(amount: number, code: string) {
  return {
    type: "currency",
    content: String(amount),
    confidence: 0.98,
    valueCurrency: { amount, currencyCode: code },
  };
}

function receiptPayload(currency: string, merchant = "The Keg Steakhouse #214") {
  return {
    status: "succeeded",
    analyzeResult: {
      pages: [{ pageNumber: 1, width: 8.5, height: 11 }],
      documents: [
        {
          docType: "receipt.retailMeal",
          confidence: 0.97,
          fields: {
            MerchantName: {
              type: "string",
              valueString: merchant,
              content: merchant,
              confidence: 0.97,
            },
            TransactionDate: {
              type: "date",
              valueDate: "2026-10-03",
              content: "Oct 3, 2026",
              confidence: 0.96,
            },
            Subtotal: money(84.5, currency),
            TotalTax: money(10.99, currency),
            Tip: money(15, currency),
            Total: money(110.49, currency),
          },
        },
      ],
    },
  };
}

function providerFetch(payload: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(null, {
        status: 202,
        headers: {
          "operation-location": `${ENDPOINT}/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/1`,
        },
      });
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
  await db.execute(
    sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`,
  );
  await db.execute(
    sql`insert into vendor_roles (id, org_id, party_id, is_active) values (${randomUUID()}, ${org.orgId}, ${vendorId}, true)`,
  );
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
            keyEncrypted: sealSecret("receipt-proof-key", {
              orgId: org.orgId,
              purpose: "payables.ap-capture.key",
            }),
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
async function scan(
  fixture: Fixture,
  documentId: string,
  bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
) {
  return registerScan(fixture, documentId, AZURE_READER, bytes);
}

async function registerScan(
  fixture: Fixture,
  documentId: string,
  reader: { provider: string; model: string; apiVersion: string },
  bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
) {
  const folderId = randomUUID();
  const fileId = randomUUID();
  const versionId = randomUUID();
  const orgId = fixture.org.orgId;
  await db.execute(
    sql`insert into folders (id, org_id, name) values (${folderId}, ${orgId}, ${`Receipts ${folderId.slice(0, 8)}`})`,
  );
  await db.execute(sql`
    insert into files (id, org_id, folder_id, name, content_type, size_bytes)
    values (${fileId}, ${orgId}, ${folderId}, 'receipt.jpg', 'image/jpeg', ${bytes.length})`);
  await db.execute(sql`
    insert into file_versions (id, file_id, version_number, size_bytes, content_type)
    values (${versionId}, ${fileId}, 1, ${bytes.length}, 'image/jpeg')`);
  await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${bytes})`);
  await db.execute(
    sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${orgId}`,
  );
  return registerReceiptCapture(db, {
    orgId,
    documentId,
    fileId,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    originalFilename: "receipt.jpg",
    actorId: fixture.actorId,
    reader,
  });
}

async function captureView(fixture: Fixture, documentId: string, captureId: string) {
  const view = (await listReceiptCaptures(fixture.org.orgId, documentId)).find(
    (entry) => entry.id === captureId,
  );
  assert.ok(view, "the capture is listed on its report");
  return view;
}

test("extraction drafts a reviewed line, matches the vendor, suggests the employee's last category and warns on duplicates", async () => {
  const fixture = await setup();
  try {
    // Report A carries an earlier confirmed receipt from the same merchant.
    const earlier = await scan(fixture, fixture.reportA);
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: earlier.id,
      attempt: earlier.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    await confirmReceiptLines(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportA,
      reportCurrency: "CAD",
      actorId: fixture.actorId,
      lines: [cadLine(fixture.mealsAccountId, "99.5000", "10.9900")],
      confirmations: [
        {
          captureId: earlier.id,
          lineIndex: 0,
          transactionDate: "2026-10-03",
          merchantName: "The Keg Steakhouse",
          merchantPartyId: null,
        },
      ],
    });

    // The same photo scanned again on report B.
    const again = await scan(fixture, fixture.reportB);
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: again.id,
      attempt: again.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    const view = await captureView(fixture, fixture.reportB, again.id);
    assert.equal(view.status, "extracted");
    assert.equal(view.draft?.total.value, "110.4900");
    assert.equal(view.draft?.transactionDate.value, "2026-10-03");
    assert.equal(view.draft?.merchantPartyId, fixture.vendorId);
    assert.equal(view.merchantPartyName, "The Keg Steakhouse #214");
    assert.deepEqual(view.draft?.suggestedAccount, {
      accountId: fixture.mealsAccountId,
      source: "employee_history",
    });
    const duplicates = view.issues.filter((issue) => issue.code === "possible_duplicate");
    assert.deepEqual(
      duplicates.map((issue) => [issue.cause, issue.detail, issue.severity]),
      [["same_file", "EXP-RCPT-A", "warning"]],
    );
  } finally {
    await teardown(fixture);
  }
});

test("a different photo of the same receipt warns by merchant, date and total", async () => {
  const fixture = await setup();
  try {
    const first = await scan(fixture, fixture.reportA, Buffer.from([0xff, 0xd8, 0xff, 1]));
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: first.id,
      attempt: first.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    const second = await scan(fixture, fixture.reportB, Buffer.from([0xff, 0xd8, 0xff, 2]));
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: second.id,
      attempt: second.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD", "THE KEG STEAKHOUSE #9")),
      lookup,
    });
    const view = await captureView(fixture, fixture.reportB, second.id);
    assert.deepEqual(
      view.issues
        .filter((issue) => issue.code === "possible_duplicate")
        .map((issue) => issue.cause),
      ["same_receipt"],
    );
    // A discarded capture no longer counts.
    await discardReceiptCapture(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportA,
      captureId: first.id,
      actorId: fixture.actorId,
    });
    const audit = await db.execute<{ changes: { after: { status: string } } }>(
      sql`
      select changes from audit_log where org_id = ${fixture.org.orgId} and table_name = 'expense_receipt_captures' and row_id = ${first.id}`,
      "objects",
    );
    assert.equal(audit.at(-1)?.changes.after.status, "discarded");
  } finally {
    await teardown(fixture);
  }
});

test("a foreign-currency receipt drafts its own amounts and confirms only a line in its currency", async () => {
  const fixture = await setup();
  try {
    const usd = await scan(fixture, fixture.reportB, Buffer.from([0xff, 0xd8, 0xff, 7]));
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: usd.id,
      attempt: usd.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("USD")),
      lookup,
    });
    const usdView = await captureView(fixture, fixture.reportB, usd.id);
    assert.equal(usdView.draft?.total.value, "110.4900", "the receipt's own total is drafted");
    assert.equal(usdView.draft?.currency.value, "USD");
    assert.equal(usdView.draft?.currencyMatchesReport, false);
    assert.ok(
      usdView.issues.some(
        (issue) => issue.code === "foreign_currency" && issue.severity === "warning",
      ),
    );
    const confirmation = {
      lineIndex: 0,
      transactionDate: "2026-10-03",
      merchantName: "The Keg",
      merchantPartyId: null,
    };
    await assert.rejects(
      confirmReceiptLines(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        reportCurrency: "CAD",
        actorId: fixture.actorId,
        lines: [cadLine(fixture.mealsAccountId, "99.5000", "10.9900")],
        confirmations: [{ captureId: usd.id, ...confirmation }],
      }),
      (error: unknown) =>
        error instanceof ReceiptCaptureRefusal &&
        error.status === 422 &&
        error.code === "currency_mismatch",
      "a USD receipt cannot back a line entered in CAD",
    );
    await assert.rejects(
      confirmReceiptLines(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        reportCurrency: "CAD",
        actorId: fixture.actorId,
        lines: [
          {
            accountId: fixture.mealsAccountId,
            amount: "136.9300",
            taxAmount: "15.1200",
            originalCurrency: "EUR",
            originalAmount: "99.5000",
            originalTaxAmount: "10.9900",
          },
        ],
        confirmations: [{ captureId: usd.id, ...confirmation }],
      }),
      (error: unknown) =>
        error instanceof ReceiptCaptureRefusal && error.code === "currency_mismatch",
      "nor a line in a third currency",
    );
    await confirmReceiptLines(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportB,
      reportCurrency: "CAD",
      actorId: fixture.actorId,
      lines: [
        {
          accountId: fixture.mealsAccountId,
          amount: "136.9300",
          taxAmount: "15.1200",
          originalCurrency: "USD",
          originalAmount: "99.5000",
          originalTaxAmount: "10.9900",
        },
      ],
      confirmations: [{ captureId: usd.id, ...confirmation }],
    });
    const usdRow = (
      await db.execute<{
        currency: string;
        total: string;
        confirmed_amount: string;
        confirmed_tax_amount: string;
      }>(
        sql`
      select currency, total::text, confirmed_amount::text, confirmed_tax_amount::text from expense_receipt_captures where id = ${usd.id}`,
        "objects",
      )
    )[0]!;
    assert.deepEqual(
      usdRow,
      {
        currency: "USD",
        total: "110.4900",
        confirmed_amount: "136.9300",
        confirmed_tax_amount: "15.1200",
      },
      "the receipt keeps its own currency and total; the confirmation records the converted line",
    );
    const line = cadLine(fixture.mealsAccountId, "99.5000", "10.9900");

    const cad = await scan(fixture, fixture.reportB, Buffer.from([0xff, 0xd8, 0xff, 8]));
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: cad.id,
      attempt: cad.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    await assert.rejects(
      confirmReceiptLines(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportA,
        reportCurrency: "CAD",
        actorId: fixture.actorId,
        lines: [line],
        confirmations: [{ captureId: cad.id, ...confirmation }],
      }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "a receipt confirms lines only on its own report",
    );
    await assert.rejects(
      confirmReceiptLines(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        reportCurrency: "CAD",
        actorId: fixture.actorId,
        lines: [line],
        confirmations: [
          { captureId: cad.id, ...confirmation },
          { captureId: cad.id, ...confirmation, lineIndex: 0 },
        ],
      }),
      (error: unknown) =>
        error instanceof ReceiptCaptureRefusal && error.code === "receipt_repeated",
    );
    await assert.rejects(
      confirmReceiptLines(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        reportCurrency: "CAD",
        actorId: fixture.actorId,
        lines: [line],
        confirmations: [{ captureId: cad.id, ...confirmation, transactionDate: "2026-02-30" }],
      }),
      (error: unknown) =>
        error instanceof ReceiptCaptureRefusal && error.code === "invalid_transaction_date",
    );

    await confirmReceiptLines(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportB,
      reportCurrency: "CAD",
      actorId: fixture.actorId,
      lines: [line],
      confirmations: [{ captureId: cad.id, ...confirmation, merchantPartyId: fixture.vendorId }],
    });
    const confirmed = await captureView(fixture, fixture.reportB, cad.id);
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(
      { ...confirmed.confirmed, at: undefined },
      {
        lineNumber: 1,
        accountId: fixture.mealsAccountId,
        amount: "99.5000",
        taxAmount: "10.9900",
        merchantName: "The Keg",
        transactionDate: "2026-10-03",
        at: undefined,
      },
    );
    const row = (
      await db.execute<{
        total: string;
        merchant_key: string;
        merchant_party_id: string;
        confirmed_by: string;
      }>(
        sql`
      select total::text, merchant_key, merchant_party_id, confirmed_by from expense_receipt_captures where id = ${cad.id}`,
        "objects",
      )
    )[0]!;
    assert.deepEqual(row, {
      total: "110.4900",
      merchant_key: "thekeg",
      merchant_party_id: fixture.vendorId,
      confirmed_by: fixture.actorId,
    });
    await assert.rejects(
      confirmReceiptLines(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        reportCurrency: "CAD",
        actorId: fixture.actorId,
        lines: [line],
        confirmations: [{ captureId: cad.id, ...confirmation }],
      }),
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
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: captured.id,
      attempt: captured.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    const failed = await captureView(fixture, fixture.reportA, captured.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.lastError ?? "", /not configured under Platform → AI/);

    const attempt = await claimReceiptRetry(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportA,
      captureId: captured.id,
      actorId: fixture.actorId,
    });
    assert.equal(attempt, 2);
    // A superseded attempt never writes.
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: captured.id,
      attempt: 1,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    assert.equal((await captureView(fixture, fixture.reportA, captured.id)).status, "extracting");
    await assert.rejects(
      claimReceiptRetry(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportA,
        captureId: captured.id,
        actorId: fixture.actorId,
      }),
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
    await db.execute(
      sql`update documents set status = 'pending_approval' where id = ${fixture.reportA} and org_id = ${fixture.org.orgId}`,
    );
    await assert.rejects(
      requireEditableReceiptReport(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportA,
        allowedSubsidiaryIds: null,
      }),
      (error: unknown) =>
        error instanceof ReceiptCaptureRefusal &&
        error.status === 422 &&
        error.code === "report_not_draft",
    );
    await assert.rejects(
      requireEditableReceiptReport(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        allowedSubsidiaryIds: new Set([randomUUID()]),
      }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "a report outside the caller's subsidiaries reads as missing",
    );
    await assert.rejects(
      requireEditableReceiptReport(db, {
        orgId: other.org.orgId,
        documentId: fixture.reportB,
        allowedSubsidiaryIds: null,
      }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "another organization's report reads as missing",
    );
    const captured = await scan(fixture, fixture.reportB);
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: captured.id,
      attempt: captured.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    await assert.rejects(
      discardReceiptCapture(db, {
        orgId: other.org.orgId,
        documentId: fixture.reportB,
        captureId: captured.id,
        actorId: other.actorId,
      }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
    );
    assert.equal((await listReceiptCaptures(other.org.orgId, fixture.reportB)).length, 0);
  } finally {
    await teardown(other);
    await teardown(fixture);
  }
});

test("the organization's AI model reads a receipt when it is the configured capture provider", async () => {
  const fixture = await setup({ configure: false });
  try {
    await db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('ai', ${JSON.stringify(
        {
          enabled: true,
          provider: "anthropic",
          modelSmart: "claude-sonnet-4-6",
          keyEncrypted: sealSecret("sk-ant-receipts", {
            orgId: fixture.org.orgId,
            purpose: "assistant.ai.key",
          }),
          documentCapture: {
            enabled: true,
            provider: "llm_vision",
            model: "",
            confidenceThreshold: "0.8000",
          },
        },
      )}::jsonb)
       where id = ${fixture.org.orgId}`);
    const config = await getDocumentCaptureRuntimeConfig(fixture.org.orgId);
    assert.equal(config?.provider, "llm_vision");
    assert.equal(
      config?.model,
      "claude-sonnet-4-6",
      "the provider's smart model reads when no capture model is set",
    );
    const captured = await registerScan(fixture, fixture.reportA, receiptReader(config!));
    const requests: Array<{ url: string; key: string | null }> = [];
    const anthropic: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
      return Response.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              merchantName: { value: "The Keg Steakhouse #214", confidence: 0.96 },
              transactionDate: { value: "2026-10-03", text: "Oct 3, 2026", confidence: 0.95 },
              currency: { value: "CAD", symbol: "$", confidence: 0.94 },
              subtotal: { value: "84.50", confidence: 0.93 },
              taxTotal: { value: "10.99", confidence: 0.93 },
              tip: { value: "15.00", confidence: 0.9 },
              total: { value: "110.49", confidence: 0.97 },
              taxDetails: [],
              items: [],
            }),
          },
        ],
      });
    };
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: captured.id,
      attempt: captured.attempt,
      actorId: fixture.actorId,
      fetchImpl: anthropic,
      lookup,
    });
    assert.deepEqual(requests, [
      { url: "https://api.anthropic.com/v1/messages", key: "sk-ant-receipts" },
    ]);
    const view = await captureView(fixture, fixture.reportA, captured.id);
    assert.equal(view.status, "extracted");
    assert.equal(view.draft?.total.value, "110.4900");
    assert.equal(view.draft?.merchantPartyId, fixture.vendorId);
    assert.equal(view.overallConfidence, "0.9500");
    const row = (
      await db.execute<{ provider: string; model: string; api_version: string }>(
        sql`
      select provider, model, api_version from expense_receipt_captures where id = ${captured.id}`,
        "objects",
      )
    )[0]!;
    assert.deepEqual(row, {
      provider: "llm_vision",
      model: "claude-sonnet-4-6",
      api_version: "anthropic-messages-2023-06-01",
    });

    // An answer that is not the contract fails the capture; it can be retried.
    const retry = await registerScan(fixture, fixture.reportB, receiptReader(config!));
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: retry.id,
      attempt: retry.attempt,
      actorId: fixture.actorId,
      fetchImpl: async () =>
        Response.json({ content: [{ type: "text", text: "I can't read this receipt." }] }),
      lookup,
    });
    const failed = await captureView(fixture, fixture.reportB, retry.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.lastError ?? "", /did not answer with a receipt reading/);
  } finally {
    await teardown(fixture);
  }
});

test("self-service access reaches only the employee's own reports and hides other reports behind duplicates", async () => {
  const fixture = await setup();
  try {
    const coworker = randomUUID();
    await db.execute(
      sql`insert into parties (id, org_id, kind, display_name, is_active, custom) values (${coworker}, ${fixture.org.orgId}, 'employee', 'Sam Coworker', true, '{}'::jsonb)`,
    );
    await db.execute(
      sql`update documents set party_id = ${coworker} where id = ${fixture.reportA} and org_id = ${fixture.org.orgId}`,
    );
    const own = { scope: "own" as const, partyId: fixture.employeeId };
    await requireEditableReceiptReport(db, {
      orgId: fixture.org.orgId,
      documentId: fixture.reportB,
      allowedSubsidiaryIds: null,
      access: own,
    });
    await assert.rejects(
      requireEditableReceiptReport(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportA,
        allowedSubsidiaryIds: null,
        access: own,
      }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "a coworker's report reads as missing",
    );
    await assert.rejects(
      requireEditableReceiptReport(db, {
        orgId: fixture.org.orgId,
        documentId: fixture.reportB,
        allowedSubsidiaryIds: null,
        access: { scope: "own", partyId: null },
      }),
      (error: unknown) => error instanceof ReceiptCaptureRefusal && error.status === 404,
      "a login linked to no person has no reports",
    );

    // The same receipt on the coworker's report warns the employee without naming it.
    const theirs = await scan(fixture, fixture.reportA);
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: theirs.id,
      attempt: theirs.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    const mine = await scan(fixture, fixture.reportB);
    await extractReceiptCapture({
      orgId: fixture.org.orgId,
      captureId: mine.id,
      attempt: mine.attempt,
      actorId: fixture.actorId,
      fetchImpl: providerFetch(receiptPayload("CAD")),
      lookup,
    });
    const reviewer = (await listReceiptCaptures(fixture.org.orgId, fixture.reportB)).find(
      (view) => view.id === mine.id,
    )!;
    assert.equal(
      reviewer.issues.find((issue) => issue.code === "possible_duplicate")?.detail,
      "EXP-RCPT-A",
      "an org-wide reviewer sees which report",
    );
    const employee = (
      await listReceiptCaptures(fixture.org.orgId, fixture.reportB, new Date(), own)
    ).find((view) => view.id === mine.id)!;
    const hidden = employee.issues.find((issue) => issue.code === "possible_duplicate")!;
    assert.equal(hidden.detail, undefined);
    assert.equal(hidden.severity, "warning");
    assert.match(hidden.message ?? "", /another employee's expense report/);
    assert.ok(
      !JSON.stringify(employee).includes("EXP-RCPT-A"),
      "the coworker's report number never reaches the employee",
    );
  } finally {
    await teardown(fixture);
  }
});
