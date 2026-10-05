import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import {
  readProviderTransactionsForDocument,
  retryProviderTransaction,
  runTaxProviderCommitScanForOrg,
} from "./provider-commit.ts";

// Posting a sales document commits its transaction to the configured tax
// provider (AvaTax returns and filing cannot be fed from quotes alone).
// The post enqueues a tracking row in its own transaction; the periodic
// scan commits it with retries, voids it on document void, and records any
// provider/posted tax difference instead of adjusting the books.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

interface FakeAvalara {
  server: Server;
  baseUrl: string;
  creates: { code: string; type: string }[];
  voids: string[];
  /** Total tax the fake commits with; null fails every commit with a 500. */
  totalTax: string | null;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
  });
}

async function startFakeAvalara(): Promise<FakeAvalara> {
  const fake: FakeAvalara = {
    server: createServer(() => {}),
    baseUrl: "",
    creates: [],
    voids: [],
    totalTax: "10.0000",
    close: async () => {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    },
  };
  fake.server.on("request", async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/api/v2/transactions/create") {
      const body = (await readBody(req)) as { code?: string; type?: string };
      fake.creates.push({ code: String(body.code), type: String(body.type) });
      if (fake.totalTax == null) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fake outage" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: body.code, committed: true, totalTax: Number(fake.totalTax) }));
      return;
    }
    const voidMatch = url.match(/^\/api\/v2\/companies\/[^/]+\/transactions\/([^/]+)\/void$/);
    if (req.method === "POST" && voidMatch) {
      await readBody(req);
      fake.voids.push(decodeURIComponent(voidMatch[1]!));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  fake.baseUrl = await new Promise<string>((resolve) => {
    fake.server.listen(0, "127.0.0.1", () => {
      const address = fake.server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
  return fake;
}

async function seedProviderConfig(org: Org, actorId: string, baseUrl: string): Promise<void> {
  const secrets = sealJson({ accountId: "fake-account", licenseKey: "fake-key" }, { orgId: org.orgId, purpose: "tax.provider.secrets" });
  await db.execute(sql`
    insert into tax_rate_provider_configs
      (org_id, provider, display_name, is_enabled, prefer_provider, settings, secrets, created_by, updated_by)
    values (${org.orgId}, 'avalara', 'Fake AvaTax', true, false,
            ${JSON.stringify({ companyCode: "DEFAULT", baseUrl, commitTransactions: true })}::jsonb,
            ${secrets}, ${actorId}, ${actorId})`);
}

async function seedTaxCode(org: Org, actorId: string): Promise<string> {
  const codeId = randomUUID();
  await db.execute(sql`
    insert into tax_codes
      (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active, created_by, updated_by)
    values (${codeId}, ${org.orgId}, 'SALES-10', 'Sales 10%', 'sales', 'standard',
            ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${codeId}, '10.0000', '2020-01-01', ${actorId}, ${actorId})`);
  return codeId;
}

/** Approved invoice: one merchant line, tax evidence written inline. */
async function seedInvoice(org: Org, actorId: string, number: string, codeId: string): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total,
         created_by, updated_by)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${number}, ${org.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
              '100.0000', '10.0000', '110.0000', ${actorId}, ${actorId})`);
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price, created_by, updated_by)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '100.0000',
              '100.0000', '10.0000', ${codeId}, '1', '100.0000', ${actorId}, ${actorId})`);
    await tx.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden, created_by, updated_by)
      values (${org.orgId}, ${lineId}, ${codeId}, 1, '10.0000', '100.0000',
              '10.0000', '0.0000', '10.0000', 'standard', false, false, 2,
              ${org.accounts.taxOutput}, null, null, false, ${actorId}, ${actorId})`);
    await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  return documentId;
}

const CONTROL = (org: Org) => ({ ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank });
const SCAN_OPTIONS = { allowPrivateEndpoints: true } as const;

async function commitRow(org: Org, documentId: string) {
  const rows = await readProviderTransactionsForDocument(org.orgId, documentId);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test("post enqueues the commit and the scan commits it exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const fake = await startFakeAvalara();
  try {
    const actorId = await createScratchUser(org.orgId, "Commit Controller", "admin");
    await seedProviderConfig(org, actorId, fake.baseUrl);
    const codeId = await seedTaxCode(org, actorId);
    const documentId = await seedInvoice(org, actorId, "INV-COMMIT-1", codeId);
    await postDocument(documentId, { control: CONTROL(org) });

    let row = await commitRow(org, documentId);
    assert.equal(row.status, "pending");
    assert.equal(row.kind, "sale");
    assert.ok(row.providerCode.includes("INV-COMMIT-1"));

    const result = await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    assert.equal(result.committed, 1);
    assert.deepEqual(result.orgErrors, []);
    assert.equal(fake.creates.length, 1);
    assert.equal(fake.creates[0]!.type, "SalesInvoice");

    row = await commitRow(org, documentId);
    assert.equal(row.status, "committed");
    assert.ok(row.committedAt);
    assert.equal((row.providerResponseExcerpt as { mismatch?: string }).mismatch, "0.0000");

    // A second scan performs no second provider call: one commit per row.
    const again = await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    assert.equal(again.committed, 0);
    assert.equal(fake.creates.length, 1);
  } finally {
    await fake.close();
    await dropScratchOrg(org.orgId);
  }
});

test("a 500 retries with backoff and a terminal failure retries on demand", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const fake = await startFakeAvalara();
  try {
    const actorId = await createScratchUser(org.orgId, "Commit Retrier", "admin");
    await seedProviderConfig(org, actorId, fake.baseUrl);
    const codeId = await seedTaxCode(org, actorId);
    const documentId = await seedInvoice(org, actorId, "INV-COMMIT-2", codeId);
    await postDocument(documentId, { control: CONTROL(org) });

    fake.totalTax = null;
    await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    let row = await commitRow(org, documentId);
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.match(row.lastError ?? "", /Avalara 500/);

    // Force the attempt ceiling to prove the terminal state is visible.
    await db.execute(sql`
      update tax_provider_transactions set attempts = 99, next_attempt_at = now()
       where id = ${row.id} and org_id = ${org.orgId}`);
    await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    row = await commitRow(org, documentId);
    assert.equal(row.status, "failed");
    assert.match(row.lastError ?? "", /Avalara 500/);

    // The operator fixes the provider and retries: the row re-arms and commits.
    fake.totalTax = "10.0000";
    await retryProviderTransaction(org.orgId, row.id, actorId);
    row = await commitRow(org, documentId);
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    row = await commitRow(org, documentId);
    assert.equal(row.status, "committed");
  } finally {
    await fake.close();
    await dropScratchOrg(org.orgId);
  }
});

test("void after commit voids the provider transaction", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const fake = await startFakeAvalara();
  try {
    const actorId = await createScratchUser(org.orgId, "Commit Voider", "admin");
    await seedProviderConfig(org, actorId, fake.baseUrl);
    const codeId = await seedTaxCode(org, actorId);
    const documentId = await seedInvoice(org, actorId, "INV-COMMIT-3", codeId);
    await postDocument(documentId, { control: CONTROL(org) });
    await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    let row = await commitRow(org, documentId);
    assert.equal(row.status, "committed");

    await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Customer order cancelled before fulfilment",
      reversalDate: org.date,
      source: "api",
    });
    row = await commitRow(org, documentId);
    assert.ok(row.voidRequestedAt);

    await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    row = await commitRow(org, documentId);
    assert.equal(row.status, "voided");
    assert.deepEqual(fake.voids, [row.providerCode]);
  } finally {
    await fake.close();
    await dropScratchOrg(org.orgId);
  }
});

test("a provider total that disagrees with posted tax is recorded, never adjusted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const fake = await startFakeAvalara();
  try {
    const actorId = await createScratchUser(org.orgId, "Commit Auditor", "admin");
    await seedProviderConfig(org, actorId, fake.baseUrl);
    const codeId = await seedTaxCode(org, actorId);
    const documentId = await seedInvoice(org, actorId, "INV-COMMIT-4", codeId);
    await postDocument(documentId, { control: CONTROL(org) });

    // The provider prices the same lines a cent higher than the ledger.
    fake.totalTax = "10.0100";
    await runTaxProviderCommitScanForOrg(org.orgId, SCAN_OPTIONS);
    const row = await commitRow(org, documentId);
    assert.equal(row.status, "committed");
    const excerpt = row.providerResponseExcerpt as {
      postedTax?: string;
      merchantTax?: string;
      providerTax?: string;
      mismatch?: string;
    };
    assert.equal(excerpt.postedTax, "10.0000");
    assert.equal(excerpt.merchantTax, "10.0000");
    assert.equal(excerpt.providerTax, "10.0100");
    assert.equal(excerpt.mismatch, "10.0100");

    // The books stand: the liability is the posted ten, not the provider's.
    const liability = (await db.execute<{ total: string }>(sql`
      select sum(amount)::text as total from journal_lines
       where org_id = ${org.orgId} and tax_code_id = ${codeId}`)).rows[0]?.total;
    assert.equal(liability, "-10.0000");
  } finally {
    await fake.close();
    await dropScratchOrg(org.orgId);
  }
});
