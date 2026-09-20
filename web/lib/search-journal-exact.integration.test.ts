import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Authz } from "./authz";
import type { SessionUser } from "./auth";

// F-t11-011 residual: exact JE numbers for entries outside the journal-list
// scope (subledger postings like origin='document' linked to a payment, or
// orphaned origin='payroll' with no document link) searched total zero even
// though the dashboard shows them. An exact entry number must always
// resolve its entry — the same bypass the documents legs already have.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { globalSearch } = await import("./search");

const skip = !process.env.OPENBOOKS_DB_URL;
const DATE = "2026-07-15";

async function seed() {
  // Fixture seeding runs under bypass (exactly what the pooled fixture path
  // does): the shared cluster enforces RLS and CI's superuser role hides it.
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    // Posted entries must balance (je_check_posted_balance): draft first,
    // two offsetting lines, then post.
    const balanced = async (entryNumber: string, origin: string, memo: string) => {
      const id = (await db.execute<{ id: string }>(sql`insert into journal_entries
        (org_id, book_id, entry_number, posting_date, period_id, subsidiary_id, origin, status, memo)
        values (${org.orgId}, ${org.bookId}, ${entryNumber}, ${DATE}, ${org.periodId}, ${org.subsidiaryId},
          ${origin}, 'draft', ${memo})
        returning id`)).rows[0]!.id;
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, amount, txn_amount, currency, subsidiary_id, posting_date)
        values (${org.orgId}, ${id}, 1, ${org.accounts.bank}, '100.00', '100.00', 'CAD', ${org.subsidiaryId}, ${DATE}),
               (${org.orgId}, ${id}, 2, ${org.accounts.cogs}, '-100.00', '-100.00', 'CAD', ${org.subsidiaryId}, ${DATE})`);
      await db.execute(sql`update journal_entries set status = 'posted' where id = ${id}`);
      return id;
    };
    await balanced("JE-90000001", "payroll", "orphaned payroll posting");
    await balanced("JE-91772283", "document", "vendor payment posting");
    const entry = (await db.execute<{ id: string }>(sql`select id from journal_entries
      where org_id = ${org.orgId} and entry_number = 'JE-91772283'`)).rows[0]!.id;
    await db.execute(sql`insert into documents
      (org_id, kind, document_number, document_date, currency, subsidiary_id, status, posted_entry_id, posting_period_id)
      values (${org.orgId}, 'vendor_payment', 'VPMT-9000001', ${DATE}, 'CAD', ${org.subsidiaryId},
        'posted', ${entry}, ${org.periodId})`);
    return org;
  });
}

function authzFor(orgId: string): Authz {
  const user: SessionUser = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "searcher@scratch.test",
    name: "Searcher",
    roles: [],
    orgId,
    envKind: "production",
    productionOrgId: orgId,
    homeUserId: "00000000-0000-4000-8000-000000000001",
    homeOrgId: orgId,
    isSuperAdmin: false,
  };
  // gl.read gates the journal/accounts legs; the vendor-payment document leg
  // needs its own module permission, exactly like the SIM admin holds both.
  return { user, permissions: new Set(["gl.read", "payments.read", "ap.pay"]), allowedSubsidiaryIds: null };
}

test("exact JE number resolves an unlinked non-native entry", { skip }, async () => {
  const org = await seed();
  try {
    // Reads run tenant-scoped (the production read path — in prod the
    // request resolver supplies this); bare reads see zero rows on the
    // cluster under deny-by-default RLS.
    const found = await withOrgContext(org.orgId, () => globalSearch(authzFor(org.orgId), "JE-90000001"));
    assert.ok(found.total >= 1, "orphaned payroll entry resolves by exact number");
    assert.equal(found.groups[0]!.hits[0]!.title, "Journal JE-90000001", "exact entry orders first");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("exact JE number resolves a subledger-posted entry first", { skip }, async () => {
  const org = await seed();
  try {
    const found = await withOrgContext(org.orgId, () => globalSearch(authzFor(org.orgId), "JE-91772283"));
    const txn = found.groups.find((group) => group.type === "transaction")!;
    assert.ok(txn, "transaction group present");
    assert.equal(txn.hits[0]!.title, "Journal JE-91772283", "exact entry tops the merged group");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
