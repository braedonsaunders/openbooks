/**
 * 0005 scopes vendor bill and vendor credit numbers to their vendor party:
 * documents_org_kind_party_number covers those kinds when a party is set, and
 * documents_org_kind_number keeps every other kind (and a vendor document
 * without a party) unique per organization and kind. Its preflight refuses an
 * install holding rows that either index would reject.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { createScratchOrg, type ScratchOrg } from "@openbooks/engine/testing/fixtures";
import { validateFindingRows } from "../../../scripts/migration-preflight.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const preflightSql = readFileSync(
  new URL("../preflight/0005_vendor_scoped_document_numbers.sql", import.meta.url),
  "utf8",
);

type Executor = Pick<typeof db, "execute">;

async function insertDocument(
  exec: Executor,
  o: ScratchOrg,
  kind: string,
  number: string,
  partyId: string | null,
): Promise<void> {
  await exec.execute(sql`
    insert into documents (org_id, kind, document_number, party_id, document_date, currency, created_by)
    values (${o.orgId}, ${kind}, ${number}, ${partyId}, ${o.date}, 'CAD', ${randomUUID()})`);
}

async function addParty(o: ScratchOrg, kind: "vendor" | "customer"): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${o.orgId}, ${kind}, ${`Second ${kind}`}, true, '{}'::jsonb)`);
  return id;
}

/** The unique index a refused insert names, or null when it was accepted. */
async function refusingIndex(write: () => Promise<void>): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (error) {
    let node: unknown = error;
    while (node && typeof node === "object") {
      const candidate = node as { code?: string; constraint?: string; cause?: unknown };
      if (candidate.code === "23505") return candidate.constraint ?? "unnamed";
      node = candidate.cause;
    }
    throw error;
  }
}

test(
  "vendor bill and credit numbers are unique per vendor; other kinds per organization",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await createScratchOrg();
    const otherVendor = await addParty(o, "vendor");
    const otherCustomer = await addParty(o, "customer");

    await insertDocument(db, o, "vendor_bill", "764", o.vendorId);
    await insertDocument(db, o, "vendor_bill", "764", otherVendor);
    await insertDocument(db, o, "vendor_credit", "764", o.vendorId);
    await insertDocument(db, o, "vendor_bill", "764", null);
    await insertDocument(db, o, "customer_invoice", "INV-764", o.customerId);

    assert.equal(
      await refusingIndex(() => insertDocument(db, o, "vendor_bill", "764", o.vendorId)),
      "documents_org_kind_party_number",
      "the same vendor cannot hold one bill number twice",
    );
    assert.equal(
      await refusingIndex(() => insertDocument(db, o, "vendor_credit", "764", o.vendorId)),
      "documents_org_kind_party_number",
    );
    assert.equal(
      await refusingIndex(() => insertDocument(db, o, "vendor_bill", "764", null)),
      "documents_org_kind_number",
      "vendor bills without a party stay unique among themselves",
    );
    assert.equal(
      await refusingIndex(() => insertDocument(db, o, "customer_invoice", "INV-764", otherCustomer)),
      "documents_org_kind_number",
      "an organization-numbered kind stays unique across parties",
    );

    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents
       where org_id = ${o.orgId} and kind = 'vendor_bill' and document_number = '764'`, "objects");
    assert.equal(rows[0]?.n, 3);
  },
);

test(
  "the preflight is clean on a valid install and names rows either replacement index would reject",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const run = async (exec: Executor) =>
      validateFindingRows(
        "0005_vendor_scoped_document_numbers",
        "0005",
        await exec.execute<Record<string, unknown>>(sql.raw(preflightSql), "objects"),
      );
    assert.deepEqual(await run(db), [], "valid indexes leave nothing to report");

    const o = await createScratchOrg();
    const otherVendor = await addParty(o, "vendor");
    await assert.rejects(
      db.transaction(async (tx) => {
        // An install whose unique indexes are missing can hold duplicates.
        await tx.execute(sql`drop index public.documents_org_kind_party_number`);
        await tx.execute(sql`drop index public.documents_org_kind_number`);
        await insertDocument(tx, o, "vendor_bill", "DUP-V", o.vendorId);
        await insertDocument(tx, o, "vendor_bill", "DUP-V", o.vendorId);
        await insertDocument(tx, o, "vendor_bill", "SHARED", o.vendorId);
        await insertDocument(tx, o, "vendor_bill", "SHARED", otherVendor);
        await insertDocument(tx, o, "customer_invoice", "DUP-C", o.customerId);
        await insertDocument(tx, o, "customer_invoice", "DUP-C", null);

        const findings = (await run(tx)).filter((finding) => finding.subject.includes(o.orgId));
        assert.deepEqual(
          findings.map((finding) => [finding.code, finding.severity, finding.subject]),
          [
            ["0005.duplicate_document_number", "refuse", `org ${o.orgId} customer_invoice number DUP-C`],
            ["0005.duplicate_document_number", "refuse", `org ${o.orgId} vendor_bill number DUP-V for party ${o.vendorId}`],
          ],
          "two vendors sharing a number is not a finding",
        );
        throw new Error("rollback sentinel");
      }),
      /rollback sentinel/,
    );
  },
);
