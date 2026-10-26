import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../lib/auth";

/**
 * Duplicate probe: vendor bills and credits match the same vendor and
 * normalised reference whatever their date or amount; customer invoices
 * match the same party, document date and total. A warning source, never a
 * refusal. Only the session is stubbed; the handler and storage are real.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __duplicatesTestUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__duplicatesTestUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { GET } = await import("./route");

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id,
    orgId,
    name: "tester",
    email: `tester-${id.slice(0, 8)}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: id,
  };
}

async function seedRole(orgId: string, key: string, permissions: string[]): Promise<void> {
  const userId = await withBypassContext(() => createScratchUser(orgId, key, key));
  await withBypassContext(() =>
    db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`),
  );
  state.user = sessionUser(userId, orgId);
}

async function seedDocument(
  orgId: string,
  row: {
    kind: string;
    status: string;
    number: string;
    partyId: string;
    date: string;
    total: string;
    reference?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, party_id,
       currency, subtotal, tax_total, total, reference_number)
    values (${id}, ${orgId}, ${row.kind}, ${row.status}, ${row.number}, ${row.date},
            ${row.partyId}, 'USD', ${row.total}, '0.00', ${row.total}, ${row.reference ?? null})`),
  );
  return id;
}

function probe(query: Record<string, string>): Request {
  return new Request(
    `http://openbooks.test/api/documents/duplicates?${new URLSearchParams(query).toString()}`,
  );
}

/** A voided document carries its void evidence, per the voided-row check. */
async function seedVoidedDocument(
  orgId: string,
  row: {
    kind: string;
    number: string;
    partyId: string;
    date: string;
    total: string;
    reference?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, party_id,
       currency, subtotal, tax_total, total, voided_at, voided_by, void_reason, reference_number)
    values (${id}, ${orgId}, ${row.kind}, 'voided', ${row.number}, ${row.date},
            ${row.partyId}, 'USD', ${row.total}, '0.00', ${row.total},
            now(), ${row.partyId}, 'entered twice by mistake', ${row.reference ?? null})`),
  );
  return id;
}

test("an invoice triple match names the existing numbers, voided excluded", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await seedRole(org.orgId, "ar_clerk", ["ar.read"]);
    await seedDocument(org.orgId, {
      kind: "customer_invoice",
      status: "approved",
      number: "INV-00001",
      partyId: org.customerId,
      date: "2026-09-17",
      total: "3500.00",
    });
    await seedDocument(org.orgId, {
      kind: "customer_invoice",
      status: "draft",
      number: "INV-00002",
      partyId: org.customerId,
      date: "2026-09-17",
      total: "3500.00",
    });
    await seedVoidedDocument(org.orgId, {
      kind: "customer_invoice",
      number: "INV-00003",
      partyId: org.customerId,
      date: "2026-09-17",
      total: "3500.00",
    });
    await seedDocument(org.orgId, {
      kind: "customer_invoice",
      status: "approved",
      number: "INV-00004",
      partyId: org.customerId,
      date: "2026-09-17",
      total: "100.00",
    });

    const response = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "customer_invoice",
          partyId: org.customerId,
          documentDate: "2026-09-17",
          total: "3500.00",
        }),
      ),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      duplicates: { id: string; documentNumber: string; reason: string }[];
    };
    assert.ok(body.duplicates.every((match) => match.reason === "party_date_total"));
    assert.deepEqual(body.duplicates.map((match) => match.documentNumber).sort(), [
      "INV-00001",
      "INV-00002",
    ]);

    const quiet = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "customer_invoice",
          partyId: org.customerId,
          documentDate: "2026-09-17",
          total: "999.00",
        }),
      ),
    );
    assert.equal(quiet.status, 200);
    assert.deepEqual(((await quiet.json()) as { duplicates: unknown[] }).duplicates, []);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("bills match on the vendor reference", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await seedRole(org.orgId, "ap_clerk", ["ap.read"]);
    await seedDocument(org.orgId, {
      kind: "vendor_bill",
      status: "approved",
      number: "BILL-00001",
      partyId: org.vendorId,
      date: "2026-09-17",
      total: "500.00",
      reference: "V-881",
    });
    await seedDocument(org.orgId, {
      kind: "vendor_bill",
      status: "approved",
      number: "BILL-00002",
      partyId: org.vendorId,
      date: "2026-09-17",
      total: "500.00",
      reference: "V-882",
    });

    const same = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "vendor_bill",
          partyId: org.vendorId,
          documentDate: "2026-09-17",
          total: "500.00",
          referenceNumber: "V-881",
        }),
      ),
    );
    assert.equal(same.status, 200);
    assert.deepEqual(
      ((await same.json()) as { duplicates: { documentNumber: string }[] }).duplicates.map(
        (match) => match.documentNumber,
      ),
      ["BILL-00001"],
    );

    const other = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "vendor_bill",
          partyId: org.vendorId,
          documentDate: "2026-09-17",
          total: "500.00",
          referenceNumber: "V-999",
        }),
      ),
    );
    assert.deepEqual(((await other.json()) as { duplicates: unknown[] }).duplicates, []);

    const blank = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "vendor_bill",
          partyId: org.vendorId,
          documentDate: "2026-09-17",
          total: "500.00",
        }),
      ),
    );
    assert.deepEqual(((await blank.json()) as { duplicates: unknown[] }).duplicates, []);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("other kinds and malformed probes are refused", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await seedRole(org.orgId, "ar_clerk", ["ar.read"]);
    const wrongKind = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "journal",
          partyId: org.customerId,
          documentDate: "2026-09-17",
          total: "1.00",
        }),
      ),
    );
    assert.equal(wrongKind.status, 400);
    // An invoice is matched on date and total, so a probe without them is malformed.
    const partial = await withOrgContext(org.orgId, () =>
      GET(probe({ kind: "customer_invoice", partyId: org.customerId, referenceNumber: "PO-1" })),
    );
    assert.equal(partial.status, 400);
    const missing = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "customer_invoice",
          partyId: org.customerId,
          documentDate: "2026-09-17",
          total: "",
        }),
      ),
    );
    assert.equal(missing.status, 400);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

interface Match {
  id: string;
  documentNumber: string;
  documentDate: string;
  total: string;
  status: string;
  referenceNumber: string | null;
  reason: string;
}

test("a bill re-keyed with another amount or date still matches its vendor invoice number", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const other = await withBypassContext(() => createScratchOrg());
  try {
    await seedRole(org.orgId, "ap_clerk", ["ap.read"]);
    const original = await seedDocument(org.orgId, {
      kind: "vendor_bill",
      status: "approved",
      number: "BILL-00010",
      partyId: org.vendorId,
      date: "2026-08-03",
      total: "1250.00",
      reference: "INV-0042",
    });
    await seedVoidedDocument(org.orgId, {
      kind: "vendor_bill",
      number: "BILL-00011",
      partyId: org.vendorId,
      date: "2026-08-04",
      total: "1250.00",
      reference: "INV-0042",
    });
    // Another organization's bill with the same invoice number is invisible.
    await seedDocument(other.orgId, {
      kind: "vendor_bill",
      status: "approved",
      number: "BILL-00010",
      partyId: other.vendorId,
      date: "2026-08-03",
      total: "1250.00",
      reference: "INV-0042",
    });

    // The live probe while typing: only kind, party and reference.
    const live = await withOrgContext(org.orgId, () =>
      GET(probe({ kind: "vendor_bill", partyId: org.vendorId, referenceNumber: "inv 0042" })),
    );
    assert.equal(live.status, 200);
    const matches = ((await live.json()) as { duplicates: Match[] }).duplicates;
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.id, original);
    assert.equal(matches[0]!.reason, "reference");
    assert.equal(matches[0]!.referenceNumber, "INV-0042");
    assert.equal(matches[0]!.documentDate, "2026-08-03");
    assert.equal(matches[0]!.status, "approved");
    assert.match(matches[0]!.total, /^1250\.00*$/);

    // The confirm-before-save probe with a different date and total.
    const full = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "vendor_bill",
          partyId: org.vendorId,
          documentDate: "2026-09-01",
          total: "1520.00",
          referenceNumber: "#INV0042",
        }),
      ),
    );
    assert.deepEqual(
      ((await full.json()) as { duplicates: Match[] }).duplicates.map((match) => match.id),
      [original],
    );

    // Editing the original never reports itself.
    const editing = await withOrgContext(org.orgId, () =>
      GET(
        probe({
          kind: "vendor_bill",
          partyId: org.vendorId,
          referenceNumber: "INV-0042",
          excludeId: original,
        }),
      ),
    );
    assert.deepEqual(((await editing.json()) as { duplicates: Match[] }).duplicates, []);

    // Another organization's vendor is never reachable, even by its id.
    const foreign = await withOrgContext(org.orgId, () =>
      GET(probe({ kind: "vendor_bill", partyId: other.vendorId, referenceNumber: "INV-0042" })),
    );
    assert.deepEqual(((await foreign.json()) as { duplicates: Match[] }).duplicates, []);

    // Punctuation alone identifies nothing.
    const blank = await withOrgContext(org.orgId, () =>
      GET(probe({ kind: "vendor_bill", partyId: org.vendorId, referenceNumber: "--" })),
    );
    assert.deepEqual(((await blank.json()) as { duplicates: Match[] }).duplicates, []);
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
    await withBypassContext(() => dropScratchOrg(other.orgId));
  }
});

test("vendor credits match their own kind by reference", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await seedRole(org.orgId, "ap_clerk", ["ap.read"]);
    await seedDocument(org.orgId, {
      kind: "vendor_bill",
      status: "approved",
      number: "BILL-00020",
      partyId: org.vendorId,
      date: "2026-08-03",
      total: "300.00",
      reference: "CM-17",
    });
    const credit = await seedDocument(org.orgId, {
      kind: "vendor_credit",
      status: "approved",
      number: "VC-00001",
      partyId: org.vendorId,
      date: "2026-08-10",
      total: "300.00",
      reference: "CM-17",
    });
    const response = await withOrgContext(org.orgId, () =>
      GET(probe({ kind: "vendor_credit", partyId: org.vendorId, referenceNumber: "cm17" })),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      ((await response.json()) as { duplicates: Match[] }).duplicates.map((match) => match.id),
      [credit],
    );
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("international invoice references have identical entry and database duplicate identity", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await seedRole(org.orgId, "ap_clerk", ["ap.read"]);
    const original = await seedDocument(org.orgId, {
      kind: "vendor_bill",
      status: "draft",
      number: "BILL-00051",
      partyId: org.vendorId,
      date: "2026-10-01",
      total: "10.00",
      reference: "发票-１２３",
    });
    const response = await withOrgContext(org.orgId, () =>
      GET(probe({ kind: "vendor_bill", partyId: org.vendorId, referenceNumber: "发票 １２３" })),
    );
    assert.equal(response.status, 200);
    const matches = ((await response.json()) as { duplicates: Match[] }).duplicates;
    assert.deepEqual(
      matches.map((match) => match.id),
      [original],
    );
  } finally {
    state.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
