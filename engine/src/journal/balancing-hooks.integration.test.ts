/**
 * Both journal writers call the balancing-leg providers: document posting
 * (applySubsidiaries) and direct posting (postEntry). A registered provider
 * that appends a net-zero leg pair must see the real line set and its legs
 * must land in the same entry. Without the two call sites the legs are
 * missing and both assertions fail.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Money } from "../money/brands.ts";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postEntry } from "./post-entry.ts";
import { clearBalancingLegProviders, registerBalancingLegProvider } from "./balancing-hooks.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const MEMO = "balancing leg probe";

test("document and direct postings both append provider legs", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  const seen: number[] = [];
  registerBalancingLegProvider("probe", async (_runner, ctx, lines) => {
    assert.equal(ctx.orgId, org.orgId);
    seen.push(lines.length);
    const base = lines[0]!;
    const legOf = (accountId: string, amount: string) => ({
      accountId,
      amount: amount as Money,
      subsidiaryId: base.subsidiaryId,
      currency: base.currency,
      txnAmount: amount as Money,
      fxRate: "1",
      extraDims: {},
      memo: MEMO,
    });
    return [legOf(org.accounts.bank, "1.0000"), legOf(org.accounts.cogs, "-1.0000")];
  });
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "admin"));
    const documentId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id,
           document_date, currency, subtotal, tax_total, total, created_by)
        values (${documentId}, ${org.orgId}, 'journal', 'draft', 'JE-LEGS-1',
                ${org.subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${actorId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, subsidiary_id,
           amount, quantity, unit_price, tax_amount, tax_input_amount)
        values
          (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, '10', '1', '10', '0', '10'),
          (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, '-10', '1', '-10', '0', '-10')`);
    });
    await withOrgTransaction(org.orgId, async () => {
      await submitAndReleaseIfUngated("journal", documentId, actorId);
      await postDocument(documentId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
    });
    const direct = await withOrgContext(org.orgId, () => postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `LEGS-${randomUUID().slice(0, 8)}`,
      postingDate: org.date,
      periodId: org.periodId,
      origin: "manual",
      currency: "CAD",
      lines: [
        { accountId: org.accounts.bank, amount: "5" },
        { accountId: org.accounts.cogs, amount: "-5" },
      ],
    }));

    assert.ok(seen.length >= 2 && seen.every((n) => n === 2), `each writer hands the provider its two caller lines: ${seen}`);
    assert.equal(direct.lines.length, 4, "postEntry returns the appended legs with their line numbers");
    const rows = (await withOrgContext(org.orgId, () => db.execute<{ legs: number; total: string }>(sql`
      select count(*) filter (where l.memo = ${MEMO})::int as legs, sum(l.amount)::text as total
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where e.org_id = ${org.orgId} and e.book_id = ${org.bookId}
         and (e.source_document_id = ${documentId} or e.id = ${direct.entryId})`))).rows;
    assert.deepEqual(rows, [{ legs: 4, total: "0.0000" }]);
  } finally {
    clearBalancingLegProviders();
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
